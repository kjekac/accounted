import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Covers the Fortnox re-sync flow:
//  1. The partial unique index `sie_imports_company_id_file_hash_active_idx`
//     (added in migration 20260517150000) blocks duplicate (company_id,
//     file_hash) rows for active statuses but allows them once a prior row
//     is marked 'replaced' or 'failed'.
//  2. The replace_sie_import RPC cancels journal entries with
//     source_type='import' while leaving user-created entries
//     (source_type='manual', 'bank_transaction', etc.) intact.

async function insertSIEImport(params: {
  companyId: string
  userId: string
  fileHash: string
  status: 'pending' | 'mapped' | 'completed' | 'failed' | 'replaced'
  fiscalPeriodId?: string
  openingBalanceEntryId?: string
  fiscalYearStart?: string
  fiscalYearEnd?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, accounts_count, transactions_count,
        status, fiscal_period_id, opening_balance_entry_id, imported_at)
     VALUES ($1, $2, $3, 'fortnox-export.se', $4, 4,
             $5, $6, 0, 0,
             $7, $8, $9, $10)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fileHash,
      params.fiscalYearStart ?? '2026-01-01',
      params.fiscalYearEnd ?? '2026-12-31',
      params.status,
      params.fiscalPeriodId ?? null,
      params.openingBalanceEntryId ?? null,
      params.status === 'completed' ? new Date().toISOString() : null,
    ],
  )
  return id
}

async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  sourceType: 'import' | 'manual' | 'bank_transaction'
  voucherNumber: number
  entryDate?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Test entry', $7, 'posted')`,
    [
      id,
      params.userId,
      params.companyId,
      params.fiscalPeriodId,
      params.voucherNumber,
      params.entryDate ?? '2026-06-01',
      params.sourceType,
    ],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', 100, 0),
            ($1, '3001', 0, 100)`,
    [id],
  )
  return id
}

describe('sie_imports: partial unique index + replace flow', () => {
  it('blocks a second active row with the same (company_id, file_hash)', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    await expect(
      insertSIEImport({
        companyId,
        userId,
        fileHash: hash,
        status: 'pending',
        fiscalPeriodId,
      }),
    ).rejects.toThrow(/sie_imports_company_id_file_hash_active_idx/)
  })

  it('allows a new pending row with the same hash once the prior row is replaced', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`

    const priorId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'completed',
      fiscalPeriodId,
    })

    // Mark the prior row as replaced (simulating what replace_sie_import does)
    await getPool().query(
      `UPDATE public.sie_imports SET status = 'replaced', replaced_at = now() WHERE id = $1`,
      [priorId],
    )

    // A new pending row with the same hash now succeeds
    const newId = await insertSIEImport({
      companyId,
      userId,
      fileHash: hash,
      status: 'pending',
      fiscalPeriodId,
    })
    expect(newId).toBeTruthy()
  })

  it('replace_sie_import cancels source_type=import entries and leaves manual/bank_transaction entries posted', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()

    const obEntry = await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'import',
      voucherNumber: 1,
    })
    const importEntry1 = await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'import',
      voucherNumber: 2,
    })
    const importEntry2 = await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'import',
      voucherNumber: 3,
    })
    const manualEntry = await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'manual',
      voucherNumber: 4,
    })
    const txnEntry = await insertPostedEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'bank_transaction',
      voucherNumber: 5,
    })

    const importId = await insertSIEImport({
      companyId,
      userId,
      fileHash: `hash-${randomUUID()}`,
      status: 'completed',
      fiscalPeriodId,
      openingBalanceEntryId: obEntry,
    })

    const { rows } = await getPool().query<{ replace_sie_import: number }>(
      `SELECT public.replace_sie_import($1::uuid, $2::uuid) AS replace_sie_import`,
      [companyId, importId],
    )
    const cancelled = rows[0]!.replace_sie_import

    // OB entry + 2 import entries = 3 cancelled. Manual & transaction stay posted.
    expect(cancelled).toBe(3)

    const statuses = await getPool().query<{ id: string; status: string }>(
      `SELECT id, status FROM public.journal_entries WHERE id = ANY($1)`,
      [[obEntry, importEntry1, importEntry2, manualEntry, txnEntry]],
    )
    const statusById = Object.fromEntries(statuses.rows.map(r => [r.id, r.status]))
    expect(statusById[obEntry]).toBe('cancelled')
    expect(statusById[importEntry1]).toBe('cancelled')
    expect(statusById[importEntry2]).toBe('cancelled')
    expect(statusById[manualEntry]).toBe('posted')
    expect(statusById[txnEntry]).toBe('posted')

    const importRow = await getPool().query<{ status: string; replaced_at: string | null }>(
      `SELECT status, replaced_at FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(importRow.rows[0]!.status).toBe('replaced')
    expect(importRow.rows[0]!.replaced_at).not.toBeNull()
  })
})
