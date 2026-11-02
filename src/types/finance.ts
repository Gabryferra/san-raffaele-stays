/**
 * Tipi della gestione finanziaria (Contabilità Appartamenti, Finanze Personali, Bilancio).
 * Rispecchiano le tabelle di supabase/migrations/20261031_finance.sql.
 */

export type FinanceScope = 'apartment' | 'personal';
export type FinanceKind = 'income' | 'expense';
export type FinanceDirection = 'income' | 'expense' | 'transfer';
/** fixed/variable = spese fisse/variabili; revolut = spese quotidiane pagate con Revolut */
export type FinanceGroup = 'fixed' | 'variable' | 'revolut';
export type MovementStatus = 'actual' | 'planned' | 'skipped';
export type MovementSource = 'manual' | 'recurring' | 'monthly_data';
export type RecurringFrequency = 'monthly' | 'yearly';

export interface FinanceCategory {
  id: string;
  scope: FinanceScope;
  kind: FinanceKind;
  cat_group: FinanceGroup | null;
  name: string;
  /** Categorie con logica speciale (es. apt_mortgage). NULL per quelle create dall'admin. */
  system_key: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FinanceMovement {
  id: string;
  scope: FinanceScope;
  direction: FinanceDirection;
  category_id: string | null;
  /** Solo scope apartment. NULL = spesa condivisa fra tutti gli appartamenti. */
  apartment_id: string | null;
  movement_date: string; // YYYY-MM-DD
  amount: number;
  /** Solo entrate appartamenti: parte già fatturata (0..amount). NULL = 0. */
  invoiced_amount: number | null;
  /** Solo rate di mutuo: quota interessi (il resto è capitale). */
  interest_amount: number | null;
  description: string | null;
  status: MovementStatus;
  source: MovementSource;
  source_ref: string | null;
  recurring_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FinanceRecurring {
  id: string;
  scope: FinanceScope;
  direction: FinanceKind;
  category_id: string;
  apartment_id: string | null;
  amount: number;
  interest_amount: number | null;
  frequency: RecurringFrequency;
  day_of_month: number;
  /** Solo frequenza annuale: mese del pagamento (1-12). */
  month_of_year: number | null;
  start_date: string;
  end_date: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FinanceBudget {
  id: string;
  budget_key: string;
  /** 'YYYY-MM' oppure 'default' */
  month: string;
  amount: number;
  created_at: string;
  updated_at: string;
}

export type MovementInput = Omit<FinanceMovement, 'id' | 'created_at' | 'updated_at'>;
export type RecurringInput = Omit<FinanceRecurring, 'id' | 'created_at' | 'updated_at'>;
export type CategoryInput = Omit<FinanceCategory, 'id' | 'created_at' | 'updated_at'>;

export const REVOLUT_BUDGET_KEY = 'revolut';
export const MORTGAGE_KEY = 'apt_mortgage';
export const APT_RENT_KEY = 'apt_income_rent';
/** Aliquota IVA / accantonamento fiscale automatico sugli incassi fatturati (20%). */
export const INVOICED_VAT_RATE = 0.2;
export const AUTO_VAT_CATEGORY_ID = '__auto_vat_20__';
