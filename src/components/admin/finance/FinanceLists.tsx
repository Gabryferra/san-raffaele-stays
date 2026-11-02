import React, { useMemo, useState } from 'react';
import { Pencil, Trash2, Repeat, Search, Plus, Tags, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  FinanceCategory,
  FinanceGroup,
  FinanceKind,
  FinanceMovement,
  FinanceRecurring,
  FinanceScope,
} from '@/types/finance';
import { invoicedVatAmount, monthlyAverage, occurrenceDates, todayIso, addMonths, monthKey, monthEnd } from '@/lib/finance-calc';
import {
  createCategory,
  deleteCategory,
  deleteMovement,
  deleteRecurring,
  updateCategory,
  updateRecurring,
} from '@/lib/finance-api';
import { eur2 } from './finance-ui';

const fmtDate = (d: string) => d.split('-').reverse().join('/');

const Pill: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${className}`}>
    {children}
  </span>
);

// ------------------------------------------------------------------------------
// ELENCO MOVIMENTI
// ------------------------------------------------------------------------------
export const MovementsTable: React.FC<{
  title: string;
  description?: string;
  movements: FinanceMovement[];
  categories: Map<string, FinanceCategory>;
  apartmentNames?: Map<string, string>;
  showApartment?: boolean;
  onEdit: (m: FinanceMovement) => void;
  onChanged: () => void;
  actions?: React.ReactNode;
}> = ({ title, description, movements, categories, apartmentNames, showApartment, onEdit, onChanged, actions }) => {
  const [type, setType] = useState<'all' | 'income' | 'expense' | 'transfer' | 'planned'>('all');
  const [catFilter, setCatFilter] = useState('all');
  const [query, setQuery] = useState('');

  const usedCategories = useMemo(() => {
    const ids = new Set(movements.map((m) => m.category_id).filter(Boolean) as string[]);
    return [...ids].map((id) => categories.get(id)).filter(Boolean) as FinanceCategory[];
  }, [movements, categories]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return movements
      .filter((m) => m.status !== 'skipped')
      .filter((m) => (type === 'all' ? true : type === 'planned' ? m.status === 'planned' : m.direction === type))
      .filter((m) => catFilter === 'all' || m.category_id === catFilter)
      .filter((m) => {
        if (!q) return true;
        const cat = m.category_id ? categories.get(m.category_id)?.name ?? '' : '';
        return `${m.description ?? ''} ${cat}`.toLowerCase().includes(q);
      })
      .sort((a, b) => b.movement_date.localeCompare(a.movement_date) || b.created_at.localeCompare(a.created_at));
  }, [movements, type, catFilter, query, categories]);

  const handleDelete = async (m: FinanceMovement) => {
    const msg =
      m.source === 'recurring'
        ? 'Annullare questa scadenza? La ricorrenza resta attiva per i mesi successivi.'
        : 'Eliminare definitivamente questo movimento?';
    if (!window.confirm(msg)) return;
    try {
      await deleteMovement(m);
      toast.success('Movimento eliminato');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore durante l’eliminazione.');
    }
  };

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base font-bold text-slate-900">{title}</CardTitle>
          {description && <CardDescription className="text-xs">{description}</CardDescription>}
        </div>
        {actions}
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cerca…"
              className="h-8 w-40 pl-8 text-xs"
              aria-label="Cerca nei movimenti"
            />
          </div>
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
            <SelectTrigger className="h-8 w-[130px] text-xs" aria-label="Tipo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutti i tipi</SelectItem>
              <SelectItem value="income">Entrate</SelectItem>
              <SelectItem value="expense">Uscite</SelectItem>
              <SelectItem value="transfer">Giroconti</SelectItem>
              <SelectItem value="planned">Solo previsti</SelectItem>
            </SelectContent>
          </Select>
          <Select value={catFilter} onValueChange={setCatFilter}>
            <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Categoria">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tutte le categorie</SelectItem>
              {usedCategories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[11px] text-slate-400 ml-auto">{rows.length} movimenti</span>
        </div>
        <div className="overflow-x-auto">
          <table className="stack-table w-full text-xs text-left">
            <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-2.5 px-4">Data</th>
                <th className="py-2.5 px-4">Categoria</th>
                {showApartment && <th className="py-2.5 px-4">Appartamento</th>}
                <th className="py-2.5 px-4">Descrizione</th>
                <th className="py-2.5 px-4 text-right">Importo</th>
                <th className="stack-hide py-2.5 px-4 text-right">Azioni</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((m) => {
                const cat = m.category_id ? categories.get(m.category_id) : undefined;
                const sign = m.direction === 'income' ? '+' : m.direction === 'expense' ? '−' : '⇄';
                const color =
                  m.direction === 'income' ? 'text-emerald-600' : m.direction === 'expense' ? 'text-rose-600' : 'text-slate-500';
                const toInvoice =
                  m.scope === 'apartment' && m.direction === 'income'
                    ? Number(m.amount) - Math.min(Number(m.invoiced_amount ?? 0), Number(m.amount))
                    : 0;
                const vatAmount = invoicedVatAmount(m);
                return (
                  <tr key={m.id} className={`hover:bg-slate-50/80 ${m.status === 'planned' ? 'opacity-70' : ''}`}>
                    <td data-label="Data" className="py-2.5 px-4 font-semibold text-slate-800 whitespace-nowrap">
                      {fmtDate(m.movement_date)}
                    </td>
                    <td data-label="Categoria" className="py-2.5 px-4">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="font-semibold text-slate-700">{cat?.name ?? (m.direction === 'transfer' ? 'Giroconto' : '—')}</span>
                        {m.source === 'monthly_data' && <Pill className="bg-sky-50 text-sky-700">Da Dati Mensili</Pill>}
                        {m.source === 'recurring' && (
                          <Pill className="bg-violet-50 text-violet-700">
                            <Repeat className="h-2.5 w-2.5" /> Ricorrente
                          </Pill>
                        )}
                        {m.status === 'planned' && <Pill className="bg-amber-50 text-amber-700">Previsto</Pill>}
                        {vatAmount > 0 && (
                          <Pill className="bg-amber-100/80 text-amber-900">IVA 20%: −{eur2.format(vatAmount)}</Pill>
                        )}
                        {toInvoice > 0 && <Pill className="bg-orange-50 text-orange-700">Diretto {eur2.format(toInvoice)}</Pill>}
                        {m.interest_amount != null && (
                          <Pill className="bg-slate-100 text-slate-600">Interessi {eur2.format(Number(m.interest_amount))}</Pill>
                        )}
                      </div>
                    </td>
                    {showApartment && (
                      <td data-label="Appartamento" className="py-2.5 px-4 text-slate-700">
                        {m.apartment_id ? apartmentNames?.get(m.apartment_id) ?? '—' : <Pill className="bg-slate-100 text-slate-600">Condivisa</Pill>}
                      </td>
                    )}
                    <td data-label="Descrizione" className="py-2.5 px-4 text-slate-600 max-w-xs truncate">
                      {m.description || '—'}
                    </td>
                    <td data-label="Importo" className={`py-2.5 px-4 text-right font-bold whitespace-nowrap ${color}`}>
                      {sign} {eur2.format(Number(m.amount))}
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(m)} aria-label="Modifica">
                        <Pencil className="h-3.5 w-3.5 text-slate-500" />
                      </Button>
                      {m.source !== 'monthly_data' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleDelete(m)}
                          aria-label="Elimina"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={showApartment ? 6 : 5} className="py-8 text-center text-slate-400">
                    Nessun movimento nel periodo selezionato.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};

// ------------------------------------------------------------------------------
// ELENCO RICORRENZE
// ------------------------------------------------------------------------------
export function nextOccurrence(rule: FinanceRecurring): string | null {
  const today = todayIso();
  const horizon = monthEnd(addMonths(monthKey(today), 13));
  return occurrenceDates(rule, today, horizon)[0] ?? null;
}

export const RecurringList: React.FC<{
  rules: FinanceRecurring[];
  categories: Map<string, FinanceCategory>;
  apartmentNames?: Map<string, string>;
  showApartment?: boolean;
  onEdit: (r: FinanceRecurring) => void;
  onChanged: () => void;
  onAdd: () => void;
}> = ({ rules, categories, apartmentNames, showApartment, onEdit, onChanged, onAdd }) => {
  const sorted = [...rules].sort(
    (a, b) => Number(b.is_active) - Number(a.is_active) || Number(b.amount) - Number(a.amount)
  );
  const monthlyTotal = rules
    .filter((r) => r.is_active && r.direction === 'expense' && (!r.end_date || r.end_date >= todayIso()))
    .reduce((acc, r) => acc + monthlyAverage(r), 0);

  const toggle = async (r: FinanceRecurring) => {
    try {
      await updateRecurring(r.id, { is_active: !r.is_active });
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore');
    }
  };

  const remove = async (r: FinanceRecurring) => {
    if (!window.confirm('Eliminare la ricorrenza? Le scadenze già registrate restano nello storico.')) return;
    try {
      await deleteRecurring(r.id);
      toast.success('Ricorrenza eliminata');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore');
    }
  };

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Repeat className="h-4 w-4 text-primary" /> Spese e entrate ricorrenti
          </CardTitle>
          <CardDescription className="text-xs">
            Registrate in automatico a ogni scadenza. Uscite ricorrenti attive: in media{' '}
            <strong>{eur2.format(monthlyTotal)}</strong> al mese (le annuali sono divise per 12).
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" /> Nuova ricorrenza
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="stack-table w-full text-xs text-left">
            <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 font-semibold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="py-2.5 px-4">Voce</th>
                {showApartment && <th className="py-2.5 px-4">Appartamento</th>}
                <th className="py-2.5 px-4">Frequenza</th>
                <th className="py-2.5 px-4 text-right">Importo</th>
                <th className="py-2.5 px-4 text-right">Medio mensile</th>
                <th className="py-2.5 px-4">Prossima</th>
                <th className="stack-hide py-2.5 px-4 text-right">Attiva / Azioni</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((r) => {
                const next = nextOccurrence(r);
                return (
                  <tr key={r.id} className={`hover:bg-slate-50/80 ${r.is_active ? '' : 'opacity-50'}`}>
                    <td data-label="Voce" className="py-2.5 px-4">
                      <div className="font-semibold text-slate-800">{categories.get(r.category_id)?.name ?? '—'}</div>
                      {r.description && <div className="text-[11px] text-slate-500">{r.description}</div>}
                    </td>
                    {showApartment && (
                      <td data-label="Appartamento" className="py-2.5 px-4 text-slate-700">
                        {r.apartment_id ? apartmentNames?.get(r.apartment_id) ?? '—' : 'Condivisa'}
                      </td>
                    )}
                    <td data-label="Frequenza" className="py-2.5 px-4 text-slate-700">
                      {r.frequency === 'monthly' ? `Mensile (giorno ${r.day_of_month})` : `Annuale (${fmtDate(r.start_date).slice(0, 5)})`}
                    </td>
                    <td
                      data-label="Importo"
                      className={`py-2.5 px-4 text-right font-bold ${r.direction === 'income' ? 'text-emerald-600' : 'text-rose-600'}`}
                    >
                      {eur2.format(Number(r.amount))}
                    </td>
                    <td data-label="Medio mensile" className="py-2.5 px-4 text-right text-slate-700">
                      {eur2.format(monthlyAverage(r))}
                    </td>
                    <td data-label="Prossima" className="py-2.5 px-4 text-slate-700">
                      {next ? fmtDate(next) : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <Switch checked={r.is_active} onCheckedChange={() => toggle(r)} aria-label="Attiva" />
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(r)} aria-label="Modifica">
                          <Pencil className="h-3.5 w-3.5 text-slate-500" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(r)} aria-label="Elimina">
                          <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={showApartment ? 7 : 6} className="py-8 text-center text-slate-400">
                    Nessuna ricorrenza. Aggiungi mutuo, condominio, utenze, affitto… per averli in automatico ogni mese.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};

// ------------------------------------------------------------------------------
// GESTIONE CATEGORIE
// ------------------------------------------------------------------------------
const GROUPS_BY_SCOPE: Record<FinanceScope, { value: string; label: string }[]> = {
  apartment: [
    { value: 'income', label: 'Entrata' },
    { value: 'fixed', label: 'Spesa fissa' },
    { value: 'variable', label: 'Spesa variabile' },
  ],
  personal: [
    { value: 'income', label: 'Entrata' },
    { value: 'fixed', label: 'Spesa fissa' },
    { value: 'variable', label: 'Spesa variabile' },
    { value: 'revolut', label: 'Spesa Revolut' },
  ],
};

export const CategoriesDialog: React.FC<{
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scope: FinanceScope;
  categories: FinanceCategory[];
  onChanged: () => void;
}> = ({ open, onOpenChange, scope, categories, onChanged }) => {
  const [newName, setNewName] = useState('');
  const [newGroup, setNewGroup] = useState('variable');
  const [names, setNames] = useState<Record<string, string>>({});

  const list = categories.filter((c) => c.scope === scope);
  const groups = GROUPS_BY_SCOPE[scope];

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore');
    }
  };

  const add = () => {
    if (!newName.trim()) return;
    const kind: FinanceKind = newGroup === 'income' ? 'income' : 'expense';
    run(
      () =>
        createCategory({
          scope,
          kind,
          cat_group: kind === 'income' ? null : (newGroup as FinanceGroup),
          name: newName.trim(),
          system_key: null,
          sort_order: 200,
          is_active: true,
        }),
      'Categoria aggiunta'
    ).then(() => setNewName(''));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-bold flex items-center gap-2">
            <Tags className="h-4 w-4 text-primary" /> Categorie {scope === 'apartment' ? 'appartamenti' : 'personali'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Rinomina, disattiva o aggiungi categorie. Una categoria già usata non si elimina: si disattiva (resta nello
            storico ma non compare più fra le scelte).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {groups.map((g) => {
            const items = list.filter((c) => (c.kind === 'income' ? 'income' : c.cat_group) === g.value);
            return (
              <div key={g.value}>
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">{g.label}</h4>
                <div className="space-y-1.5">
                  {items.map((c) => (
                    <div key={c.id} className="flex items-center gap-2">
                      <Input
                        value={names[c.id] ?? c.name}
                        onChange={(e) => setNames({ ...names, [c.id]: e.target.value })}
                        className={`h-8 text-xs ${c.is_active ? '' : 'opacity-50'}`}
                      />
                      {names[c.id] !== undefined && names[c.id] !== c.name && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          aria-label="Salva nome"
                          onClick={() => run(() => updateCategory(c.id, { name: names[c.id].trim() || c.name }), 'Nome aggiornato')}
                        >
                          <Save className="h-3.5 w-3.5 text-primary" />
                        </Button>
                      )}
                      <Switch
                        checked={c.is_active}
                        onCheckedChange={(v) => run(() => updateCategory(c.id, { is_active: v }), v ? 'Categoria attivata' : 'Categoria disattivata')}
                        aria-label="Attiva"
                      />
                      {!c.system_key && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          aria-label="Elimina categoria"
                          onClick={() => window.confirm(`Eliminare “${c.name}”?`) && run(() => deleteCategory(c.id), 'Categoria eliminata')}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="rounded-lg border border-dashed border-slate-300 p-3 space-y-2">
            <Label className="text-xs font-semibold">Nuova categoria</Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nome"
                className="h-8 text-xs"
                onKeyDown={(e) => e.key === 'Enter' && add()}
              />
              <Select value={newGroup} onValueChange={setNewGroup}>
                <SelectTrigger className="h-8 text-xs sm:w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.value} value={g.value}>
                      {g.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" className="h-8 gap-1 text-xs" onClick={add}>
                <Plus className="h-3.5 w-3.5" /> Aggiungi
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
