import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { getTemplateById, buildMappingResultFromTemplate, validateTemplateForEntity } from '@/lib/bookkeeping/booking-templates'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import { saveUserMappingRule } from '@/lib/bookkeeping/mapping-engine'
import { upsertCounterpartyTemplate, buildMappingResultFromCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  escapeLikePattern,
} from '@/lib/invoices/duplicate-payment-guard'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { Logger } from '@/lib/logger'
import type { CategorizationTemplate } from '@/types'
import { validateBody } from '@/lib/api/validate'
import { CategorizeTransactionSchema } from '@/lib/api/schemas'
import type { Transaction, TransactionCategory, EntityType } from '@/types'

ensureInitialized()

/**
 * Ensure a fiscal period exists for the given date, create one if needed.
 */
async function ensureFiscalPeriod(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  date: string,
  fiscalYearStartMonth: number,
  log: Logger,
): Promise<boolean> {
  const { data: existing } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', date)
    .gte('period_end', date)
    .eq('is_closed', false)
    .limit(1)

  if (existing && existing.length > 0) return true

  const txDate = new Date(date)
  const txMonth = txDate.getMonth() + 1
  const txYear = txDate.getFullYear()

  let periodStartYear: number
  if (fiscalYearStartMonth === 1) {
    periodStartYear = txYear
  } else if (txMonth >= fiscalYearStartMonth) {
    periodStartYear = txYear
  } else {
    periodStartYear = txYear - 1
  }

  const startMonth = String(fiscalYearStartMonth).padStart(2, '0')
  const periodStart = `${periodStartYear}-${startMonth}-01`

  const endYear = fiscalYearStartMonth === 1 ? periodStartYear : periodStartYear + 1
  const endMonth = fiscalYearStartMonth === 1 ? 12 : fiscalYearStartMonth - 1
  const lastDay = new Date(endYear, endMonth, 0).getDate()
  const periodEnd = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  const periodName = fiscalYearStartMonth === 1
    ? `Räkenskapsår ${periodStartYear}`
    : `Räkenskapsår ${periodStartYear}/${endYear}`

  const { error } = await supabase
    .from('fiscal_periods')
    .upsert({
      user_id: userId,
      company_id: companyId,
      name: periodName,
      period_start: periodStart,
      period_end: periodEnd,
    }, {
      onConflict: 'company_id,period_start,period_end',
    })

  if (error) {
    log.error('failed to create fiscal period', error)
    return false
  }

  return true
}

export const POST = withRouteContext(
  'transaction.categorize',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CategorizeTransactionSchema, {
      log,
      operation: 'transaction.categorize',
    })
    if (!validation.success) return validation.response
    const body = validation.data
    const { is_business, category } = body

    const { data: transaction, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', log, { requestId })
    }

    const txLog = log.child({ transactionId: id })

    // Already-categorized fast path: just update flags, leave the JE alone.
    if (transaction.journal_entry_id) {
      const finalCat: TransactionCategory = is_business ? (category || 'uncategorized') : 'private'

      const { error: updateErr } = await supabase
        .from('transactions')
        .update({ is_business, category: finalCat })
        .eq('id', id)

      if (updateErr) {
        txLog.error('failed to update already-categorized transaction', updateErr)
        return errorResponse(updateErr, txLog, { requestId })
      }

      return NextResponse.json({
        success: true,
        journal_entry_created: false,
        journal_entry_id: transaction.journal_entry_id,
        journal_entry_error: null,
        category: finalCat,
        already_had_journal_entry: true,
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('entity_type, fiscal_year_start_month')
      .eq('company_id', companyId)
      .single()

    const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'
    const fiscalYearStartMonth: number = settings?.fiscal_year_start_month ?? 1

    let finalCategory: TransactionCategory
    if (body.template_id) {
      const template = getTemplateById(body.template_id)
      if (!template) {
        return errorResponseFromCode('TX_CATEGORIZE_INVALID_TEMPLATE', txLog, {
          requestId,
          details: { templateId: body.template_id, reason: 'unknown_template' },
        })
      }
      const entityValidation = validateTemplateForEntity(template, entityType)
      if (!entityValidation.valid) {
        return errorResponseFromCode('TX_CATEGORIZE_INVALID_TEMPLATE', txLog, {
          requestId,
          details: { templateId: body.template_id, reason: entityValidation.error },
        })
      }
      finalCategory = is_business ? template.fallback_category : 'private'
      txLog.info('using template', {
        template: body.template_id,
        templateName: template.name_sv,
        category: finalCategory,
        debit: template.debit_account,
        credit: template.credit_account,
      })
    } else {
      finalCategory = is_business ? (category || 'uncategorized') : 'private'
      txLog.info('using category', {
        category: finalCategory,
        vatTreatment: body.vat_treatment ?? null,
        accountOverride: body.account_override ?? null,
      })
    }

    let mappingResult
    if (body.counterparty_template_id && is_business) {
      const { data: cpTemplate } = await supabase
        .from('categorization_templates')
        .select('*')
        .eq('id', body.counterparty_template_id)
        .eq('company_id', companyId)
        .eq('is_active', true)
        .maybeSingle()

      if (!cpTemplate) {
        return errorResponseFromCode('NOT_FOUND', txLog, {
          requestId,
          details: { resource: 'counterparty_template', id: body.counterparty_template_id },
        })
      }

      const match = {
        template: cpTemplate as CategorizationTemplate,
        matchMethod: 'exact_alias' as const,
        confidence: Number(cpTemplate.confidence),
      }
      mappingResult = buildMappingResultFromCounterpartyTemplate(match, transaction as Transaction, entityType)
      txLog.info('using counterparty template', {
        counterparty: cpTemplate.counterparty_name,
        lines: cpTemplate.line_pattern ? 'multi' : 'simple',
      })
    } else if (body.template_id) {
      const template = getTemplateById(body.template_id)!
      mappingResult = buildMappingResultFromTemplate(template, transaction as Transaction, entityType)
    } else {
      mappingResult = buildMappingResultFromCategory(
        finalCategory,
        transaction as Transaction,
        is_business,
        entityType,
        body.vat_treatment,
      )
    }

    txLog.info('mapping resolved', {
      debit: mappingResult.debit_account,
      credit: mappingResult.credit_account,
      allLinesComplete: mappingResult.all_lines_complete || false,
      vatLineCount: mappingResult.vat_lines.length,
    })

    if (is_business && body.account_override && !body.template_id && !body.counterparty_template_id) {
      const { data: accountExists } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_class')
        .eq('company_id', companyId)
        .eq('account_number', body.account_override)
        .single()

      if (!accountExists) {
        return errorResponseFromCode('TX_CATEGORIZE_INVALID_ACCOUNT', txLog, {
          requestId,
          details: { accountNumber: body.account_override },
        })
      }

      if (transaction.amount < 0) {
        mappingResult.debit_account = body.account_override
      } else {
        mappingResult.credit_account = body.account_override
      }

      if (accountExists.account_class === 2) {
        mappingResult.vat_lines = []
      }
    }

    if (!mappingResult.debit_account || !mappingResult.credit_account) {
      return errorResponseFromCode('TX_CATEGORIZE_INVALID_MAPPING', txLog, {
        requestId,
        details: {
          debitAccount: mappingResult.debit_account,
          creditAccount: mappingResult.credit_account,
        },
      })
    }

    if (body.confirm_no_match && /^244\d$/.test(mappingResult.debit_account)) {
      txLog.warn('supplier-invoice match suggestion bypassed', {
        reason: 'confirm_no_match=true',
        debitAccount: mappingResult.debit_account,
        creditAccount: mappingResult.credit_account,
      })
    }

    // Prong B: intercept plain 244x categorization of supplier payments when
    // an open supplier invoice already covers this amount. Categorizing direct
    // to 244x leaves the invoice with status='approved' and lures the user
    // into a duplicate "Markera som betald" later. Credit must be a bank/cash
    // account (1xxx) — 244x against a clearing account, equity, etc. isn't a
    // supplier payment and the suggestion would misdirect the user.
    if (
      !body.confirm_no_match &&
      is_business &&
      transaction.amount < 0 &&
      /^244\d$/.test(mappingResult.debit_account) &&
      /^1\d{3}$/.test(mappingResult.credit_account)
    ) {
      const txAmountAbs = Math.abs(transaction.amount)
      const windowLow = Math.round(txAmountAbs * (1 - DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100
      const windowHigh = Math.round(txAmountAbs * (1 + DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100

      let supplierIds: string[] = []
      if (transaction.merchant_name) {
        const escapedMerchant = escapeLikePattern(transaction.merchant_name)
        const { data: matchedSuppliers } = await supabase
          .from('suppliers')
          .select('id')
          .eq('company_id', companyId)
          .ilike('name', `%${escapedMerchant}%`)
          .limit(10)
        supplierIds = (matchedSuppliers || []).map((s) => s.id)
      }

      if (supplierIds.length > 0) {
        // Restrict candidates to invoices within the date window relative to
        // the bank tx date. Without this, an open invoice from years back can
        // surface as a match and misdirect the user (swedish-compliance bot).
        const txDateMs = new Date(transaction.date).getTime()
        const invoiceDateLow = new Date(txDateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
          .toISOString()
          .split('T')[0]
        const invoiceDateHigh = new Date(txDateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
          .toISOString()
          .split('T')[0]

        const { data: openInvoices } = await supabase
          .from('supplier_invoices')
          .select('id, supplier_invoice_number, invoice_date, remaining_amount, currency, supplier:suppliers(name)')
          .eq('company_id', companyId)
          .in('supplier_id', supplierIds)
          .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
          .gte('remaining_amount', windowLow)
          .lte('remaining_amount', windowHigh)
          .gte('invoice_date', invoiceDateLow)
          .lte('invoice_date', invoiceDateHigh)
          .order('invoice_date', { ascending: false })
          .limit(5)

        if (openInvoices && openInvoices.length > 0) {
          return errorResponseFromCode('TX_CATEGORIZE_SUGGEST_SI_MATCH', txLog, {
            requestId,
            details: {
              candidates: openInvoices.map((inv) => ({
                supplier_invoice_id: inv.id,
                invoice_number: inv.supplier_invoice_number,
                invoice_date: inv.invoice_date,
                remaining_amount: inv.remaining_amount,
                currency: inv.currency,
                supplier_name: (inv.supplier as { name?: string } | null)?.name ?? null,
              })),
            },
          })
        }
      }
    }

    await ensureFiscalPeriod(supabase, user.id, companyId, transaction.date, fiscalYearStartMonth, txLog)

    let journalEntryCreated = false
    let journalEntryId: string | null = null
    let journalEntryError: string | null = null
    let documentLinkWarning: string | null = null

    try {
      const journalEntry = await createTransactionJournalEntry(
        supabase,
        companyId,
        user.id,
        transaction as Transaction,
        mappingResult,
      )

      if (journalEntry) {
        journalEntryCreated = true
        journalEntryId = journalEntry.id
      }
    } catch (err) {
      txLog.error('failed to create transaction journal entry', err as Error)
      // Bookkeeping errors map to Swedish via the registry. Other errors get
      // their raw message — the categorization is preserved either way so the
      // user can still re-book the verifikation manually.
      if (isBookkeepingError(err)) {
        journalEntryError = getErrorMessage(err, { context: 'transaction' })
      } else {
        journalEntryError = err instanceof Error ? err.message : 'Unknown error'
      }
    }

    if (is_business && transaction.merchant_name) {
      try {
        await saveUserMappingRule(
          supabase,
          companyId,
          transaction.merchant_name,
          mappingResult.debit_account,
          mappingResult.credit_account,
          !is_business,
          body.user_description,
          body.template_id,
        )
      } catch (err) {
        txLog.warn('failed to save mapping rule (non-critical)', err as Error)
      }
    }

    try {
      await upsertCounterpartyTemplate(
        supabase, user.id, transaction as Transaction, mappingResult, 'user_approved',
      )
    } catch (err) {
      txLog.warn('failed to upsert counterparty template (non-critical)', err as Error)
    }

    if (journalEntryId && transaction.receipt_id) {
      try {
        const { data: receipt } = await supabase
          .from('receipts')
          .select('document_id')
          .eq('id', transaction.receipt_id)
          .single()

        if (receipt?.document_id) {
          await supabase
            .from('document_attachments')
            .update({ journal_entry_id: journalEntryId })
            .eq('id', receipt.document_id)
            .eq('company_id', companyId)
        }
      } catch (linkErr) {
        txLog.warn('failed to link receipt document (non-critical)', linkErr as Error)
      }
    } else if (journalEntryId && transaction.document_id) {
      // Document was pinned to the transaction (via /attach-document or MCP) before
      // categorization. Propagate the link to the journal entry so
      // receipt-on-verifikation (BFL 5 kap 6 §) is satisfied. The journal entry has
      // already been committed at this point, so we can't roll it back; instead
      // surface a warning in the response so the UI can prompt the user to retry
      // the link. Supabase JS returns { error } rather than throwing — destructure
      // and surface it, never swallow silently.
      try {
        const { error: linkErr } = await supabase
          .from('document_attachments')
          .update({ journal_entry_id: journalEntryId })
          .eq('id', transaction.document_id)
          .eq('company_id', companyId)
        if (linkErr) {
          txLog.error('failed to link transaction document', linkErr, {
            documentId: transaction.document_id,
          })
          documentLinkWarning =
            'Verifikationen skapades men bilagan kunde inte länkas till den. Försök länka om bilagan manuellt.'
        }
      } catch (docErr) {
        txLog.error('failed to link transaction document', docErr as Error, {
          documentId: transaction.document_id,
        })
        documentLinkWarning =
          'Verifikationen skapades men bilagan kunde inte länkas till den. Försök länka om bilagan manuellt.'
      }
    }

    if (body.inbox_item_id && journalEntryId) {
      try {
        const { data: inboxItem } = await supabase
          .from('invoice_inbox_items')
          .select('document_id')
          .eq('id', body.inbox_item_id)
          .eq('company_id', companyId)
          .single()

        if (inboxItem?.document_id) {
          await supabase
            .from('document_attachments')
            .update({ journal_entry_id: journalEntryId })
            .eq('id', inboxItem.document_id)
            .eq('company_id', companyId)
        }
      } catch (inboxErr) {
        txLog.warn('failed to link inbox document (non-critical)', inboxErr as Error)
      }
    }

    const { data: updateResult, error: updateError } = await supabase
      .from('transactions')
      .update({
        is_business,
        category: finalCategory,
        journal_entry_id: journalEntryId,
      })
      .eq('id', id)
      .is('journal_entry_id', null)
      .select('id')

    if (updateError) {
      txLog.error('failed to update transaction', updateError)
      return errorResponse(updateError, txLog, { requestId })
    }

    if ((!updateResult || updateResult.length === 0) && journalEntryId) {
      // CAS guard: another request set journal_entry_id between our read and
      // write. Cancel the orphaned entry and document the voucher gap.
      const { data: orphan } = await supabase
        .from('journal_entries')
        .select('fiscal_period_id, voucher_series, voucher_number')
        .eq('id', journalEntryId)
        .single()

      await supabase
        .from('journal_entries')
        .update({ status: 'cancelled' })
        .eq('id', journalEntryId)

      if (orphan) {
        await supabase.from('voucher_gap_explanations').insert({
          company_id: companyId,
          fiscal_period_id: orphan.fiscal_period_id,
          voucher_series: orphan.voucher_series || 'A',
          gap_number: orphan.voucher_number,
          explanation: 'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
          created_by: user.id,
        })
      }

      return errorResponseFromCode('TX_CATEGORIZE_RACE', txLog, { requestId })
    }

    await eventBus.emit({
      type: 'transaction.categorized',
      payload: {
        transaction: transaction as Transaction,
        account: mappingResult.debit_account,
        taxCode: mappingResult.vat_lines[0]?.account_number || '',
        userId: user.id,
        companyId,
      },
    })

    if (journalEntryError) {
      // Categorization stuck but the verifikation didn't make it through.
      // Surface as a structured warning — the response below carries the
      // user-facing message in `journal_entry_error`.
      txLog.warn('partial outcome: journal entry creation failed', {
        reason: 'journal_entry_creation_failed',
        message: journalEntryError,
      })
    }

    return NextResponse.json({
      success: true,
      journal_entry_created: journalEntryCreated,
      journal_entry_id: journalEntryId,
      journal_entry_error: journalEntryError,
      document_link_warning: documentLinkWarning,
      category: finalCategory,
    })
  },
  { requireWrite: true },
)
