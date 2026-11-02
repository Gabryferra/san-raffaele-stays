/**
 * Calcoli della gestione finanziaria: funzioni PURE (nessun accesso al database),
 * così sono testabili e usate allo stesso modo dalle tre pagine.
 *
 * Regole anti doppio conteggio:
 *  - i giroconti (direction = transfer, es. conto -> Revolut) non entrano mai nei totali;
 *  - le occorrenze annullate (status = skipped) e le previsioni (status = planned)
 *    non entrano nei dati effettivi;
 *  - una spesa condivisa (apartment_id = NULL) conta UNA volta nel totale e viene
 *    ripartita in parti uguali sui singoli appartamenti;
 *  - nel Bilancio il risultato degli appartamenti è mostrato a parte e NON viene
 *    sommato di nuovo agli incassi lordi.
 */
import {
  AUTO_VAT_CATEGORY_ID,
  FinanceCategory,
  FinanceMovement,
  FinanceRecurring,
  INVOICED_VAT_RATE,
  MovementInput,
  MORTGAGE_KEY,
} from '@/types/finance';

export interface Period {
  from: string; // YYYY-MM-DD incluso
  to: string; // YYYY-MM-DD incluso
}

// ------------------------------------------------------------------------------
// DATE
// ------------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function monthStart(key: string): string {
  return `${key}-01`;
}

export function monthEnd(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${key}-${pad(daysInMonth(y, m))}`;
}

export function addMonths(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** Elenco dei mesi (YYYY-MM) toccati dall'intervallo, estremi inclusi. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let k = monthKey(from);
  const end = monthKey(to);
  let guard = 0;
  while (k <= end && guard++ < 1200) {
    out.push(k);
    k = addMonths(k, 1);
  }
  return out;
}

export function inPeriod(date: string, p: Period): boolean {
  return date >= p.from && date <= p.to;
}

const MONTHS_SHORT = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
export const MONTHS_LONG = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
];

export function monthLabel(key: string, long = false): string {
  const [y, m] = key.split('-').map(Number);
  return `${(long ? MONTHS_LONG : MONTHS_SHORT)[m - 1]} ${String(y).slice(long ? 0 : 2)}`;
}

// ------------------------------------------------------------------------------
// RICORRENZE
// ------------------------------------------------------------------------------
/** Date delle occorrenze di una regola ricorrente comprese nell'intervallo. */
export function occurrenceDates(rule: FinanceRecurring, from: string, to: string): string[] {
  if (!rule.is_active) return [];
  const start = rule.start_date > from ? rule.start_date : from;
  const end = rule.end_date && rule.end_date < to ? rule.end_date : to;
  if (start > end) return [];

  const out: string[] = [];
  for (const key of monthsBetween(start, end)) {
    const [y, m] = key.split('-').map(Number);
    if (rule.frequency === 'yearly') {
      const payMonth = rule.month_of_year ?? Number(rule.start_date.slice(5, 7));
      if (m !== payMonth) continue;
    }
    const day = Math.min(rule.day_of_month, daysInMonth(y, m));
    const date = `${key}-${pad(day)}`;
    if (date >= start && date <= end && date >= rule.start_date) out.push(date);
  }
  return out;
}

export function recurringRef(ruleId: string, date: string): string {
  return `rec:${ruleId}:${date}`;
}

/** Massimo arretrato generato automaticamente (evita migliaia di righe per errore). */
export const MAX_BACKFILL_MONTHS = 36;

/**
 * Movimenti da creare per le occorrenze GIÀ maturate (fino a oggi) che non esistono ancora.
 * Le occorrenze eliminate dall'utente restano come "skipped" e quindi non vengono ricreate.
 */
export function pendingRecurringMovements(
  rules: FinanceRecurring[],
  existing: Pick<FinanceMovement, 'source_ref'>[],
  today: string = todayIso()
): MovementInput[] {
  const known = new Set(existing.map((m) => m.source_ref).filter(Boolean) as string[]);
  const earliest = monthStart(addMonths(monthKey(today), -MAX_BACKFILL_MONTHS));
  const out: MovementInput[] = [];
  for (const r of rules) {
    for (const date of occurrenceDates(r, earliest, today)) {
      const ref = recurringRef(r.id, date);
      if (known.has(ref)) continue;
      out.push({
        scope: r.scope,
        direction: r.direction,
        category_id: r.category_id,
        apartment_id: r.apartment_id,
        movement_date: date,
        amount: Number(r.amount),
        invoiced_amount: null,
        interest_amount: r.interest_amount,
        description: r.description,
        status: 'actual',
        source: 'recurring',
        source_ref: ref,
        recurring_id: r.id,
      });
    }
  }
  return out;
}

/**
 * Previsione: occorrenze FUTURE delle regole ricorrenti (non salvate) + movimenti
 * inseriti a mano come "previsti". Restituisce movimenti virtuali con status planned.
 */
export function forecastMovements(
  rules: FinanceRecurring[],
  movements: FinanceMovement[],
  period: Period,
  today: string = todayIso()
): FinanceMovement[] {
  const from = period.from > today ? period.from : nextDay(today);
  const out: FinanceMovement[] = [];
  if (from <= period.to) {
    for (const r of rules) {
      for (const date of occurrenceDates(r, from, period.to)) {
        out.push({
          id: `forecast:${r.id}:${date}`,
          scope: r.scope,
          direction: r.direction,
          category_id: r.category_id,
          apartment_id: r.apartment_id,
          movement_date: date,
          amount: Number(r.amount),
          invoiced_amount: null,
          interest_amount: r.interest_amount,
          description: r.description,
          status: 'planned',
          source: 'recurring',
          source_ref: recurringRef(r.id, date),
          recurring_id: r.id,
          created_at: '',
          updated_at: '',
        });
      }
    }
  }
  for (const m of movements) {
    if (m.status === 'planned' && inPeriod(m.movement_date, period)) out.push(m);
  }
  return out.sort((a, b) => a.movement_date.localeCompare(b.movement_date));
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return toIsoDate(new Date(y, m - 1, d + 1));
}

/** Costo medio mensile di una regola (annuale = importo / 12). */
export function monthlyAverage(rule: Pick<FinanceRecurring, 'amount' | 'frequency'>): number {
  return rule.frequency === 'yearly' ? Number(rule.amount) / 12 : Number(rule.amount);
}

// ------------------------------------------------------------------------------
// FILTRI E RIPARTIZIONE
// ------------------------------------------------------------------------------
/** Movimento effettivo che entra nei totali (niente giroconti, previsioni, annullati). */
export function isCounted(m: FinanceMovement): boolean {
  return m.status === 'actual' && m.direction !== 'transfer';
}

/**
 * Quota del movimento attribuita a un appartamento.
 * aptId = 'all' -> importo intero (conteggiato una sola volta).
 * Spesa condivisa (apartment_id NULL) -> divisa in parti uguali fra gli appartamenti.
 */
export function apartmentShare(m: FinanceMovement, aptId: string | 'all', aptCount: number): number {
  if (aptId === 'all') return 1;
  if (m.apartment_id === aptId) return 1;
  if (m.apartment_id === null && aptCount > 0) return 1 / aptCount;
  return 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Quota IVA / tasse (20%) maturata automaticamente su un incasso appartamento fatturato. */
export function invoicedVatAmount(
  m: Pick<FinanceMovement, 'scope' | 'direction' | 'amount' | 'invoiced_amount'>
): number {
  if (m.scope !== 'apartment' || m.direction !== 'income') return 0;
  const amount = Math.max(0, Number(m.amount) || 0);
  const invoiced = Math.min(Math.max(0, Number(m.invoiced_amount ?? 0) || 0), amount);
  return round2(invoiced * INVOICED_VAT_RATE);
}

// ------------------------------------------------------------------------------
// CONTABILITÀ APPARTAMENTI
// ------------------------------------------------------------------------------
export interface ApartmentSummary {
  invoiced: number;
  toInvoice: number;
  income: number;
  fixed: number;
  variable: number;
  /** Accantonamento automatico IVA 20% sugli incassi fatturati (già incluso in variable ed expenses) */
  vatReserve: number;
  expenses: number;
  /** Flusso di cassa netto reale: incassi - tutte le uscite (incluso il 20% IVA su fatturato e rata mutuo intera) */
  net: number;
  /** Liquidità in cassa prima di versare l'IVA 20% (net + vatReserve) */
  cashNetBeforeVat: number;
  /** Quota capitale delle rate di mutuo (riduce il debito, non è un costo) */
  mortgageCapital: number;
  /** Redditività economica: incassi - costi (inclusa IVA 20%), considerando del mutuo solo gli interessi */
  economicNet: number;
  byCategory: Record<string, number>;
}

export function summarizeApartments(
  movements: FinanceMovement[],
  categories: Map<string, FinanceCategory>,
  aptId: string | 'all',
  aptCount: number,
  period: Period
): ApartmentSummary {
  const s: ApartmentSummary = {
    invoiced: 0, toInvoice: 0, income: 0, fixed: 0, variable: 0, vatReserve: 0, expenses: 0,
    net: 0, cashNetBeforeVat: 0, mortgageCapital: 0, economicNet: 0, byCategory: {},
  };
  for (const m of movements) {
    if (m.scope !== 'apartment' || !isCounted(m) || !inPeriod(m.movement_date, period)) continue;
    const share = apartmentShare(m, aptId, aptCount);
    if (share === 0) continue;
    const amount = Number(m.amount) * share;
    const cat = m.category_id ? categories.get(m.category_id) : undefined;
    if (m.category_id) s.byCategory[m.category_id] = (s.byCategory[m.category_id] ?? 0) + amount;

    if (m.direction === 'income') {
      const invoiced = Math.min(Math.max(0, Number(m.invoiced_amount ?? 0)), Number(m.amount)) * share;
      const vat = invoiced * INVOICED_VAT_RATE;
      s.invoiced += invoiced;
      s.toInvoice += amount - invoiced;
      s.income += amount;
      if (vat > 0) {
        s.vatReserve += vat;
        s.variable += vat;
        s.expenses += vat;
        s.byCategory[AUTO_VAT_CATEGORY_ID] = (s.byCategory[AUTO_VAT_CATEGORY_ID] ?? 0) + vat;
      }
    } else {
      if (cat?.cat_group === 'fixed') s.fixed += amount;
      else s.variable += amount;
      s.expenses += amount;
      if (cat?.system_key === MORTGAGE_KEY && m.interest_amount != null) {
        s.mortgageCapital += (Number(m.amount) - Number(m.interest_amount)) * share;
      }
    }
  }
  s.net = s.income - s.expenses;
  s.cashNetBeforeVat = s.net + s.vatReserve;
  s.economicNet = s.net + s.mortgageCapital;
  for (const k of Object.keys(s) as (keyof ApartmentSummary)[]) {
    const v = s[k];
    if (typeof v === 'number') (s[k] as number) = round2(v);
  }
  return s;
}

// ------------------------------------------------------------------------------
// FINANZE PERSONALI
// ------------------------------------------------------------------------------
export interface PersonalSummary {
  income: number;
  fixed: number;
  /** Variabili totali (comprese le spese Revolut) */
  variable: number;
  revolut: number;
  expenses: number;
  balance: number;
  /** Giroconti verso Revolut: informativi, NON sommati alle spese */
  transfers: number;
  byCategory: Record<string, number>;
}

export function summarizePersonal(
  movements: FinanceMovement[],
  categories: Map<string, FinanceCategory>,
  period: Period
): PersonalSummary {
  const s: PersonalSummary = {
    income: 0, fixed: 0, variable: 0, revolut: 0, expenses: 0, balance: 0, transfers: 0, byCategory: {},
  };
  for (const m of movements) {
    if (m.scope !== 'personal' || m.status !== 'actual' || !inPeriod(m.movement_date, period)) continue;
    const amount = Number(m.amount);
    if (m.direction === 'transfer') {
      s.transfers += amount;
      continue;
    }
    if (m.category_id) s.byCategory[m.category_id] = (s.byCategory[m.category_id] ?? 0) + amount;
    if (m.direction === 'income') {
      s.income += amount;
      continue;
    }
    const group = m.category_id ? categories.get(m.category_id)?.cat_group : undefined;
    if (group === 'fixed') s.fixed += amount;
    else {
      s.variable += amount;
      if (group === 'revolut') s.revolut += amount;
    }
    s.expenses += amount;
  }
  s.balance = s.income - s.expenses;
  for (const k of Object.keys(s) as (keyof PersonalSummary)[]) {
    const v = s[k];
    if (typeof v === 'number') (s[k] as number) = round2(v);
  }
  return s;
}

/** Budget di un mese: valore specifico del mese, altrimenti quello predefinito. */
export function budgetFor(
  budgets: { budget_key: string; month: string; amount: number }[],
  key: string,
  month: string
): number {
  const specific = budgets.find((b) => b.budget_key === key && b.month === month);
  if (specific) return Number(specific.amount);
  const def = budgets.find((b) => b.budget_key === key && b.month === 'default');
  return def ? Number(def.amount) : 0;
}

// ------------------------------------------------------------------------------
// SERIE MENSILI (grafici e Bilancio)
// ------------------------------------------------------------------------------
export interface MonthRow {
  key: string;
  label: string;
  aptIncome: number;
  aptVatReserve: number;
  aptExpenses: number;
  aptNet: number;
  personalIncome: number;
  personalExpenses: number;
  income: number;
  expenses: number;
  net: number;
  cumulative: number;
}

/**
 * Riepilogo mese per mese. Con `includeForecast` i mesi futuri usano le previsioni
 * (ricorrenze future + movimenti previsti) invece dei dati effettivi.
 */
export function monthlyRows(
  movements: FinanceMovement[],
  months: string[],
  options: { startCumulative?: number } = {}
): MonthRow[] {
  const byMonth = new Map<string, MonthRow>();
  for (const key of months) {
    byMonth.set(key, {
      key, label: monthLabel(key), aptIncome: 0, aptVatReserve: 0, aptExpenses: 0, aptNet: 0,
      personalIncome: 0, personalExpenses: 0, income: 0, expenses: 0, net: 0, cumulative: 0,
    });
  }
  for (const m of movements) {
    if (m.direction === 'transfer' || m.status === 'skipped') continue;
    const row = byMonth.get(monthKey(m.movement_date));
    if (!row) continue;
    const amount = Number(m.amount);
    if (m.scope === 'apartment') {
      if (m.direction === 'income') {
        const vat = invoicedVatAmount(m);
        row.aptIncome += amount;
        row.aptVatReserve += vat;
        row.aptExpenses += vat;
      } else {
        row.aptExpenses += amount;
      }
    } else {
      if (m.direction === 'income') row.personalIncome += amount;
      else row.personalExpenses += amount;
    }
  }
  let cum = options.startCumulative ?? 0;
  return months.map((key) => {
    const r = byMonth.get(key)!;
    r.aptNet = round2(r.aptIncome - r.aptExpenses);
    r.income = round2(r.aptIncome + r.personalIncome);
    r.expenses = round2(r.aptExpenses + r.personalExpenses);
    r.net = round2(r.income - r.expenses);
    cum += r.net;
    r.cumulative = round2(cum);
    r.aptIncome = round2(r.aptIncome);
    r.aptVatReserve = round2(r.aptVatReserve);
    r.aptExpenses = round2(r.aptExpenses);
    r.personalIncome = round2(r.personalIncome);
    r.personalExpenses = round2(r.personalExpenses);
    return r;
  });
}

/** Serie mensile per un solo appartamento (o tutti), con ripartizione delle spese condivise. */
export function apartmentMonthlyRows(
  movements: FinanceMovement[],
  aptId: string | 'all',
  aptCount: number,
  months: string[]
): { key: string; label: string; income: number; vatReserve: number; expenses: number; net: number }[] {
  const map = new Map(months.map((k) => [k, { key: k, label: monthLabel(k), income: 0, vatReserve: 0, expenses: 0, net: 0 }]));
  for (const m of movements) {
    if (m.scope !== 'apartment' || !isCounted(m)) continue;
    const row = map.get(monthKey(m.movement_date));
    if (!row) continue;
    const share = apartmentShare(m, aptId, aptCount);
    const amount = Number(m.amount) * share;
    if (m.direction === 'income') {
      const vat = invoicedVatAmount(m) * share;
      row.income += amount;
      row.vatReserve += vat;
      row.expenses += vat;
    } else {
      row.expenses += amount;
    }
  }
  return months.map((k) => {
    const r = map.get(k)!;
    return {
      ...r,
      income: round2(r.income),
      vatReserve: round2(r.vatReserve),
      expenses: round2(r.expenses),
      net: round2(r.income - r.expenses),
    };
  });
}

/** Solo i movimenti effettivi (per i grafici dei dati consuntivi). */
export function actualOnly(movements: FinanceMovement[]): FinanceMovement[] {
  return movements.filter((m) => m.status === 'actual');
}
