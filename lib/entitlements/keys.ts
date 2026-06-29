/**
 * Capability keys — the single namespace behind the SaaS paywall AND the
 * per-tenant modularity / marketplace vision. Each key names one gateable
 * feature; a company "has" it when an unexpired capability_grant exists
 * (entitlement) and it isn't explicitly disabled (enablement).
 *
 * These keys are a STABLE CONTRACT: grant rows, the future marketplace catalog,
 * and per-tenant module toggles all reference them. Add keys; never rename one.
 */
export const CAPABILITY = {
  /** AI assistant chat, onboarding composer, and document field extraction (Anthropic/Bedrock). */
  ai: 'ai',
  /** Bank sync / PSD2 (Enable Banking). Freeze-and-retain: tokens are NOT revoked on downgrade. */
  bank_sync: 'bank_sync',
  /** Skatteverket filing/sync — VAT, AGI, skattekonto — via BankID. */
  skatteverket: 'skatteverket',
  /** Outbound transactional email: invoices, reminders, payslips (Resend). Auth/account email is never gated. */
  email_send: 'email_send',
  /** Org-number lookup / enrichment (TIC). NOT gated — identity/lookup is always free. */
  org_lookup: 'org_lookup',
  /** EU VAT-number validation (VIES). NOT gated — identity/lookup is always free. */
  vat_validation: 'vat_validation',
  /** Riksbanken FX auto-fetch. NOT gated at launch (kept free); manual rate entry is always allowed. */
  currency_rates: 'currency_rates',
  /** Cloud backup to Google Drive. NOT gated at launch (kept free — never hold a customer's data hostage). */
  cloud_backup: 'cloud_backup',
  /** Migration import from other systems (Fortnox/Visma/Bokio/BL/Briox). Kept open so new payers can migrate IN. */
  migration: 'migration',
  /** Bolagsverket iXBRL årsredovisning filing. Reserved (extension not yet enabled). */
  bolagsverket: 'bolagsverket',
} as const

export type CapabilityKey = (typeof CAPABILITY)[keyof typeof CAPABILITY]

/**
 * The set actually withheld from non-payers (manual tier) at the 2026-07-07
 * cutover. Founder decision (2026-06-28): gate the high-value recurring external
 * services only.
 *
 * KEPT FREE on purpose:
 *   - identity & lookup: TIC org_lookup, VIES vat_validation, BankID login —
 *     they aid onboarding/data quality; gating them is friction in the wrong place.
 *   - currency_rates (FX auto-fetch) and cloud_backup.
 * Internal bookkeeping is always fully usable on the manual tier.
 *
 * NOTE: bank_sync and skatteverket stay PAID even though their flows use BankID
 * as an auth step — what's charged for is the bank data sync and the VAT/AGI
 * filing service, not the identity check.
 */
export const PAID_CAPABILITIES: readonly CapabilityKey[] = [
  CAPABILITY.ai,
  CAPABILITY.bank_sync,
  CAPABILITY.skatteverket,
  CAPABILITY.email_send,
] as const
