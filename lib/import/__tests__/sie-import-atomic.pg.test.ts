import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

describe('import_sie_journal_entries RPC', () => {
  it('rolls back the journal entry header when a line insert fails', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const payload = [
      {
        sourceId: 'A1',
        series: 'A',
        date: '2026-01-15',
        description: 'Bad imported voucher',
        sourceSeries: 'A',
        sourceNumber: 1,
        sourceType: 'import',
        lines: [
          {
            account_number: '1930',
            debit_amount: 100,
            credit_amount: 0,
            currency: 'SEK',
            line_description: 'Bank',
            sort_order: 0,
          },
          {
            account_number: null,
            debit_amount: 0,
            credit_amount: 100,
            currency: 'SEK',
            line_description: 'Invalid line',
            sort_order: 1,
          },
        ],
      },
    ]

    await expect(
      getPool().query(
        `SELECT public.import_sie_journal_entries($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
        [companyId, userId, fiscalPeriodId, JSON.stringify(payload)],
      ),
    ).rejects.toThrow(/null value in column "account_number"|violates not-null constraint/i)

    const headers = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.journal_entries
        WHERE company_id = $1
          AND fiscal_period_id = $2
          AND description = 'Bad imported voucher'`,
      [companyId, fiscalPeriodId],
    )
    expect(headers.rows[0]!.count).toBe('0')

    const sequence = await getPool().query<{ last_number: number }>(
      `SELECT last_number
         FROM public.voucher_sequences
        WHERE company_id = $1
          AND fiscal_period_id = $2
          AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(sequence.rowCount).toBe(0)
  })
})
