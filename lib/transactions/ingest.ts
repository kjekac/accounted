import type { SupabaseClient } from '@supabase/supabase-js'
import { evaluateMappingRules } from '@/lib/bookkeeping/mapping-engine'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { getBestInvoiceMatch } from '@/lib/invoices/invoice-matching'
import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { Transaction, RawTransaction, IngestResult, IngestOptions, SupplierInvoice, Currency, ExchangeRate } from '@/types'

// Re-export types for backward compatibility
export type { RawTransaction, IngestResult } from '@/types'

interface ExistingTransactionMaps {
  /** Booked transactions (any source) — consumed by any incoming raw transaction. */
  booked: Map<string, number>
  /**
   * Unbooked enable_banking transactions — consumed by any incoming raw
   * transaction regardless of source. Catches two cases: PSD2 reconnect
   * duplicates (external_id regenerated, same tx already pending) AND
   * CSV imports overlapping an active PSD2 sync (same Lunar/etc tx arriving
   * twice, once via PSD2 and once via file upload).
   */
  unbookedEnableBanking: Map<string, number>
}

/**
 * Stable content-dedup key. Includes a normalized description prefix so the
 * two-tuple (date, amount) doesn't false-positive across unrelated transfers
 * that happen to share a date and amount. Lunar's CSV "Text" column and
 * PSD2's `description || counterparty_name` (see enable-banking/lib/sync.ts)
 * agree well enough in practice for the same underlying transaction.
 */
function contentDedupKey(date: string, amount: number | string, description: string | null | undefined): string {
  const descPrefix = (description || '').toLowerCase().trim().slice(0, 24)
  return `${date}|${amount}|${descPrefix}`
}

async function buildExistingTransactionMaps(
  supabase: SupabaseClient,
  companyId: string,
  rawTransactions: RawTransaction[]
): Promise<ExistingTransactionMaps> {
  const booked = new Map<string, number>()
  const unbookedEnableBanking = new Map<string, number>()
  if (rawTransactions.length === 0) return { booked, unbookedEnableBanking }

  const dates = rawTransactions.map((t) => t.date).sort()
  const dateFrom = dates[0]
  const dateTo = dates[dates.length - 1]

  try {
    const { data: bookedRows } = await supabase
      .from('transactions')
      .select('date, amount, description')
      .eq('company_id', companyId)
      .not('journal_entry_id', 'is', null)
      .gte('date', dateFrom)
      .lte('date', dateTo)

    if (bookedRows) {
      for (const tx of bookedRows) {
        const key = contentDedupKey(tx.date, tx.amount, tx.description)
        booked.set(key, (booked.get(key) || 0) + 1)
      }
    }
  } catch {
    // Non-critical — content-based dedup will be skipped
  }

  try {
    const { data: unbookedBank } = await supabase
      .from('transactions')
      .select('date, amount, description')
      .eq('company_id', companyId)
      .is('journal_entry_id', null)
      .eq('import_source', 'enable_banking')
      .gte('date', dateFrom)
      .lte('date', dateTo)

    if (unbookedBank) {
      for (const tx of unbookedBank) {
        const key = contentDedupKey(tx.date, tx.amount, tx.description)
        unbookedEnableBanking.set(key, (unbookedEnableBanking.get(key) || 0) + 1)
      }
    }
  } catch {
    // Non-critical — reconnect dedup will be skipped
  }

  return { booked, unbookedEnableBanking }
}

/**
 * Generic transaction ingestion pipeline.
 *
 * Handles:
 * 1. Deduplication via external_id
 * 1b. Content-based dedup (date+amount+description prefix) against already-booked
 *     transactions — catches cross-source duplicates, e.g. PSD2 row gets booked
 *     before the user later re-imports the same period via CSV.
 * 1c. Content-based dedup against unbooked enable_banking rows — catches PSD2
 *     reconnect duplicates AND CSV imports overlapping an active PSD2 sync (the
 *     description-prefix component makes this safe to apply across sources).
 * 2. Insert into transactions table
 * 3. OCR/reference-based invoice matching (highest confidence)
 * 4. Amount+customer fallback invoice matching
 * 5. Mapping rule evaluation for auto-categorization
 * 6. Auto-journal-entry creation for high-confidence matches
 *
 * Used by both bank file import and Enable Banking PSD2 sync.
 */
export async function ingestTransactions(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  rawTransactions: RawTransaction[],
  options?: IngestOptions
): Promise<IngestResult> {
  const result: IngestResult = {
    imported: 0,
    duplicates: 0,
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 0,
    errors: 0,
    transaction_ids: [],
  }

  // Pre-fetch existing transactions for content-based dedup
  // (date+amount+description prefix). Booked rows catch cross-source
  // duplicates after they've been booked; unbooked enable_banking rows
  // catch the more common case where a PSD2 row is still pending in the
  // inbox when the user re-imports the same period via CSV.
  const existingMaps = await buildExistingTransactionMaps(supabase, companyId, rawTransactions)

  // When rawInsertOnly is set (viewer imports), skip pre-fetching supplier
  // invoices and exchange rates — they are not used.
  let unpaidSupplierInvoices: SupplierInvoice[] = []
  // Keyed by `${currency}|${date}` so each non-SEK transaction gets the
  // rate that was valid on its own transaction date, not the import date.
  const exchangeRatesByDate = new Map<string, ExchangeRate>()

  if (!options?.rawInsertOnly) {
  // Pre-fetch unpaid supplier invoices for expense matching (non-critical)
  try {
    unpaidSupplierInvoices = await fetchAllRows<SupplierInvoice>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('*, supplier:suppliers(*)')
        .eq('company_id', companyId)
        .in('status', ['registered', 'approved'])
        .gt('remaining_amount', 0)
        .range(from, to)
    )
  } catch {
    // Non-critical — supplier invoice matching will be skipped
  }
  }

  // Pre-fetch exchange rates for each unique (currency, date) pair in the
  // batch. Riksbanken publishes a per-day rate; using one batched fetch with
  // no date stamps every row at today's rate, which is wrong for historical
  // imports (issue #442). fetchExchangeRate already falls back to the last
  // 7 days when the requested day is a weekend/holiday.
  if (!options?.rawInsertOnly) {
    const uniquePairs = new Map<string, { currency: Currency; date: string }>()
    for (const t of rawTransactions) {
      if (t.currency && t.currency !== 'SEK' && t.date) {
        const key = `${t.currency}|${t.date}`
        if (!uniquePairs.has(key)) {
          uniquePairs.set(key, { currency: t.currency as Currency, date: t.date })
        }
      }
    }

    if (uniquePairs.size > 0) {
      const pairs = Array.from(uniquePairs.entries())
      const settled = await Promise.allSettled(
        pairs.map(([, { currency, date }]) =>
          fetchExchangeRate(currency, new Date(date))
        )
      )
      for (let i = 0; i < pairs.length; i++) {
        const [key] = pairs[i]
        const outcome = settled[i]
        if (outcome.status === 'fulfilled' && outcome.value) {
          exchangeRatesByDate.set(key, outcome.value)
        }
        // Network failures resolve inside fetchExchangeRate to getFallbackRate()
        // (non-null, today's date), so they still populate the key. The key
        // only stays unset when the API returns an empty observation array
        // or the promise rejects outright — in that case amount_sek and
        // exchange_rate remain null on the inserted transaction.
      }
    }
  }

  // Pre-fetch existing external_ids in batches for dedup (avoids N+1 queries)
  const existingExternalIds = new Set<string>()
  const externalIds = rawTransactions.map(t => t.external_id)
  for (let i = 0; i < externalIds.length; i += 500) {
    const chunk = externalIds.slice(i, i + 500)
    const { data } = await supabase
      .from('transactions')
      .select('external_id')
      .eq('company_id', companyId)
      .in('external_id', chunk)
    data?.forEach(r => existingExternalIds.add(r.external_id))
  }

  // Track already-matched invoice IDs within this ingestion batch
  // to prevent suggesting the same invoice for multiple transactions
  const matchedInvoiceIds = new Set<string>()
  const matchedSupplierInvoiceIds = new Set<string>()

  for (const raw of rawTransactions) {
    // 1. Check for duplicates via external_id (batch pre-fetched)
    if (existingExternalIds.has(raw.external_id)) {
      result.duplicates++
      continue
    }

    // 1b. Content-based dedup: skip if an already-booked transaction
    // exists with the same date, amount, and description prefix.
    const contentKey = contentDedupKey(raw.date, raw.amount, raw.description)
    const bookedCount = existingMaps.booked.get(contentKey) || 0
    if (bookedCount > 0) {
      existingMaps.booked.set(contentKey, bookedCount - 1)
      result.duplicates++
      continue
    }

    // 1c. Overlap dedup: skip if an unbooked enable_banking row already
    // exists with the same (date, amount, description prefix). Applies to
    // any incoming source — PSD2 reconnects, CSV imports over an active
    // PSD2 sync, etc. Description prefix prevents unrelated transfers from
    // colliding on (date, amount) alone.
    const unbookedEbCount = existingMaps.unbookedEnableBanking.get(contentKey) || 0
    if (unbookedEbCount > 0) {
      existingMaps.unbookedEnableBanking.set(contentKey, unbookedEbCount - 1)
      result.duplicates++
      continue
    }

    // 2. Insert new transaction (with SEK conversion for foreign currencies)
    const rateInfo = raw.currency && raw.currency !== 'SEK'
      ? exchangeRatesByDate.get(`${raw.currency}|${raw.date}`)
      : undefined
    const amountSek = rateInfo
      ? Math.round(raw.amount * rateInfo.rate * 100) / 100
      : null

    const { data: newTransaction, error: insertError } = await supabase
      .from('transactions')
      .insert({
        company_id: companyId,
        user_id: userId,
        bank_connection_id: raw.bank_connection_id || null,
        external_id: raw.external_id,
        date: raw.date,
        description: raw.description,
        amount: raw.amount,
        currency: raw.currency,
        amount_sek: amountSek,
        exchange_rate: rateInfo?.rate ?? null,
        exchange_rate_date: rateInfo?.date ?? null,
        category: 'uncategorized',
        is_business: null,
        mcc_code: raw.mcc_code || null,
        merchant_name: raw.merchant_name || null,
        reference: raw.reference || null,
        import_source: raw.import_source || null,
        counterparty_iban: raw.counterparty_iban || null,
        counterparty_account: raw.counterparty_account || null,
      })
      .select()
      .single()

    if (insertError || !newTransaction) {
      result.errors++
      if (!result.first_error && insertError) {
        result.first_error = {
          message: insertError.message,
          code: insertError.code ?? null,
          details: insertError.details ?? null,
          hint: insertError.hint ?? null,
        }
      }
      continue
    }

    result.imported++
    result.transaction_ids.push(newTransaction.id)

    // rawInsertOnly: skip invoice matching, and auto-categorization
    if (options?.rawInsertOnly) continue

    // Reconciliation against existing GL lines is intentionally NOT run on
    // import — auto-linking made imported transactions appear "bokförda" to
    // the user without any explicit action. Reconciliation is now a manual
    // operation (BankReconciliationView / runReconciliation / manualLink).

    // 3. For income transactions, try invoice matching
    if (newTransaction.amount > 0) {
      try {
        // OCR/reference matching is handled inside getBestInvoiceMatch
        // (which calls findMatchingInvoices, which now checks references)
        const bestMatch = await getBestInvoiceMatch(
          supabase,
          companyId,
          newTransaction as Transaction,
          0.50
        )

        if (bestMatch && !matchedInvoiceIds.has(bestMatch.invoice.id)) {
          await supabase
            .from('transactions')
            .update({ potential_invoice_id: bestMatch.invoice.id })
            .eq('id', newTransaction.id)

          logMatchEvent(supabase, userId, newTransaction.id, 'auto_suggested', {
            invoiceId: bestMatch.invoice.id,
            matchConfidence: bestMatch.confidence,
            matchMethod: bestMatch.matchReason,
          })

          matchedInvoiceIds.add(bestMatch.invoice.id)
          result.auto_matched_invoices++
          // Skip mapping engine — transaction has an invoice match.
          // Auto-categorization would create an orphaned journal entry
          // that conflicts with the eventual invoice payment entry.
          continue
        }
      } catch {
        // Non-critical — continue processing
      }
    }

    // 3b. For expense transactions, try supplier invoice matching
    if (newTransaction.amount < 0 && unpaidSupplierInvoices.length > 0) {
      try {
        const match = findSupplierInvoiceMatch(
          newTransaction as Transaction,
          unpaidSupplierInvoices
        )

        if (match && !matchedSupplierInvoiceIds.has(match.supplierInvoice.id)) {
          if (match.confidence >= 0.85) {
            // Auto-link at high confidence
            await supabase
              .from('transactions')
              .update({ supplier_invoice_id: match.supplierInvoice.id })
              .eq('id', newTransaction.id)

            // Log the match THEN drain the pool (captures which invoice was matched)
            logMatchEvent(supabase, userId, newTransaction.id, 'auto_suggested', {
              supplierInvoiceId: match.supplierInvoice.id,
              matchConfidence: match.confidence,
              matchMethod: match.matchMethod,
            })

            // Drain the pool — prevents next transaction from matching same invoice
            unpaidSupplierInvoices = unpaidSupplierInvoices.filter(
              inv => inv.id !== match.supplierInvoice.id
            )
            matchedSupplierInvoiceIds.add(match.supplierInvoice.id)

            result.auto_matched_invoices++
            // Skip mapping engine — transaction has a supplier invoice match
            continue
          } else {
            // Store as suggestion at lower confidence (0.70–0.85)
            // Do NOT drain pool for suggestions — they are tentative
            await supabase
              .from('transactions')
              .update({ potential_supplier_invoice_id: match.supplierInvoice.id })
              .eq('id', newTransaction.id)

            logMatchEvent(supabase, userId, newTransaction.id, 'auto_suggested', {
              supplierInvoiceId: match.supplierInvoice.id,
              matchConfidence: match.confidence,
              matchMethod: match.matchMethod,
            })
          }
        }
      } catch {
        // Non-critical — continue processing
      }
    }

    // 4. Evaluate mapping rules for auto-categorization
    // Production-disabled: auto-booking only runs in local dev (and tests).
    // Users must explicitly book each transaction on the deployed app.
    // Reconciliation (step 2.5) still links transactions to existing GL lines.
    const autoBookEnabled = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
    if (autoBookEnabled && !options?.skipAutoCategorization) {
      try {
        const mappingResult = await evaluateMappingRules(
          supabase,
          companyId,
          newTransaction as Transaction,
          undefined,
          options?.settlementAccount
        )

        if (mappingResult.confidence >= 0.8 && !mappingResult.requires_review) {
          const journalEntry = await createTransactionJournalEntry(
            supabase,
            companyId,
            userId,
            newTransaction as Transaction,
            mappingResult
          )

          if (journalEntry) {
            await supabase
              .from('transactions')
              .update({
                journal_entry_id: journalEntry.id,
                is_business: !mappingResult.default_private,
              })
              .eq('id', newTransaction.id)

            // Upsert counterparty template (auto-learned, lower confidence)
            try {
              await upsertCounterpartyTemplate(
                supabase, companyId, newTransaction as Transaction,
                mappingResult, 'auto_learned'
              )
            } catch {
              // Non-critical
            }

            result.auto_categorized++
          }
        }
      } catch {
        // Non-critical — continue processing
      }
    }
  }

  return result
}
