import React, { useMemo, useState } from 'react';
import {
  Building2,
  PlusCircle,
  Tags,
  FileCheck2,
  FileClock,
  Wallet,
  Lock,
  Shuffle,
  Receipt,
  Scale,
  Landmark,
  LineChart as LineChartIcon,
  CalendarRange,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CHART_TOOLTIP_STYLE,
  CategoryBreakdown,
  FinanceErrorBanner,
  FinanceLoading,
  KpiCard,
  PeriodFilter,
  SectionTitle,
  eur,
  usePeriod,
} from '@/components/admin/finance/finance-ui';
import { MovementDialog, EditTarget, MovementDefaults } from '@/components/admin/finance/MovementDialog';
import { CategoriesDialog, MovementsTable, RecurringList } from '@/components/admin/finance/FinanceLists';
import { useFinanceData } from '@/components/admin/finance/useFinanceData';
import {
  addMonths,
  apartmentMonthlyRows,
  inPeriod,
  monthKey,
  monthLabel,
  monthsBetween,
  summarizeApartments,
} from '@/lib/finance-calc';
import { AUTO_VAT_CATEGORY_ID } from '@/types/finance';
import { isSupabaseConfigured } from '@/lib/supabase';

export const AdminApartmentAccounting: React.FC = () => {
  const { data, error, loading, reload, categoryMap, apartmentNames } = useFinanceData();
  const { state: periodState, setState: setPeriodState, period, label: periodLabel } = usePeriod('month');
  const [tab, setTab] = useState<string>('all');
  const [viewTab, setViewTab] = useState<'overview' | 'movements' | 'recurring'>('overview');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [defaults, setDefaults] = useState<MovementDefaults | undefined>();
  const [catOpen, setCatOpen] = useState(false);

  const apartments = useMemo(() => data?.apartments ?? [], [data]);
  const aptCount = apartments.length;
  const movements = useMemo(() => data?.movements ?? [], [data]);

  const summary = useMemo(
    () => summarizeApartments(movements, categoryMap, tab, aptCount, period),
    [movements, categoryMap, tab, aptCount, period]
  );

  const perApartment = useMemo(
    () =>
      apartments.map((a) => ({
        apt: a,
        s: summarizeApartments(movements, categoryMap, a.id, aptCount, period),
      })),
    [apartments, movements, categoryMap, aptCount, period]
  );

  // Grafico: in modalità "mese" mostra i 12 mesi fino a quello scelto
  const chartMonths = useMemo(() => {
    if (periodState.mode === 'month') {
      const end = monthKey(period.from);
      return monthsBetween(`${addMonths(end, -11)}-01`, period.to);
    }
    return monthsBetween(period.from, period.to);
  }, [periodState.mode, period]);
  const chartData = useMemo(
    () => apartmentMonthlyRows(movements, tab, aptCount, chartMonths),
    [movements, tab, aptCount, chartMonths]
  );

  // Riepilogo annuale (anno della fine del periodo)
  const summaryYear = Number(period.to.slice(0, 4));
  const yearRows = useMemo(
    () =>
      apartmentMonthlyRows(
        movements,
        tab,
        aptCount,
        monthsBetween(`${summaryYear}-01-01`, `${summaryYear}-12-31`)
      ),
    [movements, tab, aptCount, summaryYear]
  );
  const yearTotals = yearRows.reduce(
    (acc, r) => ({
      income: acc.income + r.income,
      vatReserve: acc.vatReserve + r.vatReserve,
      expenses: acc.expenses + r.expenses,
      net: acc.net + r.net,
    }),
    { income: 0, vatReserve: 0, expenses: 0, net: 0 }
  );

  const expenseItems = useMemo(() => {
    const cats = (data?.categories ?? []).filter((c) => c.scope === 'apartment' && c.kind === 'expense');
    const list = cats
      .map((c) => ({
        id: c.id,
        name: c.name,
        amount: summary.byCategory[c.id] ?? 0,
        hint: c.cat_group === 'fixed' ? 'fissa' : 'variabile',
      }))
      .filter((i) => i.amount > 0);
    if (summary.vatReserve > 0) {
      list.push({
        id: AUTO_VAT_CATEGORY_ID,
        name: 'IVA / Tasse 20% su fatturato',
        amount: summary.vatReserve,
        hint: '20% automatico (spesa futura)',
      });
    }
    return list.sort((a, b) => b.amount - a.amount);
  }, [data, summary]);

  const tabMovements = useMemo(
    () =>
      movements.filter(
        (m) =>
          m.scope === 'apartment' &&
          inPeriod(m.movement_date, period) &&
          (tab === 'all' || m.apartment_id === tab || m.apartment_id === null)
      ),
    [movements, period, tab]
  );
  const tabRecurring = useMemo(
    () =>
      (data?.recurring ?? []).filter(
        (r) => r.scope === 'apartment' && (tab === 'all' || r.apartment_id === tab || r.apartment_id === null)
      ),
    [data, tab]
  );

  const openNew = (d?: MovementDefaults) => {
    setEditing(null);
    setDefaults({ apartmentId: tab === 'all' ? undefined : tab, ...d });
    setDialogOpen(true);
  };

  if (loading) return <FinanceLoading />;

  const tabName = tab === 'all' ? 'Totale appartamenti' : apartmentNames.get(tab) ?? '';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">Contabilità Appartamenti</h1>
          <p className="text-sm text-slate-500 mt-1">
            Incassi, spese e risultato di ogni alloggio. Il fatturato di “Dati Mensili” viene importato in automatico.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5 text-xs font-semibold" onClick={() => setCatOpen(true)}>
            <Tags className="h-3.5 w-3.5 text-slate-500" /> Categorie
          </Button>
          <Button size="sm" className="gap-1.5 text-xs font-semibold" onClick={() => openNew()}>
            <PlusCircle className="h-3.5 w-3.5" /> Nuovo movimento
          </Button>
        </div>
      </div>

      <FinanceErrorBanner message={error} />
      {!isSupabaseConfigured() && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900">
          Modalità anteprima locale: i dati inseriti restano solo in questo browser e non toccano il database del sito.
        </div>
      )}

      {/* Filtri */}
      <div className="lg:sticky lg:top-0 z-30 -mx-1 px-1 py-2 bg-slate-50/95 backdrop-blur flex flex-col xl:flex-row xl:items-center gap-3 justify-between">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto flex-wrap">
            {apartments.map((a) => (
              <TabsTrigger key={a.id} value={a.id} className="text-xs font-semibold">
                {a.name}
              </TabsTrigger>
            ))}
            <TabsTrigger value="all" className="text-xs font-semibold">
              TOTALE APPARTAMENTI
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <PeriodFilter value={periodState} onChange={setPeriodState} />
      </div>

      <p className="text-xs text-slate-500 -mt-3">
        <strong className="text-slate-700">{tabName}</strong> · {periodLabel}
      </p>

      {/* 1.1 Incassi */}
      <section className="space-y-2">
        <SectionTitle icon={Wallet} title="Incassi" description="Incassi fatturati e incassi diretti sono tenuti distinti." />
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <KpiCard
            title="Fatturati"
            value={summary.invoiced}
            icon={FileCheck2}
            tone="emerald"
            hint={summary.vatReserve > 0 ? `IVA 20% da accantonare: ${eur.format(summary.vatReserve)}` : 'Quota soggetta a IVA 20%'}
          />
          <KpiCard
            title="Diretti"
            value={summary.toInvoice}
            icon={FileClock}
            tone="amber"
            hint={summary.toInvoice > 0 ? 'Incassi senza fattura: apri il movimento per cambiare la parte fatturata' : undefined}
          />
          <KpiCard title="Totale incassi" value={summary.income} icon={Wallet} tone="blue" highlight />
        </div>
      </section>

      {/* 1.2 Spese */}
      <section className="space-y-2">
        <SectionTitle
          icon={Receipt}
          title="Spese"
          description={
            tab === 'all'
              ? 'Le spese condivise sono contate una sola volta. Include il 20% di IVA/tasse sul fatturato.'
              : `Comprende la quota (1/${aptCount}) delle spese condivise e il 20% di IVA/tasse sul fatturato.`
          }
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <KpiCard title="Spese fisse" value={summary.fixed} icon={Lock} tone="slate" hint="Mutuo, condominio, utenze" />
          <KpiCard
            title="Variabili (escl. IVA)"
            value={Math.max(0, summary.variable - summary.vatReserve)}
            icon={Shuffle}
            tone="violet"
            hint="Pulizie, manutenzione, varie"
          />
          <KpiCard
            title="IVA 20% fatturato"
            value={summary.vatReserve}
            icon={Landmark}
            tone="amber"
            hint="Accantonata in automatico (spesa futura)"
          />
          <KpiCard
            title="Totale spese"
            value={summary.expenses}
            icon={Receipt}
            tone="rose"
            highlight
            hint={summary.vatReserve > 0 ? `Include ${eur.format(summary.vatReserve)} di IVA 20%` : undefined}
          />
        </div>
      </section>

      {/* 1.3 Risultato */}
      <section className="space-y-2">
        <SectionTitle icon={Scale} title="Risultato economico" description="Incassi totali − Spese totali (già al netto dell'IVA 20% sul fatturato)" />
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <KpiCard
            title="Netto reale (dopo IVA)"
            value={summary.net}
            icon={Scale}
            tone="primary"
            signed
            highlight
            hint={
              summary.vatReserve > 0
                ? `In cassa oggi: ${eur.format(summary.cashNetBeforeVat)} − IVA 20% futura: ${eur.format(summary.vatReserve)}`
                : 'Soldi entrati meno soldi usciti, rata del mutuo intera'
            }
          />
          <KpiCard
            title="Redditività"
            value={summary.economicNet}
            icon={LineChartIcon}
            tone="emerald"
            signed
            hint="Come sopra, ma del mutuo conta solo la quota interessi"
          />
          <KpiCard
            title="Cap. mutuo"
            value={summary.mortgageCapital}
            icon={Landmark}
            tone="slate"
            hint="Esce dalla cassa ma riduce il debito: non è un costo"
          />
        </div>
        {summary.vatReserve > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-3.5 py-2.5 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong className="font-semibold">Promemoria liquidità vs IVA 20%:</strong> in banca vedi un saldo di cassa di{' '}
              <strong className="font-bold">{eur.format(summary.cashNetBeforeVat)}</strong>, ma{' '}
              <strong className="font-bold text-amber-800">{eur.format(summary.vatReserve)}</strong> (20% su{' '}
              {eur.format(summary.invoiced)} fatturati) è una spesa futura da versare.
            </div>
            <div className="font-bold text-slate-900 bg-white/90 px-2.5 py-1 rounded-md border border-amber-200">
              Netto realmente tuo: {eur.format(summary.net)}
            </div>
          </div>
        )}
      </section>

      {/* Sotto-schede vista: Panoramica | Movimenti | Spese Fisse */}
      <Tabs value={viewTab} onValueChange={(v) => setViewTab(v as typeof viewTab)} className="space-y-4 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
          <TabsList className="grid grid-cols-3 w-full sm:w-auto h-auto p-1 bg-slate-100/90 border border-slate-200/80">
            <TabsTrigger value="overview" className="text-[11px] sm:text-xs font-semibold px-2 sm:px-3.5 py-1.5 sm:py-2">
              📊 Panoramica
            </TabsTrigger>
            <TabsTrigger value="movements" className="text-[11px] sm:text-xs font-semibold px-2 sm:px-3.5 py-1.5 sm:py-2">
              🧾 Movimenti ({tabMovements.length})
            </TabsTrigger>
            <TabsTrigger value="recurring" className="text-[11px] sm:text-xs font-semibold px-2 sm:px-3.5 py-1.5 sm:py-2">
              🔄 Ricorrenti ({tabRecurring.length})
            </TabsTrigger>
          </TabsList>
          <div className="grid grid-cols-2 sm:flex gap-2 w-full sm:w-auto">
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1 w-full sm:w-auto" onClick={() => openNew({ direction: 'income' })}>
              <PlusCircle className="h-3.5 w-3.5 text-emerald-600" /> + Incasso
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1 w-full sm:w-auto" onClick={() => openNew({ direction: 'expense' })}>
              <PlusCircle className="h-3.5 w-3.5 text-rose-600" /> + Spesa
            </Button>
          </div>
        </div>

        <TabsContent value="overview" className="space-y-6 mt-0">
          {/* Confronto appartamenti */}
          {tab === 'all' && perApartment.length > 0 && (
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" /> Confronto fra appartamenti · {periodLabel}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <table className="stack-table w-full text-xs text-left">
                  <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[11px]">
                    <tr>
                      <th className="py-2.5 px-4">Appartamento</th>
                      <th className="py-2.5 px-4 text-right">Fatturati</th>
                      <th className="py-2.5 px-4 text-right">Diretti</th>
                      <th className="py-2.5 px-4 text-right">Incassi</th>
                      <th className="py-2.5 px-4 text-right">IVA 20%</th>
                      <th className="py-2.5 px-4 text-right">Spese tot.</th>
                      <th className="py-2.5 px-4 text-right">Netto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {perApartment.map(({ apt, s }) => (
                      <tr key={apt.id} className="hover:bg-slate-50/80 cursor-pointer" onClick={() => setTab(apt.id)}>
                        <td data-label="Appartamento" className="py-2.5 px-4 font-bold text-slate-800">{apt.name}</td>
                        <td data-label="Fatturati" className="py-2.5 px-4 text-right">{eur.format(s.invoiced)}</td>
                        <td data-label="Diretti" className="py-2.5 px-4 text-right text-amber-700">{eur.format(s.toInvoice)}</td>
                        <td data-label="Incassi" className="py-2.5 px-4 text-right font-semibold">{eur.format(s.income)}</td>
                        <td data-label="IVA 20%" className="py-2.5 px-4 text-right text-amber-700">{eur.format(s.vatReserve)}</td>
                        <td data-label="Spese tot." className="py-2.5 px-4 text-right text-rose-600">{eur.format(s.expenses)}</td>
                        <td data-label="Netto" className={`py-2.5 px-4 text-right font-bold ${s.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {eur.format(s.net)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-bold">
                      <td data-label="Appartamento" className="py-2.5 px-4">Totale</td>
                      <td data-label="Fatturati" className="py-2.5 px-4 text-right">{eur.format(summary.invoiced)}</td>
                      <td data-label="Diretti" className="py-2.5 px-4 text-right">{eur.format(summary.toInvoice)}</td>
                      <td data-label="Incassi" className="py-2.5 px-4 text-right">{eur.format(summary.income)}</td>
                      <td data-label="IVA 20%" className="py-2.5 px-4 text-right text-amber-700">{eur.format(summary.vatReserve)}</td>
                      <td data-label="Spese tot." className="py-2.5 px-4 text-right">{eur.format(summary.expenses)}</td>
                      <td data-label="Netto" className={`py-2.5 px-4 text-right ${summary.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {eur.format(summary.net)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            {/* Spese per categoria */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-bold text-slate-900">Spese per categoria</CardTitle>
                <CardDescription className="text-xs">{tabName} · {periodLabel}</CardDescription>
              </CardHeader>
              <CardContent>
                <CategoryBreakdown items={expenseItems} empty="Nessuna spesa registrata nel periodo." />
              </CardContent>
            </Card>

            {/* Grafico andamento */}
            <Card className="xl:col-span-2 border-slate-200 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <LineChartIcon className="h-4 w-4 text-primary" /> Andamento entrate, uscite e risultato
                </CardTitle>
                <CardDescription className="text-xs">
                  {tabName} · {monthLabel(chartMonths[0], true)} – {monthLabel(chartMonths[chartMonths.length - 1], true)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} />
                      <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => eur.format(v)} />
                      <Tooltip formatter={(v: number) => eur.format(v)} contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: '#f8fafc' }} />
                      <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                      <Bar dataKey="income" name="Incassi" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={28} />
                      <Bar dataKey="expenses" name="Spese" fill="#f43f5e" radius={[4, 4, 0, 0]} maxBarSize={28} />
                      <Line type="monotone" dataKey="net" name="Netto" stroke="#0f172a" strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Riepilogo annuale */}
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
                <CalendarRange className="h-4 w-4 text-primary" /> Riepilogo annuale {summaryYear} · {tabName}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <table className="stack-table w-full text-xs text-left">
                <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[11px]">
                  <tr>
                    <th className="py-2.5 px-4">Mese</th>
                    <th className="py-2.5 px-4 text-right">Incassi</th>
                    <th className="py-2.5 px-4 text-right">di cui IVA 20%</th>
                    <th className="py-2.5 px-4 text-right">Spese tot.</th>
                    <th className="py-2.5 px-4 text-right">Netto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {yearRows.map((r) => (
                    <tr key={r.key} className="hover:bg-slate-50/80">
                      <td data-label="Mese" className="py-2 px-4 font-semibold text-slate-700">{monthLabel(r.key, true)}</td>
                      <td data-label="Incassi" className="py-2 px-4 text-right">{eur.format(r.income)}</td>
                      <td data-label="di cui IVA 20%" className="py-2 px-4 text-right text-amber-700">{eur.format(r.vatReserve)}</td>
                      <td data-label="Spese tot." className="py-2 px-4 text-right text-rose-600">{eur.format(r.expenses)}</td>
                      <td data-label="Netto" className={`py-2 px-4 text-right font-bold ${r.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {eur.format(r.net)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-bold">
                    <td data-label="Mese" className="py-2.5 px-4">Totale {summaryYear}</td>
                    <td data-label="Incassi" className="py-2.5 px-4 text-right">{eur.format(yearTotals.income)}</td>
                    <td data-label="di cui IVA 20%" className="py-2.5 px-4 text-right text-amber-700">{eur.format(yearTotals.vatReserve)}</td>
                    <td data-label="Spese tot." className="py-2.5 px-4 text-right">{eur.format(yearTotals.expenses)}</td>
                    <td data-label="Netto" className={`py-2.5 px-4 text-right ${yearTotals.net < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                      {eur.format(yearTotals.net)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="movements" className="mt-0">
          <MovementsTable
            title="Movimenti del periodo"
            description={tab === 'all' ? 'Tutti gli appartamenti' : `${tabName} + spese condivise`}
            movements={tabMovements}
            categories={categoryMap}
            apartmentNames={apartmentNames}
            showApartment
            onEdit={(m) => {
              setEditing({ type: 'movement', item: m });
              setDialogOpen(true);
            }}
            onChanged={reload}
            actions={
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="text-xs gap-1" onClick={() => openNew({ direction: 'income' })}>
                  <PlusCircle className="h-3.5 w-3.5 text-emerald-600" /> Incasso
                </Button>
                <Button size="sm" variant="outline" className="text-xs gap-1" onClick={() => openNew({ direction: 'expense' })}>
                  <PlusCircle className="h-3.5 w-3.5 text-rose-600" /> Spesa
                </Button>
              </div>
            }
          />
        </TabsContent>

        <TabsContent value="recurring" className="mt-0">
          <RecurringList
            rules={tabRecurring}
            categories={categoryMap}
            apartmentNames={apartmentNames}
            showApartment
            onEdit={(r) => {
              setEditing({ type: 'recurring', item: r });
              setDialogOpen(true);
            }}
            onChanged={reload}
            onAdd={() => openNew({ direction: 'expense', recurrence: 'monthly' })}
          />
        </TabsContent>
      </Tabs>

      {data && (
        <>
          <MovementDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            scope="apartment"
            apartments={apartments}
            categories={data.categories}
            editing={editing}
            defaults={defaults}
            onSaved={reload}
          />
          <CategoriesDialog open={catOpen} onOpenChange={setCatOpen} scope="apartment" categories={data.categories} onChanged={reload} />
        </>
      )}
    </div>
  );
};
