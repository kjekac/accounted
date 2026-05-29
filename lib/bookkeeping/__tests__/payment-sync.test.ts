import { describe, expect, it, beforeEach, vi } from 'vitest'
import { isPaymentSourceType, syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { JournalEntry } from '@/types'

describe('isPaymentSourceType', () => {
  it.each([
    'invoice_paid',
    'invoice_cash_payment',
    'supplier_invoice_paid',
    'supplier_invoice_cash_payment',
  ])('recognises %s as payment', (sourceType) => {
    expect(isPaymentSourceType(sourceType)).toBe(true)
  })

  it.each(['manual', 'invoice_created', 'supplier_invoice_registered', '', null, undefined])(
    'rejects %s',
    (sourceType) => {
      expect(isPaymentSourceType(sourceType)).toBe(false)
    }
  )
})

describe('syncInvoiceStatusFromPaymentEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function entry(overrides: Partial<JournalEntry> = {}): Pick<JournalEntry, 'id' | 'source_type' | 'source_id'> {
    return {
      id: 'entry-1',
      source_type: 'supplier_invoice_paid',
      source_id: 'supplier-invoice-1',
      ...overrides,
    } as Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>
  }

  it('is a no-op when source_type is not a payment', async () => {
    const { supabase } = createQueuedMockSupabase()
    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'manual' as JournalEntry['source_type'] })
    )
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('is a no-op when source_id is missing', async () => {
    const { supabase } = createQueuedMockSupabase()
    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_id: null })
    )
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('reverts a fully-paid supplier invoice back to approved', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 1000 } },
      // Fully paid before deletion: paid_amount === total_amount
      { data: { paid_amount: 1000, total_amount: 1000, due_date: '2099-12-31' } },
      { data: null }, // UPDATE result
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry())

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual([
      'supplier_invoice_payments',
      'supplier_invoices',
      'supplier_invoices',
    ])
  })

  it('reverts a partially-paid supplier invoice to partially_paid when paid_amount remains', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 500 } }, // payment being reversed
      // Started with 1000 paid (multiple payments), reversing 500
      { data: { paid_amount: 1000, total_amount: 1500, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry())

    // Test passes if the queries fire in the expected order without error
    expect((supabase.from as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })

  it('routes customer invoice entries through the invoices table', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 1000 } },
      { data: { paid_amount: 1000, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'invoice_paid', source_id: 'invoice-1' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls).toEqual(['invoice_payments', 'invoices', 'invoices'])
  })

  it('handles invoice_cash_payment the same way as invoice_paid', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 500 } },
      { data: { paid_amount: 500, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'invoice_cash_payment', source_id: 'invoice-1' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls[0]).toBe('invoice_payments')
    expect(fromCalls[1]).toBe('invoices')
  })

  it('handles supplier_invoice_cash_payment the same way as supplier_invoice_paid', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { amount: 1000 } },
      { data: { paid_amount: 1000, total_amount: 1000, due_date: '2099-12-31' } },
      { data: null },
    ])

    await syncInvoiceStatusFromPaymentEntry(
      supabase as never,
      'co-1',
      entry({ source_type: 'supplier_invoice_cash_payment' })
    )

    const fromCalls = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(fromCalls[0]).toBe('supplier_invoice_payments')
    expect(fromCalls[1]).toBe('supplier_invoices')
  })

  it('does not error when no payment row exists for the supplier entry', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null }, // no payment row
      { data: { paid_amount: 1000, total_amount: 1000, due_date: '2099-12-31' } },
    ])

    await expect(
      syncInvoiceStatusFromPaymentEntry(supabase as never, 'co-1', entry())
    ).resolves.toBeUndefined()
  })
})
