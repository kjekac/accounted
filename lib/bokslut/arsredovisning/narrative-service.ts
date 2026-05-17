import type { SupabaseClient } from '@supabase/supabase-js'

export interface NarrativeOverrides {
  description: string | null
  important_events: string | null
  resultatdisposition: string | null
  /** ISO date of the AGM (årsstämma) where the årsredovisning was adopted.
   *  Populates the fastställelseintyg date blank — without it the PDF
   *  cannot be filed at Bolagsverket without manual pen-and-ink edit. */
  agm_date: string | null
}

/**
 * Shape returned from getNarrative / upsertNarrative. user_id and
 * created_at are deliberately excluded from the API projection (see
 * NARRATIVE_API_COLUMNS below).
 */
export interface NarrativeRow {
  id: string
  company_id: string
  fiscal_period_id: string
  description: string | null
  important_events: string | null
  resultatdisposition: string | null
  agm_date: string | null
  updated_at: string
}

const TABLE = 'arsredovisning_narratives'

// Explicit projection — keeps user_id and other internal audit fields out
// of API responses. GDPR Art.25.2 / ISO A.8.3 data-minimization: callers
// only need the narrative content + last-updated timestamp.
const NARRATIVE_API_COLUMNS =
  'id, company_id, fiscal_period_id, description, important_events, resultatdisposition, agm_date, updated_at'

/**
 * Load persisted narrative overrides for a fiscal period. Returns null when
 * the user hasn't customised anything yet — caller then falls back to the
 * auto-generated boilerplate in buildArsredovisningData.
 */
export async function getNarrative(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<NarrativeRow | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(NARRATIVE_API_COLUMNS)
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load narrative: ${error.message}`)
  return (data as NarrativeRow | null) ?? null
}

/**
 * Upsert narrative overrides for a fiscal period. Composite UNIQUE constraint
 * (company_id, fiscal_period_id) — see migration
 * 20260517160000_narrative_agm_date_and_composite_unique.sql — makes the
 * onConflict path resolve to an UPDATE within the same tenant, so repeated
 * saves cleanly replace prior content instead of stacking rows.
 */
export async function upsertNarrative(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  input: Partial<NarrativeOverrides>,
): Promise<NarrativeRow> {
  const payload = {
    user_id: userId,
    company_id: companyId,
    fiscal_period_id: fiscalPeriodId,
    description: input.description ?? null,
    important_events: input.important_events ?? null,
    resultatdisposition: input.resultatdisposition ?? null,
    agm_date: input.agm_date ?? null,
  }
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'company_id,fiscal_period_id' })
    .select(NARRATIVE_API_COLUMNS)
    .single()
  if (error || !data) {
    throw new Error(`Failed to save narrative: ${error?.message ?? 'unknown'}`)
  }
  return data as NarrativeRow
}
