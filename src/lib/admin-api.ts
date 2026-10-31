import { supabase, isSupabaseConfigured } from './supabase';
import { getLocalSiteEvents, summarizeEvents, SiteEventSummaryRow } from './tracking';
import {
  Apartment,
  DailyRate,
  Availability,
  MinStayRule,
  MonthlyData,
  EventItem,
  InternalNote,
  RateHistory,
  MonthlyDataHistory,
  SiteEvent,
  RateTier,
} from '@/types/database';
import {
  INITIAL_APARTMENTS,
  INITIAL_EVENTS,
  INITIAL_MONTHLY_DATA,
  INITIAL_MIN_STAY_RULES,
  INITIAL_NOTES,
} from './mock-data';

// Helper per generare UUID conformi allo standard PostgreSQL
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Local storage keys for fallback/mock mode
const LS_APARTMENTS = 'srs_apartments';
const LS_RATES = 'srs_daily_rates';
const LS_AVAIL = 'srs_availability';
const LS_MIN_STAY = 'srs_min_stay_rules';
const LS_MONTHLY = 'srs_monthly_data';
const LS_EVENTS = 'srs_events';
const LS_NOTES = 'srs_notes';
const LS_RATE_HISTORY = 'srs_rate_history';
const LS_MONTHLY_HISTORY = 'srs_monthly_history';

// Helper storage functions
function getLocal<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function setLocal<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error('LocalStorage write failed:', e);
  }
}

// Inizializza mock data se non presenti
function ensureLocalInitialized() {
  if (!localStorage.getItem(LS_APARTMENTS)) {
    setLocal(LS_APARTMENTS, INITIAL_APARTMENTS);
  }
  if (!localStorage.getItem(LS_EVENTS)) {
    setLocal(LS_EVENTS, INITIAL_EVENTS);
  }
  if (!localStorage.getItem(LS_MIN_STAY)) {
    setLocal(LS_MIN_STAY, INITIAL_MIN_STAY_RULES);
  }
  if (!localStorage.getItem(LS_MONTHLY)) {
    setLocal(LS_MONTHLY, INITIAL_MONTHLY_DATA);
  }
  if (!localStorage.getItem(LS_NOTES)) {
    setLocal(LS_NOTES, INITIAL_NOTES);
  }
  if (!localStorage.getItem(LS_RATES)) {
    const today = new Date();
    const rates: DailyRate[] = [];
    INITIAL_APARTMENTS.forEach((apt) => {
      for (let day = 1; day <= 31; day++) {
        const d = new Date(today.getFullYear(), today.getMonth(), day);
        if (d.getMonth() === today.getMonth()) {
          const dateStr = d.toISOString().split('T')[0];
          rates.push({
            id: generateUUID(),
            apartment_id: apt.id,
            rate_date: dateStr,
            price_per_night: apt.base_price_2p,
            is_manual_override: false,
            source: 'rule',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
    });
    setLocal(LS_RATES, rates);
  }
  if (!localStorage.getItem(LS_AVAIL)) {
    setLocal(LS_AVAIL, []);
  }
  if (!localStorage.getItem(LS_RATE_HISTORY)) {
    setLocal(LS_RATE_HISTORY, []);
  }
  if (!localStorage.getItem(LS_MONTHLY_HISTORY)) {
    setLocal(LS_MONTHLY_HISTORY, []);
  }
}

ensureLocalInitialized();

// ==============================================================================
// APARTMENTS API
// ==============================================================================
export async function getApartments(): Promise<Apartment[]> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('apartments')
      .select('*')
      .order('name');
    if (!error && data && data.length > 0) return data as Apartment[];
  }
  return getLocal<Apartment[]>(LS_APARTMENTS, INITIAL_APARTMENTS);
}

export async function updateApartment(id: string, updates: Partial<Apartment>): Promise<Apartment> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('apartments')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (!error && data) return data as Apartment;
    if (error) console.error('Supabase updateApartment error:', error);
  }
  const apts = getLocal<Apartment[]>(LS_APARTMENTS, INITIAL_APARTMENTS);
  const index = apts.findIndex((a) => a.id === id);
  if (index !== -1) {
    apts[index] = { ...apts[index], ...updates, updated_at: new Date().toISOString() };
    setLocal(LS_APARTMENTS, apts);
    return apts[index];
  }
  throw new Error('Alloggio non trovato');
}

// ==============================================================================
// ERRORI DATABASE
// Quando Supabase è configurato NON si ripiega mai in silenzio su localStorage:
// una scrittura fallita deve essere visibile, altrimenti l'interfaccia mostra
// "salvato" mentre il database non è stato modificato.
// ==============================================================================
interface DbErrorLike {
  message: string;
  code?: string;
  hint?: string | null;
  details?: string | null;
}

function dbError(action: string, error: DbErrorLike): Error {
  console.error(`Supabase ${action}:`, error);
  let reason = error.message;
  if (error.code === '42501' || /row-level security|permission denied/i.test(error.message)) {
    reason = 'permesso negato dal database (RLS). Esci e rientra nell’area admin; se persiste controlla le policy.';
  } else if (error.code === '23503') {
    reason = 'l’alloggio non esiste nel database (chiave esterna). Controlla che i 3 alloggi siano presenti su Supabase.';
  } else if (error.code === '42703' || error.code === 'PGRST204' || /column .* does not exist|schema cache/i.test(error.message)) {
    reason = 'colonna mancante nel database. Esegui la migrazione supabase/migrations/20261023_stay_rules.sql.';
  } else if (error.code === '42P10') {
    reason = 'manca il vincolo UNIQUE richiesto (apartment_id + data). Riesegui la migrazione iniziale.';
  }
  return new Error(`${action}: ${reason}`);
}

// ==============================================================================
// DAILY RATES & AVAILABILITY API
// ==============================================================================
export async function getCalendarData(apartmentId: string, startDate: string, endDate: string) {
  if (isSupabaseConfigured()) {
    const [ratesRes, availRes] = await Promise.all([
      supabase
        .from('daily_rates')
        .select('*')
        .eq('apartment_id', apartmentId)
        .gte('rate_date', startDate)
        .lte('rate_date', endDate),
      supabase
        .from('availability')
        .select('*')
        .eq('apartment_id', apartmentId)
        .gte('avail_date', startDate)
        .lte('avail_date', endDate),
    ]);
    if (ratesRes.error) throw dbError('Lettura tariffe', ratesRes.error);
    if (availRes.error) throw dbError('Lettura disponibilità', availRes.error);
    return {
      rates: (ratesRes.data ?? []) as DailyRate[],
      availability: (availRes.data ?? []) as Availability[],
    };
  }

  const allRates = getLocal<DailyRate[]>(LS_RATES, []);
  const allAvail = getLocal<Availability[]>(LS_AVAIL, []);
  return {
    rates: allRates.filter(
      (r) => r.apartment_id === apartmentId && r.rate_date >= startDate && r.rate_date <= endDate
    ),
    availability: allAvail.filter(
      (a) => a.apartment_id === apartmentId && a.avail_date >= startDate && a.avail_date <= endDate
    ),
  };
}

export async function getAllPublicCalendarData(startDate: string, endDate: string) {
  if (isSupabaseConfigured()) {
    const [ratesRes, availRes] = await Promise.all([
      supabase.from('daily_rates').select('*').gte('rate_date', startDate).lte('rate_date', endDate),
      supabase.from('availability').select('*').gte('avail_date', startDate).lte('avail_date', endDate),
    ]);
    return {
      rates: (ratesRes.data ?? []) as DailyRate[],
      availability: (availRes.data ?? []) as Availability[],
    };
  }
  ensureLocalInitialized();
  const allRates = getLocal<DailyRate[]>(LS_RATES, []);
  const allAvail = getLocal<Availability[]>(LS_AVAIL, []);
  return {
    rates: allRates.filter((r) => r.rate_date >= startDate && r.rate_date <= endDate),
    availability: allAvail.filter((a) => a.avail_date >= startDate && a.avail_date <= endDate),
  };
}

export async function setDailyRate(
  apartmentId: string,
  date: string,
  price: number,
  source: 'manual' | 'bulk' = 'manual'
) {
  const res = await bulkUpdateCalendar(apartmentId, [date], { price }, source);
  return res.rates[0];
}

export async function setAvailability(
  apartmentId: string,
  date: string,
  isAvailable: boolean,
  isHighDemand: boolean = false,
  notes: string = ''
) {
  const res = await bulkUpdateCalendar(apartmentId, [date], {
    is_available: isAvailable,
    is_high_demand: isHighDemand,
    notes,
  });
  return res.availability[0];
}

export async function bulkUpdateCalendar(
  apartmentId: string,
  dates: string[],
  updates: {
    price?: number;
    /** Scaglione da assegnare (con price = suo prezzo 2 persone); null = prezzo manuale */
    tierId?: string | null;
    is_available?: boolean;
    is_high_demand?: boolean;
    notes?: string;
  },
  source: 'manual' | 'bulk' = 'bulk'
): Promise<{ rates: DailyRate[]; availability: Availability[] }> {
  const uniqueDates = [...new Set(dates)];
  const touchAvail =
    updates.is_available !== undefined || updates.is_high_demand !== undefined || updates.notes !== undefined;
  const nowIso = new Date().toISOString();

  if (updates.price !== undefined && (!Number.isFinite(updates.price) || updates.price < 0)) {
    throw new Error('Prezzo non valido.');
  }

  // ---------------------------- Supabase ----------------------------
  if (isSupabaseConfigured()) {
    let savedRates: DailyRate[] = [];
    let savedAvail: Availability[] = [];

    if (updates.price !== undefined) {
      const rows = uniqueDates.map((date) => ({
        apartment_id: apartmentId,
        rate_date: date,
        price_per_night: updates.price as number,
        is_manual_override: true,
        source,
        ...(updates.tierId !== undefined && !tiersTableMissing ? { tier_id: updates.tierId } : {}),
        updated_at: nowIso,
      }));
      // NB: onConflict senza spazi, altrimenti PostgREST cerca la colonna " rate_date"
      let { data, error } = await supabase
        .from('daily_rates')
        .upsert(rows, { onConflict: 'apartment_id,rate_date' })
        .select();
      if (error && updates.tierId !== undefined && isMissingTierTable(error)) {
        tiersTableMissing = true;
        const rowsWithoutTier = rows.map(({ tier_id: _omit, ...rest }) => rest);
        const retry = await supabase
          .from('daily_rates')
          .upsert(rowsWithoutTier, { onConflict: 'apartment_id,rate_date' })
          .select();
        data = retry.data;
        error = retry.error;
      }
      if (error) throw dbError('Salvataggio tariffe', error);
      savedRates = (data ?? []) as DailyRate[];

      const wrong = savedRates.filter((r) => Number(r.price_per_night) !== Number(updates.price));
      if (savedRates.length !== uniqueDates.length || wrong.length > 0) {
        throw new Error(
          `Salvataggio tariffe: il database ha confermato ${savedRates.length - wrong.length} giorni su ${uniqueDates.length}. Modifica NON applicata completamente.`
        );
      }
    }

    if (touchAvail) {
      // Recupera le righe esistenti per non perdere note / flag non toccati
      const { data: existing, error: exErr } = await supabase
        .from('availability')
        .select('*')
        .eq('apartment_id', apartmentId)
        .in('avail_date', uniqueDates);
      if (exErr) throw dbError('Lettura disponibilità', exErr);
      const byDate = new Map((existing ?? []).map((a) => [a.avail_date as string, a as Availability]));

      const rows = uniqueDates.map((date) => {
        const cur = byDate.get(date);
        return {
          apartment_id: apartmentId,
          avail_date: date,
          is_available: updates.is_available ?? cur?.is_available ?? true,
          is_high_demand: updates.is_high_demand ?? cur?.is_high_demand ?? false,
          notes: (updates.notes ?? cur?.notes ?? '') || null,
          updated_at: nowIso,
        };
      });
      const { data, error } = await supabase
        .from('availability')
        .upsert(rows, { onConflict: 'apartment_id,avail_date' })
        .select();
      if (error) throw dbError('Salvataggio disponibilità', error);
      savedAvail = (data ?? []) as Availability[];
      if (savedAvail.length !== uniqueDates.length) {
        throw new Error(
          `Salvataggio disponibilità: confermati ${savedAvail.length} giorni su ${uniqueDates.length}.`
        );
      }
    }

    return { rates: savedRates, availability: savedAvail };
  }

  // ------------------- Modalità locale (senza Supabase) -------------------
  const allRates = getLocal<DailyRate[]>(LS_RATES, []);
  const history = getLocal<RateHistory[]>(LS_RATE_HISTORY, []);
  const allAvail = getLocal<Availability[]>(LS_AVAIL, []);
  const savedRates: DailyRate[] = [];
  const savedAvail: Availability[] = [];

  for (const date of uniqueDates) {
    if (updates.price !== undefined) {
      const idx = allRates.findIndex((r) => r.apartment_id === apartmentId && r.rate_date === date);
      if (idx !== -1) {
        const oldPrice = allRates[idx].price_per_night;
        allRates[idx] = {
          ...allRates[idx],
          price_per_night: updates.price,
          is_manual_override: true,
          source,
          ...(updates.tierId !== undefined ? { tier_id: updates.tierId } : {}),
          updated_at: nowIso,
        };
        if (oldPrice !== updates.price) {
          history.unshift({
            id: generateUUID(),
            apartment_id: apartmentId,
            daily_rate_id: allRates[idx].id,
            rate_date: date,
            old_price: oldPrice,
            new_price: updates.price,
            change_reason: 'Modifica manuale admin',
            changed_at: nowIso,
          });
        }
        savedRates.push(allRates[idx]);
      } else {
        const created: DailyRate = {
          id: generateUUID(),
          apartment_id: apartmentId,
          rate_date: date,
          price_per_night: updates.price,
          is_manual_override: true,
          source,
          tier_id: updates.tierId ?? null,
          created_at: nowIso,
          updated_at: nowIso,
        };
        allRates.push(created);
        savedRates.push(created);
      }
    }

    if (touchAvail) {
      const idx = allAvail.findIndex((a) => a.apartment_id === apartmentId && a.avail_date === date);
      const cur = idx !== -1 ? allAvail[idx] : undefined;
      const next: Availability = {
        id: cur?.id ?? generateUUID(),
        apartment_id: apartmentId,
        avail_date: date,
        is_available: updates.is_available ?? cur?.is_available ?? true,
        is_high_demand: updates.is_high_demand ?? cur?.is_high_demand ?? false,
        notes: (updates.notes ?? cur?.notes ?? '') || null,
        created_at: cur?.created_at ?? nowIso,
        updated_at: nowIso,
      };
      if (idx !== -1) allAvail[idx] = next;
      else allAvail.push(next);
      savedAvail.push(next);
    }
  }

  setLocal(LS_RATES, allRates);
  setLocal(LS_RATE_HISTORY, history);
  setLocal(LS_AVAIL, allAvail);
  return { rates: savedRates, availability: savedAvail };
}

// ==============================================================================
// SCAGLIONI TARIFFARI (prezzi per 2/3/4 persone assegnabili ai giorni)
// ==============================================================================
const LS_TIERS = 'srs_rate_tiers';
export type RateTierInput = Omit<RateTier, 'id' | 'created_at' | 'updated_at'>;

function validateTier(t: Partial<RateTierInput>) {
  if (t.name !== undefined && !t.name.trim()) throw new Error('Dai un nome allo scaglione.');
  for (const k of ['price_2p', 'price_3p', 'price_4p'] as const) {
    if (t[k] !== undefined && (!Number.isFinite(Number(t[k])) || Number(t[k]) < 0)) {
      throw new Error('Prezzi dello scaglione non validi.');
    }
  }
}

let tiersTableMissing = false;

function isMissingTierTable(error: DbErrorLike): boolean {
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    error.code === '42703' ||
    /rate_tiers|tier_id|does not exist|schema cache/i.test(error.message)
  );
}

function useTiersDb(): boolean {
  return isSupabaseConfigured() && !tiersTableMissing;
}

function tierError(action: string, error: DbErrorLike): Error {
  if (isMissingTierTable(error)) {
    console.error(`Supabase ${action}:`, error);
    return new Error(`${action}: esegui la migrazione supabase/migrations/20261031_rate_tiers.sql.`);
  }
  if (error.code === '23505') return new Error(`${action}: esiste già uno scaglione con questo nome.`);
  return dbError(action, error);
}

const sortTiers = (list: RateTier[]) => [...list].sort((a, b) => Number(a.price_2p) - Number(b.price_2p) || a.name.localeCompare(b.name));

export async function getRateTiers(apartmentId?: string): Promise<RateTier[]> {
  if (useTiersDb()) {
    let q = supabase.from('rate_tiers').select('*');
    if (apartmentId) q = q.eq('apartment_id', apartmentId);
    const { data, error } = await q;
    if (!error) return sortTiers((data ?? []) as RateTier[]);
    if (!isMissingTierTable(error)) throw tierError('Lettura scaglioni', error);
    tiersTableMissing = true;
  }
  const all = getLocal<RateTier[]>(LS_TIERS, []);
  return sortTiers(apartmentId ? all.filter((t) => t.apartment_id === apartmentId) : all);
}

export async function createRateTier(input: RateTierInput): Promise<RateTier> {
  validateTier(input);
  if (useTiersDb()) {
    const { data, error } = await supabase.from('rate_tiers').insert(input).select().single();
    if (!error) return data as RateTier;
    if (!isMissingTierTable(error)) throw tierError('Creazione scaglione', error);
    tiersTableMissing = true;
  }
  const list = getLocal<RateTier[]>(LS_TIERS, []);
  if (list.some((t) => t.apartment_id === input.apartment_id && t.name.toLowerCase() === input.name.toLowerCase())) {
    throw new Error('Creazione scaglione: esiste già uno scaglione con questo nome.');
  }
  const nowIso = new Date().toISOString();
  const created: RateTier = { ...input, id: generateUUID(), created_at: nowIso, updated_at: nowIso };
  setLocal(LS_TIERS, [...list, created]);
  return created;
}

/**
 * Modifica uno scaglione. Se cambia il prezzo per 2 persone, tutti i giorni del
 * calendario che lo usano si aggiornano (in Supabase lo fa il trigger del database).
 */
export async function updateRateTier(id: string, updates: Partial<RateTierInput>): Promise<RateTier> {
  validateTier(updates);
  if (useTiersDb()) {
    const { data, error } = await supabase.from('rate_tiers').update(updates).eq('id', id).select();
    if (!error) {
      if (!data?.length) throw new Error('Modifica scaglione: nessuna riga aggiornata.');
      return data[0] as RateTier;
    }
    if (!isMissingTierTable(error)) throw tierError('Modifica scaglione', error);
    tiersTableMissing = true;
  }
  const list = getLocal<RateTier[]>(LS_TIERS, []);
  const idx = list.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error('Scaglione non trovato');
  const nowIso = new Date().toISOString();
  const updated = { ...list[idx], ...updates, updated_at: nowIso };
  list[idx] = updated;
  setLocal(LS_TIERS, list);

  const rates = getLocal<DailyRate[]>(LS_RATES, []);
  const history = getLocal<RateHistory[]>(LS_RATE_HISTORY, []);
  let touched = false;
  for (const r of rates) {
    if (r.tier_id !== id || Number(r.price_per_night) === Number(updated.price_2p)) continue;
    history.unshift({
      id: generateUUID(),
      apartment_id: r.apartment_id,
      daily_rate_id: r.id,
      rate_date: r.rate_date,
      old_price: r.price_per_night,
      new_price: Number(updated.price_2p),
      change_reason: `Scaglione ${updated.name} modificato`,
      changed_at: nowIso,
    });
    r.price_per_night = Number(updated.price_2p);
    r.updated_at = nowIso;
    touched = true;
  }
  if (touched) {
    setLocal(LS_RATES, rates);
    setLocal(LS_RATE_HISTORY, history);
  }
  return updated;
}

/** Elimina lo scaglione: i giorni che lo usavano mantengono il prezzo, come prezzo manuale. */
export async function deleteRateTier(id: string): Promise<void> {
  if (useTiersDb()) {
    const { error } = await supabase.from('rate_tiers').delete().eq('id', id);
    if (!error) return;
    if (!isMissingTierTable(error)) throw tierError('Eliminazione scaglione', error);
    tiersTableMissing = true;
  }
  setLocal(LS_TIERS, getLocal<RateTier[]>(LS_TIERS, []).filter((t) => t.id !== id));
  setLocal(
    LS_RATES,
    getLocal<DailyRate[]>(LS_RATES, []).map((r) => (r.tier_id === id ? { ...r, tier_id: null } : r))
  );
}

/** Prezzo di un giorno per numero di ospiti, se il giorno usa uno scaglione. */
export function tierPriceFor(tier: Pick<RateTier, 'price_2p' | 'price_3p' | 'price_4p'>, guests: number): number {
  if (guests >= 4) return Number(tier.price_4p);
  if (guests === 3) return Number(tier.price_3p);
  return Number(tier.price_2p);
}

// ==============================================================================
// REGOLE DI SOGGIORNO (soggiorno minimo, costi extra, sconti)
// ==============================================================================
export type StayRuleInput = Omit<MinStayRule, 'id' | 'created_at' | 'updated_at'>;

function normalizeRule(r: MinStayRule): MinStayRule {
  return { ...r, rule_type: r.rule_type ?? 'min_stay', is_active: r.is_active ?? true };
}

/**
 * Colonne da inviare al database. Per i soggiorni minimi attivi si inviano solo
 * le colonne storiche, così funzionano anche prima di eseguire la migrazione.
 */
function ruleToRow(rule: Partial<StayRuleInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const legacy = ['apartment_id', 'min_nights', 'start_date', 'end_date', 'priority', 'description'] as const;
  for (const k of legacy) if (rule[k] !== undefined) row[k] = rule[k];

  const type = rule.rule_type ?? 'min_stay';
  if (type !== 'min_stay') {
    row.rule_type = type;
    row.amount = rule.amount ?? null;
    row.amount_type = rule.amount_type ?? null;
    row.charge_basis = rule.charge_basis ?? null;
    row.threshold_nights = rule.threshold_nights ?? null;
    row.min_nights = null;
  }
  if (rule.is_active !== undefined) row.is_active = rule.is_active;
  return row;
}

export async function getStayRules(): Promise<MinStayRule[]> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('min_stay_rules')
      .select('*')
      .order('priority', { ascending: false });
    if (error) throw dbError('Lettura regole soggiorno', error);
    const rules = (data as MinStayRule[]).map(normalizeRule);
    if (!rules.some((r) => r.rule_type === 'discount')) {
      const defaultDiscounts = INITIAL_MIN_STAY_RULES.filter((r) => r.rule_type === 'discount').map(normalizeRule);
      return [...rules, ...defaultDiscounts];
    }
    return rules;
  }
  const local = getLocal<MinStayRule[]>(LS_MIN_STAY, INITIAL_MIN_STAY_RULES).map(normalizeRule);
  if (!local.some((r) => r.rule_type === 'discount')) {
    const defaultDiscounts = INITIAL_MIN_STAY_RULES.filter((r) => r.rule_type === 'discount').map(normalizeRule);
    local.push(...defaultDiscounts);
  }
  return local.sort((a, b) => b.priority - a.priority);
}

export async function createStayRule(rule: StayRuleInput): Promise<MinStayRule> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase.from('min_stay_rules').insert(ruleToRow(rule)).select().single();
    if (error) throw dbError('Creazione regola', error);
    return normalizeRule(data as MinStayRule);
  }
  const newRule: MinStayRule = normalizeRule({
    ...rule,
    id: generateUUID(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as MinStayRule);
  const list = getLocal<MinStayRule[]>(LS_MIN_STAY, INITIAL_MIN_STAY_RULES);
  list.unshift(newRule);
  setLocal(LS_MIN_STAY, list);
  return newRule;
}

export async function updateStayRule(id: string, updates: Partial<StayRuleInput>): Promise<MinStayRule> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('min_stay_rules')
      .update(ruleToRow(updates))
      .eq('id', id)
      .select();
    if (error) throw dbError('Modifica regola', error);
    // Con RLS un UPDATE non consentito non dà errore: restituisce 0 righe
    if (!data || data.length === 0) {
      throw new Error('Modifica regola: nessuna riga aggiornata (regola inesistente o permesso negato).');
    }
    return normalizeRule(data[0] as MinStayRule);
  }
  const list = getLocal<MinStayRule[]>(LS_MIN_STAY, INITIAL_MIN_STAY_RULES);
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error('Regola non trovata');
  list[idx] = normalizeRule({ ...list[idx], ...updates, updated_at: new Date().toISOString() });
  setLocal(LS_MIN_STAY, list);
  return list[idx];
}

export async function deleteStayRule(id: string): Promise<boolean> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase.from('min_stay_rules').delete().eq('id', id).select();
    if (error) throw dbError('Eliminazione regola', error);
    if (!data || data.length === 0) {
      throw new Error('Eliminazione regola: nessuna riga eliminata (regola inesistente o permesso negato).');
    }
    return true;
  }
  const list = getLocal<MinStayRule[]>(LS_MIN_STAY, INITIAL_MIN_STAY_RULES);
  setLocal(LS_MIN_STAY, list.filter((r) => r.id !== id));
  return true;
}

// Alias per compatibilità con il codice esistente
export const getMinStayRules = getStayRules;
export const createMinStayRule = createStayRule;
export const deleteMinStayRule = deleteStayRule;

// ==============================================================================
// MONTHLY DATA API (Occupazione & Prezzo Medio)
// ==============================================================================
export async function getMonthlyData(): Promise<MonthlyData[]> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('monthly_data')
      .select('*')
      .order('year', { ascending: false })
      .order('month', { ascending: false });
    if (!error && data) return data as MonthlyData[];
  }
  return getLocal<MonthlyData[]>(LS_MONTHLY, INITIAL_MONTHLY_DATA);
}

export async function upsertMonthlyData(entry: Omit<MonthlyData, 'id' | 'created_at' | 'updated_at'>): Promise<MonthlyData> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('monthly_data')
      .upsert(
        {
          apartment_id: entry.apartment_id,
          year: entry.year,
          month: entry.month,
          occupancy_percentage: entry.occupancy_percentage,
          average_price: entry.average_price,
          revenue: entry.revenue,
          price_definition: entry.price_definition,
          notes: entry.notes,
          is_manual: entry.is_manual,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'apartment_id, year, month' }
      )
      .select()
      .single();
    if (!error && data) return data as MonthlyData;
    if (error) console.error('Supabase upsertMonthlyData error:', error);
  }

  const list = getLocal<MonthlyData[]>(LS_MONTHLY, INITIAL_MONTHLY_DATA);
  const history = getLocal<MonthlyDataHistory[]>(LS_MONTHLY_HISTORY, []);
  const index = list.findIndex(
    (m) => m.apartment_id === entry.apartment_id && m.year === entry.year && m.month === entry.month
  );

  let result: MonthlyData;
  if (index !== -1) {
    const old = list[index];
    result = {
      ...old,
      ...entry,
      updated_at: new Date().toISOString(),
    };
    list[index] = result;
    if (old.occupancy_percentage !== entry.occupancy_percentage || old.average_price !== entry.average_price || (old.revenue ?? null) !== (entry.revenue ?? null)) {
      history.unshift({
        id: generateUUID(),
        monthly_data_id: old.id,
        old_occupancy: old.occupancy_percentage,
        new_occupancy: entry.occupancy_percentage,
        old_avg_price: old.average_price,
        new_avg_price: entry.average_price,
        old_revenue: old.revenue ?? null,
        new_revenue: entry.revenue ?? null,
        change_reason: 'Rettifica manuale admin',
        changed_at: new Date().toISOString(),
      });
    }
  } else {
    result = {
      ...entry,
      id: generateUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    list.unshift(result);
  }

  setLocal(LS_MONTHLY, list);
  setLocal(LS_MONTHLY_HISTORY, history);
  return result;
}

export async function getMonthlyDataHistory(): Promise<MonthlyDataHistory[]> {
  if (isSupabaseConfigured()) {
    const { data } = await supabase.from('monthly_data_history').select('*').order('changed_at', { ascending: false });
    if (data) return data as MonthlyDataHistory[];
  }
  return getLocal<MonthlyDataHistory[]>(LS_MONTHLY_HISTORY, []);
}

// ==============================================================================
// EVENTS & NOTES API
// ==============================================================================
export async function getEvents(): Promise<EventItem[]> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .order('start_date', { ascending: true });
    if (!error && data) return data as EventItem[];
  }
  return getLocal<EventItem[]>(LS_EVENTS, INITIAL_EVENTS);
}

export async function createEvent(event: Omit<EventItem, 'id' | 'created_at' | 'updated_at'>): Promise<EventItem> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('events')
      .insert({
        name: event.name,
        start_date: event.start_date,
        end_date: event.end_date,
        description: event.description,
        is_high_demand: event.is_high_demand,
        extra_info: event.extra_info,
      })
      .select()
      .single();
    if (!error && data) return data as EventItem;
    if (error) {
      console.error('Supabase createEvent error:', error);
      throw error;
    }
  }

  const newEvent: EventItem = {
    ...event,
    id: generateUUID(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const list = getLocal<EventItem[]>(LS_EVENTS, INITIAL_EVENTS);
  list.push(newEvent);
  setLocal(LS_EVENTS, list);
  return newEvent;
}

export async function updateEvent(id: string, updates: Partial<EventItem>): Promise<EventItem> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase.from('events').update(updates).eq('id', id).select().single();
    if (!error && data) return data as EventItem;
  }
  const list = getLocal<EventItem[]>(LS_EVENTS, INITIAL_EVENTS);
  const idx = list.findIndex((e) => e.id === id);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...updates, updated_at: new Date().toISOString() };
    setLocal(LS_EVENTS, list);
    return list[idx];
  }
  throw new Error('Evento non trovato');
}

export async function deleteEvent(id: string): Promise<boolean> {
  if (isSupabaseConfigured()) {
    await supabase.from('events').delete().eq('id', id);
  }
  const list = getLocal<EventItem[]>(LS_EVENTS, INITIAL_EVENTS);
  setLocal(LS_EVENTS, list.filter((e) => e.id !== id));
  return true;
}

export async function getNotes(): Promise<InternalNote[]> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('notes')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error && data) return data as InternalNote[];
  }
  return getLocal<InternalNote[]>(LS_NOTES, INITIAL_NOTES);
}

export async function createNote(note: Omit<InternalNote, 'id' | 'created_at' | 'updated_at'>): Promise<InternalNote> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('notes')
      .insert({
        apartment_id: note.apartment_id,
        event_id: note.event_id,
        note_date: note.note_date,
        content: note.content,
        category: note.category,
        is_private: note.is_private,
      })
      .select()
      .single();
    if (!error && data) return data as InternalNote;
    if (error) {
      console.error('Supabase createNote error:', error);
      throw error;
    }
  }

  const newNote: InternalNote = {
    ...note,
    id: generateUUID(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const list = getLocal<InternalNote[]>(LS_NOTES, INITIAL_NOTES);
  list.unshift(newNote);
  setLocal(LS_NOTES, list);
  return newNote;
}

export async function deleteNote(id: string): Promise<boolean> {
  if (isSupabaseConfigured()) {
    await supabase.from('notes').delete().eq('id', id);
  }
  const list = getLocal<InternalNote[]>(LS_NOTES, INITIAL_NOTES);
  setLocal(LS_NOTES, list.filter((n) => n.id !== id));
  return true;
}

export async function getRateHistory(apartmentId?: string, limit = 300): Promise<RateHistory[]> {
  if (isSupabaseConfigured()) {
    // Limite: lo storico cresce a ogni modifica e va scaricato a pezzi (traffico del piano free)
    let query = supabase
      .from('rate_history')
      .select('*')
      .order('changed_at', { ascending: false })
      .limit(limit);
    if (apartmentId) query = query.eq('apartment_id', apartmentId);
    const { data, error } = await query;
    if (error) throw dbError('Lettura storico tariffe', error);
    return (data ?? []) as RateHistory[];
  }
  const history = getLocal<RateHistory[]>(LS_RATE_HISTORY, []);
  const list = apartmentId ? history.filter((h) => h.apartment_id === apartmentId) : history;
  return list.slice(0, limit);
}

// ==============================================================================
// STATISTICHE SITO (riepilogo calcolato dal database: pochi KB, non migliaia di righe)
// ==============================================================================
const CONTACT_EVENT_TYPES = ['phone_click', 'whatsapp_click', 'email_click', 'form_submit', 'form_error'];

export async function getSiteEventSummary(
  sinceIso?: string
): Promise<{ rows: SiteEventSummaryRow[]; fromDatabase: boolean }> {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase.rpc('admin_site_event_summary', { p_since: sinceIso ?? null });
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        throw new Error('Statistiche: funzione mancante. Esegui la migrazione supabase/migrations/20261024_security_hardening.sql.');
      }
      throw dbError('Lettura statistiche', error);
    }
    const rows = ((data ?? []) as SiteEventSummaryRow[]).map((r) => ({ ...r, cnt: Number(r.cnt) }));
    return { rows, fromDatabase: true };
  }
  return { rows: summarizeEvents(getLocalSiteEvents(sinceIso)), fromDatabase: false };
}

export async function getRecentContactEvents(sinceIso?: string, limit = 300): Promise<SiteEvent[]> {
  if (isSupabaseConfigured()) {
    let q = supabase
      .from('site_events')
      .select('id,event_type,page_path,metadata,session_id,created_at')
      .in('event_type', CONTACT_EVENT_TYPES)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (sinceIso) q = q.gte('created_at', sinceIso);
    const { data, error } = await q;
    if (error) throw dbError('Lettura registro contatti', error);
    return (data ?? []) as SiteEvent[];
  }
  return getLocalSiteEvents(sinceIso)
    .filter((e) => CONTACT_EVENT_TYPES.includes(e.event_type))
    .slice(0, limit);
}

// ==============================================================================
// EXPORT DATA (CSV & JSON)
// ==============================================================================
/** Legge un'intera tabella a blocchi da 1000 righe (limite di PostgREST). */
async function fetchAllRows<T>(table: string, orderBy: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderBy, { ascending: true })
      .range(from, from + 999);
    if (error) throw dbError(`Backup ${table}`, error);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * Backup completo. Il piano free di Supabase NON include backup automatici:
 * conviene scaricare questo file periodicamente (es. una volta al mese).
 */
export async function exportAllDataJSON(): Promise<string> {
  const [apartments, events, monthly, rules, notes] = await Promise.all([
    getApartments(),
    getEvents(),
    getMonthlyData(),
    getStayRules(),
    getNotes(),
  ]);

  let rates: DailyRate[];
  let availability: Availability[];
  let history: RateHistory[];
  if (isSupabaseConfigured()) {
    [rates, availability, history] = await Promise.all([
      fetchAllRows<DailyRate>('daily_rates', 'rate_date'),
      fetchAllRows<Availability>('availability', 'avail_date'),
      fetchAllRows<RateHistory>('rate_history', 'changed_at'),
    ]);
  } else {
    rates = getLocal<DailyRate[]>(LS_RATES, []);
    availability = getLocal<Availability[]>(LS_AVAIL, []);
    history = getLocal<RateHistory[]>(LS_RATE_HISTORY, []);
  }

  // Gestione finanziaria (import dinamico: finance-api dipende da questo file).
  // Se la migrazione non è ancora stata eseguita il backup prosegue senza questi dati.
  let finance: Record<string, unknown> | null = null;
  try {
    const fin = await import('./finance-api');
    const [categories, movements, recurring, budgets, settings] = await Promise.all([
      fin.getCategories(),
      fin.getMovements(),
      fin.getRecurring(),
      fin.getBudgets(),
      fin.getSettings(),
    ]);
    finance = { categories, movements, recurring, budgets, settings };
  } catch (e) {
    console.warn('Backup: dati finanziari non disponibili', e);
  }

  const rateTiers = await getRateTiers().catch(() => null);

  const payload = {
    exportDate: new Date().toISOString(),
    source: 'Amici del San Raffaele Admin Backup',
    data: {
      apartments,
      events,
      monthlyData: monthly,
      stayRules: rules,
      notes,
      dailyRates: rates,
      availability,
      rateHistory: history,
      ...(finance ? { finance } : {}),
      ...(rateTiers ? { rateTiers } : {}),
    },
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Cella CSV sicura: neutralizza le "formule" (= + - @) che Excel/Sheets eseguirebbero
 * all'apertura (CSV injection) e raddoppia le virgolette.
 */
export function csvCell(value: string | number | null | undefined): string {
  let v = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

export async function exportMonthlyDataCSV(): Promise<string> {
  const [apartments, monthly] = await Promise.all([getApartments(), getMonthlyData()]);
  const aptMap = new Map(apartments.map((a) => [a.id, a.name]));

  const headers = ['Anno', 'Mese', 'Alloggio', 'Tasso Occupazione (%)', 'Prezzo Medio (EUR)', 'Fatturato (EUR)', 'Tipo Prezzo', 'Note'];
  const rows = monthly.map((m) => [
    m.year,
    m.month,
    csvCell(aptMap.get(m.apartment_id) || m.apartment_id),
    m.occupancy_percentage,
    m.average_price,
    m.revenue ?? '',
    m.price_definition,
    csvCell(m.notes),
  ]);

  return [headers.join(';'), ...rows.map((r) => r.join(';'))].join('\n');
}
