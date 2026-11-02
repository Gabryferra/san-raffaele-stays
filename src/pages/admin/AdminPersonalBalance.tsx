import React, { useMemo, useState } from 'react';
import {
  Building2,
  Wallet,
  Receipt,
  Scale,
  User,
  TrendingUp,
  TrendingDown,
  PiggyBank,
  LineChart as LineChartIcon,
  GitCompare,
  CalendarClock,
  Pencil,
  Info,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  AreaChart,
  Area,
  LineChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CHART_TOOLTIP_STYLE,
  FinanceErrorBanner,
  FinanceLoading,
  KpiCard,
  PeriodFilter,
  SectionTitle,
  eur,
  eur2,
  usePeriod,
} from '@/components/admin/finance/finance-ui';
import { useFinanceData } from '@/components/admin/finance/useFinanceData';
import {
  MONTHS_LONG,
  actualOnly,
  addMonths,
  forecastMovements,
  invoicedVatAmount,
  monthEnd,
  monthKey,
  monthLabel,
  monthlyRows,
  monthsBetween,
  summarizeApartments,
  summarizePersonal,
  todayIso,
} from '@/lib/finance-calc';
import { setSetting } from '@/lib/finance-api';
import { isSupabaseConfigured } from '@/lib/supabase';

const BALANCE_KEY = 'current_balance';

export const AdminPersonalBalance: React.FC = () => {
  const { data, error, loading, reload, categoryMap } = useFinanceData();
  const { state: periodState, setState: setPeriodState, period, label: periodLabel } = usePeriod('year');
  const [viewTab, setViewTab] = useState<'overview' | 'forecast' | 'compare'>('overview');
  const [horizon, setHorizon] = useState(6);
  const [estimateApt, setEstimateApt] = useState(true);
  const [editBalance, setEditBalance] = useState(false);
  const [balanceInput, setBalanceInput] = useState('');
  const thisYear = new Date().getFullYear();
  const [yearA, setYearA] = useState(thisYear);
  const [yearB, setYearB] = useState(thisYear - 1);
  const [compareMetric, setCompareMetric] = useState<'net' | 'income' | 'expenses'>('net');

  const movements = useMemo(() => data?.movements ?? [], [data]);
  const actual = useMemo(() => actualOnly(movements), [movements]);
  const apartments = useMemo(() => data?.apartments ?? [], [data]);
  const recurring = useMemo(() => data?.recurring ?? [], [data]);

  const apt = useMemo(
    () => summarizeApartments(movements, categoryMap, 'all', apartments.length, period),
    [movements, categoryMap, apartments.length, period]
  );
  const per = useMemo(() => summarizePersonal(movements, categoryMap, period), [movements, categoryMap, period]);
  const totalIncome = apt.income + per.income;
  const totalExpenses = apt.expenses + per.expenses;
  const totalNet = totalIncome - totalExpenses;

  const perApartment = useMemo(
    () =>
      apartments.map((a) => ({
        apt: a,
        s: summarizeApartments(movements, categoryMap, a.id, apartments.length, period),
      })),
    [apartments, movements, categoryMap, period]
  );

  // ---------------- Andamento ----------------
  const chartMonths = useMemo(() => {
    if (periodState.mode === 'month') {
      const end = monthKey(period.from);
      return monthsBetween(`${addMonths(end, -11)}-01`, period.to);
    }
    return monthsBetween(period.from, period.to);
  }, [periodState.mode, period]);

  const savedBefore = useMemo(() => {
    const start = `${chartMonths[0]}-01`;
    return actual
      .filter((m) => m.movement_date < start && m.direction !== 'transfer')
      .reduce(
        (acc, m) => acc + (m.direction === 'income' ? Number(m.amount) - invoicedVatAmount(m) : -Number(m.amount)),
        0
      );
  }, [actual, chartMonths]);

  const rows = useMemo(
    () => monthlyRows(actual, chartMonths, { startCumulative: savedBefore }),
    [actual, chartMonths, savedBefore]
  );

  // ---------------- Confronto anni ----------------
  const years = useMemo(() => {
    const ys = new Set<number>([thisYear, thisYear - 1]);
    actual.forEach((m) => ys.add(Number(m.movement_date.slice(0, 4))));
    return [...ys].sort((a, b) => b - a);
  }, [actual, thisYear]);

  const compareData = useMemo(() => {
    const ra = monthlyRows(actual, monthsBetween(`${yearA}-01-01`, `${yearA}-12-31`));
    const rb = monthlyRows(actual, monthsBetween(`${yearB}-01-01`, `${yearB}-12-31`));
    return MONTHS_LONG.map((name, i) => ({
      label: name.slice(0, 3),
      [String(yearA)]: ra[i][compareMetric],
      [String(yearB)]: rb[i][compareMetric],
    }));
  }, [actual, yearA, yearB, compareMetric]);

  // ---------------- Previsione ----------------
  const today = todayIso();
  const currentBalance = (data?.settings?.[BALANCE_KEY] as { amount?: number; date?: string } | undefined) ?? undefined;
  const forecastMonths = useMemo(() => monthsBetween(today, monthEnd(addMonths(monthKey(today), horizon - 1))), [today, horizon]);
  const forecast = useMemo(
    () => forecastMovements(recurring, movements, { from: today, to: monthEnd(forecastMonths[forecastMonths.length - 1]) }),
    [recurring, movements, today, forecastMonths]
  );

  // Stima incassi appartamenti: media degli ultimi 3 mesi completi (gli incassi futuri non sono noti)
  const aptIncomeEstimate = useMemo(() => {
    const last = monthKey(addMonths(monthKey(today), -1));
    const months = [addMonths(last, -2), addMonths(last, -1), last];
    const r = monthlyRows(actual, months);
    return r.reduce((acc, x) => acc + x.aptIncome, 0) / 3;
  }, [actual, today]);

  const forecastRows = useMemo(() => {
    const base = monthlyRows(forecast, forecastMonths);
    let liquidity = currentBalance?.amount ?? 0;
    return base.map((r, i) => {
      // mese corrente: stima proporzionale ai giorni rimanenti
      let estimate = 0;
      if (estimateApt) {
        if (i === 0) {
          const [y, m, d] = today.split('-').map(Number);
          const dim = new Date(y, m, 0).getDate();
          estimate = (aptIncomeEstimate * (dim - d)) / dim;
        } else estimate = aptIncomeEstimate;
      }
      const income = r.income + estimate;
      const net = income - r.expenses;
      liquidity += net;
      return { ...r, estimate: Math.round(estimate), income: Math.round(income), net: Math.round(net), liquidity: Math.round(liquidity) };
    });
  }, [forecast, forecastMonths, currentBalance, estimateApt, aptIncomeEstimate, today]);

  const upcoming = useMemo(
    () => forecast.filter((m) => m.direction === 'expense' && m.movement_date <= monthEnd(addMonths(monthKey(today), 1))).slice(0, 12),
    [forecast, today]
  );

  const saveBalance = async () => {
    const amount = Number(balanceInput.replace(',', '.'));
    if (!Number.isFinite(amount)) {
      toast.error('Importo non valido');
      return;
    }
    try {
      await setSetting(BALANCE_KEY, { amount, date: today });
      toast.success('Saldo aggiornato');
      setEditBalance(false);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore');
    }
  };

  if (loading) return <FinanceLoading />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">Bilancio Personale</h1>
          <p className="text-sm text-slate-500 mt-1">
            Visione d’insieme: attività immobiliare e gestione personale, aggiornata in automatico.
          </p>
        </div>
      </div>

      <FinanceErrorBanner message={error} />
      {!isSupabaseConfigured() && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
          Modalità anteprima locale: i dati inseriti restano solo in questo browser e non toccano il database del sito.
        </div>
      )}

      <div className="lg:sticky lg:top-0 z-30 -mx-1 px-1 py-2 bg-slate-50/95 backdrop-blur flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Periodo: <strong className="text-slate-700">{periodLabel}</strong>
        </p>
        <PeriodFilter value={periodState} onChange={setPeriodState} />
      </div>

      {/* 3.1 Riepilogo generale */}
      <section className="space-y-2.5">
        <SectionTitle icon={TrendingUp} title="Entrate" />
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <KpiCard title="Appartamenti" value={apt.income} icon={Building2} tone="blue" hint="Da Contabilità Appartamenti" />
          <KpiCard title="Personali" value={per.income} icon={User} tone="emerald" hint="Da Finanze Personali" />
          <KpiCard title="Totale entrate" value={totalIncome} icon={Wallet} tone="emerald" highlight />
        </div>
        <SectionTitle icon={TrendingDown} title="Uscite" />
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <KpiCard
            title="Appartamenti"
            value={apt.expenses}
            icon={Building2}
            tone="slate"
            hint={apt.vatReserve > 0 ? `Include ${eur.format(apt.vatReserve)} di IVA 20% su fatturato` : 'Da Contabilità Appartamenti'}
          />
          <KpiCard title="Personali" value={per.expenses} icon={User} tone="violet" hint="Da Finanze Personali" />
          <KpiCard
            title="Totale uscite"
            value={totalExpenses}
            icon={Receipt}
            tone="rose"
            highlight
            hint={apt.vatReserve > 0 ? `Include IVA 20% futura (${eur.format(apt.vatReserve)})` : undefined}
          />
        </div>
      </section>

      <Card className="border-primary/30 bg-primary/[0.03] shadow-sm">
        <CardContent className="p-3.5 sm:p-5 space-y-3">
          <div className="grid grid-cols-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 sm:gap-4 text-center">
            <div>
              <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-slate-500">Utile alloggi (netto IVA)</div>
              <div className={`text-base sm:text-xl font-bold ${apt.net < 0 ? 'text-rose-600' : 'text-slate-900'}`}>{eur.format(apt.net)}</div>
              <div className="text-[10px] sm:text-[11px] text-slate-500 hidden sm:block">
                {apt.vatReserve > 0 ? `cassa ${eur.format(apt.cashNetBeforeVat)} − IVA 20% ${eur.format(apt.vatReserve)}` : 'quanto produce l’attività'}
              </div>
            </div>
            <div className="text-lg sm:text-xl text-slate-400 font-bold hidden md:block">+</div>
            <div>
              <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-slate-500">Saldo pers.</div>
              <div className={`text-base sm:text-xl font-bold ${per.balance < 0 ? 'text-rose-600' : 'text-slate-900'}`}>{eur.format(per.balance)}</div>
              <div className="text-[10px] sm:text-[11px] text-slate-500 hidden sm:block">entrate − spese personali</div>
            </div>
            <div className="text-lg sm:text-xl text-slate-400 font-bold hidden md:block">=</div>
            <div>
              <div className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-primary">Saldo netto reale</div>
              <div className={`text-lg sm:text-3xl font-black ${totalNet < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{eur.format(totalNet)}</div>
              <div className="text-[10px] sm:text-[11px] text-slate-500 hidden sm:block">già al netto del 20% IVA futura</div>
            </div>
          </div>
          {apt.vatReserve > 0 && (
            <div className="rounded-lg border border-amber-200/90 bg-amber-50/80 px-3 py-2 text-[11px] sm:text-xs text-amber-950 flex flex-wrap items-center justify-between gap-2">
              <span>
                💡 <strong>Liquidità apparente prima dell’IVA:</strong>{' '}
                <strong>{eur.format(totalNet + apt.vatReserve)}</strong> — di cui{' '}
                <strong className="text-amber-800">{eur.format(apt.vatReserve)}</strong> sono accantonati per l’IVA al 20% sugli incassi fatturati ({eur.format(apt.invoiced)}).
              </span>
              <span className="font-bold text-slate-900">Disponibile reale: {eur.format(totalNet)}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sotto-schede vista: Andamento & Rendimento | Previsione Liquidità | Confronto fra Anni */}
      <Tabs value={viewTab} onValueChange={(v) => setViewTab(v as typeof viewTab)} className="space-y-4 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
          <TabsList className="grid grid-cols-3 w-full sm:w-auto h-auto p-1 bg-slate-100/90 border border-slate-200/80">
            <TabsTrigger value="overview" className="text-[11px] sm:text-xs font-semibold px-2 sm:px-3.5 py-1.5 sm:py-2">
              📊 Andamento
            </TabsTrigger>
            <TabsTrigger value="forecast" className="text-[11px] sm:text-xs font-semibold px-2 sm:px-3.5 py-1.5 sm:py-2">
              🔮 Previsioni
            </TabsTrigger>
            <TabsTrigger value="compare" className="text-[11px] sm:text-xs font-semibold px-2 sm:px-3.5 py-1.5 sm:py-2">
              📅 Confronto
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6 mt-0">
          {/* Quanto rende ogni appartamento */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Scale className="h-4 w-4 text-primary" /> Quanto rende ogni appartamento · {periodLabel}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {perApartment.map(({ apt: a, s }) => (
                <div key={a.id} className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="text-xs font-bold text-slate-700">{a.name}</div>
                  <div className={`text-lg font-bold ${s.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{eur.format(s.net)}</div>
                  <div className="text-[11px] text-slate-500">
                    Incassi {eur.format(s.income)} · Spese {eur.format(s.expenses)}
                  </div>
                </div>
              ))}
              <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
                <div className="text-xs font-bold text-primary">Totale immobili</div>
                <div className={`text-lg font-bold ${apt.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{eur.format(apt.net)}</div>
                <div className="text-[11px] text-slate-500">Redditività (solo interessi mutuo): {eur.format(apt.economicNet)}</div>
              </div>
            </CardContent>
          </Card>

          {/* 3.2 Andamento */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <LineChartIcon className="h-4 w-4 text-primary" /> Entrate, uscite e saldo mensile
                </CardTitle>
                <CardDescription className="text-xs">Dati effettivi</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} />
                      <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => eur.format(v)} />
                      <Tooltip formatter={(v: number) => eur.format(v)} contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: '#f8fafc' }} />
                      <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                      <ReferenceLine y={0} stroke="#cbd5e1" />
                      <Bar dataKey="income" name="Entrate" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={24} />
                      <Bar dataKey="expenses" name="Uscite" fill="#f43f5e" radius={[4, 4, 0, 0]} maxBarSize={24} />
                      <Line type="monotone" dataKey="net" name="Saldo" stroke="#0f172a" strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <PiggyBank className="h-4 w-4 text-primary" /> Risparmio cumulato
                </CardTitle>
                <CardDescription className="text-xs">Somma dei saldi mensili da inizio registrazioni</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="cumFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} />
                      <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => eur.format(v)} />
                      <Tooltip formatter={(v: number) => eur.format(v)} contentStyle={CHART_TOOLTIP_STYLE} />
                      <ReferenceLine y={0} stroke="#cbd5e1" />
                      <Area type="monotone" dataKey="cumulative" name="Risparmio cumulato" stroke="#0ea5e9" strokeWidth={2} fill="url(#cumFill)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="forecast" className="mt-0">
          {/* 3.3 Previsione */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3 flex flex-col md:flex-row md:items-start justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-primary" /> Previsione delle uscite e liquidità
                </CardTitle>
                <CardDescription className="text-xs max-w-xl">
                  Basata su spese/entrate ricorrenti, spese annuali conosciute e movimenti inseriti come “previsti”. Sono stime,
                  tenute separate dai dati effettivi.
                </CardDescription>
              </div>
              <Select value={String(horizon)} onValueChange={(v) => setHorizon(Number(v))}>
                <SelectTrigger className="h-8 w-[130px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">Prossimi 3 mesi</SelectItem>
                  <SelectItem value="6">Prossimi 6 mesi</SelectItem>
                  <SelectItem value="12">Prossimi 12 mesi</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col md:flex-row gap-3">
                <div className="flex-1 p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Liquidità disponibile oggi</div>
                  {editBalance ? (
                    <div className="flex gap-2 mt-1">
                      <Input
                        inputMode="decimal"
                        value={balanceInput}
                        onChange={(e) => setBalanceInput(e.target.value)}
                        className="h-8 text-sm"
                        placeholder="Somma dei tuoi conti"
                        autoFocus
                      />
                      <Button size="sm" className="h-8" onClick={saveBalance}>
                        Salva
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold text-slate-900">
                        {currentBalance?.amount != null ? eur.format(currentBalance.amount) : '—'}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label="Modifica liquidità"
                        onClick={() => {
                          setBalanceInput(currentBalance?.amount != null ? String(currentBalance.amount) : '');
                          setEditBalance(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                  <div className="text-[11px] text-slate-500">
                    {currentBalance?.date
                      ? `Aggiornata il ${currentBalance.date.split('-').reverse().join('/')}`
                      : 'Inseriscila per stimare la liquidità futura'}
                  </div>
                </div>
                <div className="flex-1 p-3 rounded-lg bg-slate-50 border border-slate-100 flex items-start gap-3">
                  <Switch id="est-apt" checked={estimateApt} onCheckedChange={setEstimateApt} className="mt-0.5" />
                  <Label htmlFor="est-apt" className="text-xs font-normal text-slate-600 leading-snug cursor-pointer">
                    <strong className="text-slate-800">Stima incassi appartamenti</strong>: media degli ultimi 3 mesi (
                    {eur.format(aptIncomeEstimate)}/mese). Gli incassi futuri non sono noti in anticipo.
                  </Label>
                </div>
              </div>

              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={forecastRows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} />
                    <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => eur.format(v)} />
                    <Tooltip formatter={(v: number) => eur.format(v)} contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: '#f8fafc' }} />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                    <ReferenceLine y={0} stroke="#cbd5e1" />
                    <Bar dataKey="income" name="Entrate previste" fill="#6ee7b7" radius={[4, 4, 0, 0]} maxBarSize={24} />
                    <Bar dataKey="expenses" name="Uscite previste" fill="#fda4af" radius={[4, 4, 0, 0]} maxBarSize={24} />
                    {currentBalance?.amount != null && (
                      <Line type="monotone" dataKey="liquidity" name="Liquidità stimata" stroke="#0ea5e9" strokeWidth={2.5} dot={{ r: 3 }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="overflow-x-auto">
                  <table className="stack-table w-full text-xs text-left">
                    <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[11px]">
                      <tr>
                        <th className="py-2 px-3">Mese</th>
                        <th className="py-2 px-3 text-right">Entrate</th>
                        <th className="py-2 px-3 text-right">Uscite</th>
                        <th className="py-2 px-3 text-right">Saldo</th>
                        {currentBalance?.amount != null && <th className="py-2 px-3 text-right">Liquidità</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {forecastRows.map((r, i) => (
                        <tr key={r.key}>
                          <td data-label="Mese" className="py-2 px-3 font-semibold text-slate-700">
                            {monthLabel(r.key, true)}
                            {i === 0 && <span className="text-[10px] text-slate-400 font-normal"> (da domani)</span>}
                          </td>
                          <td data-label="Entrate" className="py-2 px-3 text-right">
                            {eur.format(r.income)}
                            {r.estimate > 0 && <span className="block text-[10px] text-slate-400">di cui stima {eur.format(r.estimate)}</span>}
                          </td>
                          <td data-label="Uscite" className="py-2 px-3 text-right text-rose-600">{eur.format(r.expenses)}</td>
                          <td data-label="Saldo" className={`py-2 px-3 text-right font-bold ${r.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                            {eur.format(r.net)}
                          </td>
                          {currentBalance?.amount != null && (
                            <td data-label="Liquidità" className={`py-2 px-3 text-right font-bold ${r.liquidity < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                              {eur.format(r.liquidity)}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-700 mb-2">Prossime uscite previste</h4>
                  {upcoming.length === 0 ? (
                    <p className="text-xs text-slate-400">Nessuna uscita prevista nelle prossime settimane.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
                      {upcoming.map((m) => (
                        <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-800 truncate">
                              {m.category_id ? categoryMap.get(m.category_id)?.name : 'Uscita'}
                              {m.scope === 'apartment' && (
                                <span className="text-slate-400 font-normal"> · {m.apartment_id ? apartments.find((a) => a.id === m.apartment_id)?.name : 'appartamenti'}</span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500">{m.movement_date.split('-').reverse().join('/')}</div>
                          </div>
                          <span className="font-bold text-rose-600 shrink-0">{eur2.format(Number(m.amount))}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="compare" className="mt-0">
          {/* Confronto anni */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-2 flex flex-col md:flex-row md:items-center justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <GitCompare className="h-4 w-4 text-primary" /> Confronto fra anni
                </CardTitle>
                <CardDescription className="text-xs">Stesso mese, anni diversi</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={compareMetric} onValueChange={(v) => setCompareMetric(v as typeof compareMetric)}>
                  <SelectTrigger className="h-8 w-[120px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="net">Saldo</SelectItem>
                    <SelectItem value="income">Entrate</SelectItem>
                    <SelectItem value="expenses">Uscite</SelectItem>
                  </SelectContent>
                </Select>
                {[
                  [yearA, setYearA],
                  [yearB, setYearB],
                ].map(([val, set], i) => (
                  <Select key={i} value={String(val)} onValueChange={(v) => (set as (n: number) => void)(Number(v))}>
                    <SelectTrigger className="h-8 w-[90px] text-xs" aria-label={`Anno ${i + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {years.map((y) => (
                        <SelectItem key={y} value={String(y)}>
                          {y}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ))}
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={compareData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} />
                    <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => eur.format(v)} />
                    <Tooltip formatter={(v: number) => eur.format(v)} contentStyle={CHART_TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                    <ReferenceLine y={0} stroke="#cbd5e1" />
                    <Line type="monotone" dataKey={String(yearA)} stroke="#0ea5e9" strokeWidth={2.5} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey={String(yearB)} stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};
