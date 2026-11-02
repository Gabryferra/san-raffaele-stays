import React, { useEffect, useMemo, useState } from 'react';
import { Save, Repeat, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Apartment } from '@/types/database';
import {
  FinanceCategory,
  FinanceDirection,
  FinanceMovement,
  FinanceRecurring,
  FinanceScope,
  INVOICED_VAT_RATE,
  MORTGAGE_KEY,
  MovementStatus,
} from '@/types/finance';
import { createMovement, createRecurring, updateMovement, updateRecurring } from '@/lib/finance-api';
import { todayIso } from '@/lib/finance-calc';
import { eur2 } from './finance-ui';

export type EditTarget =
  | { type: 'movement'; item: FinanceMovement }
  | { type: 'recurring'; item: FinanceRecurring }
  | null;

export interface MovementDefaults {
  direction?: FinanceDirection;
  apartmentId?: string | null;
  categoryId?: string;
  recurrence?: 'none' | 'monthly' | 'yearly';
}

const GROUP_LABEL: Record<string, string> = { fixed: 'Fisse', variable: 'Variabili', revolut: 'Revolut (spese quotidiane)' };

export const MovementDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: FinanceScope;
  apartments: Apartment[];
  categories: FinanceCategory[];
  editing: EditTarget;
  defaults?: MovementDefaults;
  allowTransfer?: boolean;
  onSaved: () => void;
}> = ({ open, onOpenChange, scope, apartments, categories, editing, defaults, allowTransfer, onSaved }) => {
  const [direction, setDirection] = useState<FinanceDirection>('expense');
  const [date, setDate] = useState(todayIso());
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [aptChoice, setAptChoice] = useState<string>('shared');
  const [invoiced, setInvoiced] = useState('');
  const [interest, setInterest] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<MovementStatus>('actual');
  const [recurrence, setRecurrence] = useState<'none' | 'monthly' | 'yearly'>('none');
  const [endDate, setEndDate] = useState('');
  const [saving, setSaving] = useState(false);

  const isRecurringEdit = editing?.type === 'recurring';
  const fromMonthlyData = editing?.type === 'movement' && editing.item.source === 'monthly_data';

  // Inizializza il form a ogni apertura
  useEffect(() => {
    if (!open) return;
    if (editing?.type === 'movement') {
      const m = editing.item;
      setDirection(m.direction);
      setDate(m.movement_date);
      setAmount(String(m.amount));
      setCategoryId(m.category_id ?? '');
      setAptChoice(m.apartment_id ?? 'shared');
      setInvoiced(m.invoiced_amount != null ? String(m.invoiced_amount) : '');
      setInterest(m.interest_amount != null ? String(m.interest_amount) : '');
      setDescription(m.description ?? '');
      setStatus(m.status === 'planned' ? 'planned' : 'actual');
      setRecurrence('none');
      setEndDate('');
    } else if (editing?.type === 'recurring') {
      const r = editing.item;
      setDirection(r.direction);
      setDate(r.start_date);
      setAmount(String(r.amount));
      setCategoryId(r.category_id);
      setAptChoice(r.apartment_id ?? 'shared');
      setInvoiced('');
      setInterest(r.interest_amount != null ? String(r.interest_amount) : '');
      setDescription(r.description ?? '');
      setStatus('actual');
      setRecurrence(r.frequency);
      setEndDate(r.end_date ?? '');
    } else {
      setDirection(defaults?.direction ?? 'expense');
      setDate(todayIso());
      setAmount('');
      setCategoryId(defaults?.categoryId ?? '');
      setAptChoice(defaults?.apartmentId ?? (scope === 'apartment' ? apartments[0]?.id ?? 'shared' : 'shared'));
      setInvoiced('');
      setInterest('');
      setDescription('');
      setStatus('actual');
      setRecurrence(defaults?.recurrence ?? 'none');
      setEndDate('');
    }
  }, [open, editing, defaults, scope, apartments]);

  const availableCategories = useMemo(
    () =>
      categories.filter(
        (c) =>
          c.scope === scope &&
          c.kind === (direction === 'income' ? 'income' : 'expense') &&
          (c.is_active || c.id === categoryId)
      ),
    [categories, scope, direction, categoryId]
  );

  // Se la categoria scelta non è compatibile col tipo, propone la prima disponibile
  useEffect(() => {
    if (!open || direction === 'transfer') return;
    if (!availableCategories.some((c) => c.id === categoryId)) {
      setCategoryId(availableCategories[0]?.id ?? '');
    }
  }, [open, direction, availableCategories, categoryId]);

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const isMortgage = selectedCategory?.system_key === MORTGAGE_KEY;
  const showInvoice = scope === 'apartment' && direction === 'income' && recurrence === 'none' && !isRecurringEdit;
  const amountNum = Number(amount.replace(',', '.'));

  const groupedCategories = useMemo(() => {
    const groups = new Map<string, FinanceCategory[]>();
    for (const c of availableCategories) {
      const g = c.cat_group ?? 'income';
      groups.set(g, [...(groups.get(g) ?? []), c]);
    }
    return [...groups.entries()];
  }, [availableCategories]);

  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

  const handleSave = async () => {
    if (!Number.isFinite(amountNum) || amountNum < 0 || amount.trim() === '') {
      toast.error('Inserisci un importo valido.');
      return;
    }
    if (direction !== 'transfer' && !categoryId) {
      toast.error('Scegli una categoria.');
      return;
    }
    const apartmentId = scope === 'apartment' ? (aptChoice === 'shared' ? null : aptChoice) : null;
    const interestNum = isMortgage ? num(interest) : null;
    if (interestNum != null && interestNum > amountNum) {
      toast.error('La quota interessi non può superare la rata.');
      return;
    }

    setSaving(true);
    try {
      if (editing?.type === 'movement') {
        if (fromMonthlyData) {
          await updateMovement(editing.item.id, {
            invoiced_amount: Math.min(num(invoiced) ?? 0, Number(editing.item.amount)),
            description: description || null,
          });
        } else {
          await updateMovement(editing.item.id, {
            direction,
            movement_date: date,
            amount: amountNum,
            category_id: direction === 'transfer' ? null : categoryId,
            apartment_id: apartmentId,
            invoiced_amount: showInvoice ? Math.min(num(invoiced) ?? 0, amountNum) : null,
            interest_amount: interestNum,
            description: description || null,
            ...(editing.item.source === 'manual' ? { status } : {}),
          });
        }
      } else if (recurrence !== 'none' && direction !== 'transfer') {
        const [, m, d] = date.split('-').map(Number);
        const payload = {
          scope,
          direction: direction as 'income' | 'expense',
          category_id: categoryId,
          apartment_id: apartmentId,
          amount: amountNum,
          interest_amount: interestNum,
          frequency: recurrence,
          day_of_month: d,
          month_of_year: recurrence === 'yearly' ? m : null,
          start_date: date,
          end_date: endDate || null,
          description: description || null,
          is_active: true,
        };
        if (editing?.type === 'recurring') await updateRecurring(editing.item.id, payload);
        else await createRecurring(payload);
      } else {
        await createMovement({
          scope,
          direction,
          movement_date: date,
          amount: amountNum,
          category_id: direction === 'transfer' ? null : categoryId,
          apartment_id: apartmentId,
          invoiced_amount: showInvoice ? Math.min(num(invoiced) ?? 0, amountNum) : null,
          interest_amount: interestNum,
          description: description || null,
          status,
          source: 'manual',
          source_ref: null,
          recurring_id: null,
        });
      }
      toast.success(recurrence !== 'none' && editing?.type !== 'movement' ? 'Ricorrenza salvata' : 'Movimento salvato');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Errore durante il salvataggio.');
    } finally {
      setSaving(false);
    }
  };

  const title = isRecurringEdit
    ? 'Modifica ricorrenza'
    : editing
      ? 'Modifica movimento'
      : scope === 'apartment'
        ? 'Nuovo movimento appartamenti'
        : 'Nuovo movimento personale';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            {fromMonthlyData
              ? 'Incasso importato automaticamente da “Dati Mensili”: qui puoi indicare quanto è fatturato (il resto è incasso diretto).'
              : 'Data, importo e categoria sono obbligatori. I totali si aggiornano subito.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!fromMonthlyData && !editing && (
            <div className={`grid ${allowTransfer ? 'grid-cols-3' : 'grid-cols-2'} gap-1 rounded-lg bg-slate-100 p-1`}>
              {(
                [
                  ['expense', 'Uscita'],
                  ['income', 'Entrata'],
                  ...(allowTransfer ? ([['transfer', 'Giroconto']] as const) : []),
                ] as [FinanceDirection, string][]
              ).map(([d, text]) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    setDirection(d);
                    if (d === 'transfer') setRecurrence('none');
                  }}
                  className={`py-1.5 text-xs font-semibold rounded-md transition-colors ${
                    direction === d
                      ? d === 'income'
                        ? 'bg-emerald-600 text-white'
                        : d === 'expense'
                          ? 'bg-rose-600 text-white'
                          : 'bg-slate-700 text-white'
                      : 'text-slate-600 hover:bg-white'
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
          )}

          {direction === 'transfer' && (
            <p className="flex gap-2 text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
              Il giroconto (es. dal conto principale a Revolut) è solo uno spostamento di soldi: viene mostrato ma
              non conta come spesa. Le spese vere vanno registrate nelle categorie Revolut.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">
                {recurrence !== 'none' ? 'Prima scadenza' : 'Data'}
              </Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-9"
                disabled={fromMonthlyData}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Importo (€)</Label>
              <Input
                inputMode="decimal"
                placeholder="0,00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-9"
                disabled={fromMonthlyData}
              />
            </div>
          </div>

          {direction !== 'transfer' && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Categoria</Label>
              <Select value={categoryId} onValueChange={setCategoryId} disabled={fromMonthlyData}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Seleziona categoria" />
                </SelectTrigger>
                <SelectContent>
                  {groupedCategories.map(([group, list]) => (
                    <SelectGroup key={group}>
                      {group !== 'income' && (
                        <SelectLabel className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          {GROUP_LABEL[group] ?? group}
                        </SelectLabel>
                      )}
                      {list.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {scope === 'apartment' && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Appartamento</Label>
              <Select value={aptChoice} onValueChange={setAptChoice} disabled={fromMonthlyData}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {apartments.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="shared">Condivisa fra tutti (ripartita in parti uguali)</SelectItem>
                </SelectContent>
              </Select>
              {aptChoice === 'shared' && (
                <p className="text-[11px] text-slate-500">
                  Conta una sola volta nel totale; su ogni appartamento pesa 1/{apartments.length || 1}.
                </p>
              )}
            </div>
          )}

          {(showInvoice || fromMonthlyData) && (() => {
            const invNum = Math.max(0, Number(invoiced.replace(',', '.')) || 0);
            const vatPreview = Math.round(invNum * INVOICED_VAT_RATE * 100) / 100;
            return (
              <div className="space-y-1.5 rounded-lg border border-slate-200 p-3 bg-slate-50/60">
                <Label className="text-xs font-semibold">Importo già fatturato (€)</Label>
                <div className="flex gap-2">
                  <Input
                    inputMode="decimal"
                    placeholder="0"
                    value={invoiced}
                    onChange={(e) => setInvoiced(e.target.value)}
                    className="h-9"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 text-xs shrink-0"
                    onClick={() => setInvoiced(fromMonthlyData && editing?.type === 'movement' ? String(editing.item.amount) : amount)}
                  >
                    Tutto
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="h-9 text-xs shrink-0" onClick={() => setInvoiced('0')}>
                    Niente
                  </Button>
                </div>
                <p className="text-[11px] text-slate-500">
                  La differenza viene conteggiata fra gli “incassi diretti”. Su quanto fatturi viene accantonato in automatico il <strong>20% di IVA/tasse</strong> tra le spese del mese.
                </p>
                {vatPreview > 0 && (
                  <div className="rounded-md bg-amber-50 border border-amber-200 px-2.5 py-1.5 text-[11px] text-amber-900 flex items-center justify-between">
                    <span>IVA / Tasse 20% accantonate come spesa:</span>
                    <strong className="font-bold">− {eur2.format(vatPreview)}</strong>
                  </div>
                )}
              </div>
            );
          })()}

          {isMortgage && (
            <div className="space-y-1.5 rounded-lg border border-slate-200 p-3 bg-slate-50/60">
              <Label className="text-xs font-semibold">di cui interessi (€)</Label>
              <Input
                inputMode="decimal"
                placeholder="Es. 180"
                value={interest}
                onChange={(e) => setInterest(e.target.value)}
                className="h-9"
              />
              <p className="text-[11px] text-slate-500">
                Il resto della rata è capitale: esce dalla cassa ma non è un costo (riduce il debito). Serve per
                distinguere il flusso di cassa dalla redditività.
              </p>
            </div>
          )}

          {!editing && direction !== 'transfer' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold flex items-center gap-1 h-4">
                  <Repeat className="h-3 w-3" /> Ricorrenza
                </Label>
                <Select value={recurrence} onValueChange={(v) => setRecurrence(v as typeof recurrence)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nessuna (una tantum)</SelectItem>
                    <SelectItem value="monthly">Ogni mese</SelectItem>
                    <SelectItem value="yearly">Ogni anno</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {recurrence === 'none' ? (
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold flex items-center h-4">Stato</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v as MovementStatus)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="actual">Effettivo</SelectItem>
                      <SelectItem value="planned">Previsto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold flex items-center h-4">Fine (opzionale)</Label>
                  <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-9" />
                </div>
              )}
            </div>
          )}

          {isRecurringEdit && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">Frequenza</Label>
                <Select value={recurrence} onValueChange={(v) => setRecurrence(v as typeof recurrence)}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Ogni mese</SelectItem>
                    <SelectItem value="yearly">Ogni anno</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold flex items-center h-4">Fine (opzionale)</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="h-9" />
              </div>
            </div>
          )}

          {editing?.type === 'movement' && editing.item.source === 'manual' && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold flex items-center h-4">Stato</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as MovementStatus)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="actual">Effettivo</SelectItem>
                  <SelectItem value="planned">Previsto</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {recurrence !== 'none' && (
            <p className="text-[11px] text-slate-500 bg-sky-50 border border-sky-100 rounded-lg p-2.5">
              {recurrence === 'monthly' ? 'Ogni mese' : 'Ogni anno'} il movimento viene registrato in automatico alla
              scadenza. Le scadenze future compaiono nella previsione.
              {recurrence === 'yearly' && Number.isFinite(amountNum) && amountNum > 0 && (
                <> Costo medio mensile: <strong>{(amountNum / 12).toFixed(2).replace('.', ',')} €</strong>.</>
              )}
            </p>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">Descrizione / nota</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={direction === 'transfer' ? 'Es. Ricarica Revolut di novembre' : 'Opzionale'}
              className="text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Annulla
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5 font-semibold">
            <Save className="h-4 w-4" />
            Salva
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
