import type {
  JournalEntry,
  Invoice,
  Transaction,
  Customer,
  Supplier,
  FiscalPeriod,
  DocumentAttachment,
  Receipt,
  CreditNote,
  ReconciliationMethod,
  InvoiceInboxItem,
  SupplierInvoice,
} from '@/types'

// ============================================================
// Core Event Types — discriminated union of all system events
// ============================================================

export type CoreEvent =
  // Bookkeeping
  | { type: 'journal_entry.drafted'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.committed'; payload: { entry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.corrected'; payload: { original: JournalEntry; storno: JournalEntry; corrected: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.reversed'; payload: { originalEntry: JournalEntry; reversalEntry: JournalEntry; userId: string; companyId: string } }
  | { type: 'journal_entry.deleted'; payload: { entryId: string; voucherSeries: string; voucherNumber: number; userId: string; companyId: string } }
  // Documents
  | { type: 'document.uploaded'; payload: { document: DocumentAttachment; userId: string; companyId: string } }
  | { type: 'document.accessed'; payload: { document: { id: string; file_name: string }; userId: string; companyId: string } }
  // Invoicing
  | { type: 'invoice.created'; payload: { invoice: Invoice; userId: string; companyId: string } }
  | { type: 'invoice.sent'; payload: { invoice: Invoice; userId: string; companyId: string } }
  | { type: 'credit_note.created'; payload: { creditNote: CreditNote; userId: string; companyId: string } }
  // Banking
  | { type: 'transaction.synced'; payload: { transactions: Transaction[]; userId: string; companyId: string } }
  | { type: 'transaction.categorized'; payload: { transaction: Transaction; account: string; taxCode: string; userId: string; companyId: string } }
  | { type: 'transaction.reconciled'; payload: { transaction: Transaction; journalEntryId: string; method: ReconciliationMethod; userId: string; companyId: string } }
  // Periods
  | { type: 'period.locked'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  | { type: 'period.unlocked'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  | { type: 'period.year_closed'; payload: { period: FiscalPeriod; userId: string; companyId: string } }
  // Customers
  | { type: 'customer.created'; payload: { customer: Customer; userId: string; companyId: string } }
  // Suppliers
  | { type: 'supplier.created'; payload: { supplier: Supplier; userId: string; companyId: string } }
  // Receipts
  | { type: 'receipt.extracted'; payload: {
      receipt: Receipt;
      documentId: string | null;
      confidence: number;
      userId: string;
      companyId: string;
    }}
  | { type: 'receipt.matched'; payload: {
      receipt: Receipt;
      transaction: Transaction;
      confidence: number;
      autoMatched: boolean;
      userId: string;
      companyId: string;
    }}
  | { type: 'receipt.confirmed'; payload: {
      receipt: Receipt;
      businessTotal: number;
      privateTotal: number;
      userId: string;
      companyId: string;
    }}
  // Supplier Invoice Lifecycle
  | { type: 'supplier_invoice.registered'; payload: { supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.approved'; payload: { supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.paid'; payload: { supplierInvoice: SupplierInvoice; paymentAmount: number; userId: string; companyId: string } }
  | { type: 'supplier_invoice.credited'; payload: { supplierInvoice: SupplierInvoice; creditNote: SupplierInvoice; userId: string; companyId: string } }
  | { type: 'supplier_invoice.uncredited'; payload: { supplierInvoice: SupplierInvoice; reversedCreditNoteId: string; reversalEntryId: string | null; userId: string; companyId: string } }
  // Payment Matching
  | { type: 'invoice.match_confirmed'; payload: { invoice: Invoice; transaction: Transaction; userId: string; companyId: string } }
  | { type: 'supplier_invoice.match_confirmed'; payload: { supplierInvoice: SupplierInvoice; transaction: Transaction; userId: string; companyId: string } }
  // Supplier Invoice Inbox
  | { type: 'supplier_invoice.received'; payload: { inboxItem: InvoiceInboxItem; userId: string; companyId: string } }
  | { type: 'supplier_invoice.extracted'; payload: { inboxItem: InvoiceInboxItem; confidence: number; userId: string; companyId: string } }
  | { type: 'supplier_invoice.confirmed'; payload: { inboxItem: InvoiceInboxItem; supplierInvoice: SupplierInvoice; userId: string; companyId: string } }
  // Salary
  | { type: 'salary_run.created'; payload: { salaryRunId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  | { type: 'salary_run.approved'; payload: { salaryRunId: string; approvedBy: string; userId: string; companyId: string } }
  | { type: 'salary_run.booked'; payload: { salaryRunId: string; entryIds: string[]; userId: string; companyId: string } }
  | { type: 'agi.generated'; payload: { agiId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  | { type: 'agi.submitted'; payload: { salaryRunId: string; periodYear: number; periodMonth: number; userId: string; companyId: string } }
  // Skatteverket — Skattekonto sync
  | { type: 'skattekonto.synced'; payload: { booked: number; upcoming: number; balanceSkv: number; balanceKfm: number; userId: string; companyId: string } }
  | { type: 'skattekonto.balance.changed'; payload: { previousBalance: number; currentBalance: number; userId: string; companyId: string } }
  | { type: 'skattekonto.transaction.upcoming'; payload: { transaktionsdatum: string; forfallodatum: string; transaktionstext: string; beloppSkatteverket: number; userId: string; companyId: string } }
  | { type: 'skattekonto.connection.expired'; payload: { reason: 'REFRESH_EXHAUSTED' | 'SESSION_EXPIRED' | 'TOKEN_CORRUPTED'; userId: string; companyId: string } }
  // Company & account lifecycle
  | { type: 'company.deleted'; payload: { companyId: string; userId: string; archivedAt: string } }
  | { type: 'account.deleted'; payload: { userId: string; deletedAt: string } }
  // MCP telemetry — fired from the MCP dispatcher.
  // Persisted to event_log (30-day TTL) for hot-tool / error-rate / latency analytics.
  // Intentionally lightweight: no args, no result body — only metadata.
  | { type: 'mcp.tool_called'; payload: {
      tool: string                                  // e.g. 'gnubok_create_invoice'
      requiredScope: string | null                  // from TOOL_SCOPE_MAP, null if unscoped
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null                        // api_key id, oauth client, etc.
      actorLabel: string | null                     // human-readable actor label
      latencyMs: number                             // wall-clock time inside execute()
      success: boolean                              // true iff the tool returned without throwing AND was invoked (not denied)
      isError: boolean                              // matches the JSON-RPC tool-result isError flag returned to the client
      errorCode: string | null                      // structured error code from tool-result.toToolError when applicable
      errorKind: 'execution' | 'scope_denied' | 'unknown_tool' | null
      requestId: string | number | null             // JSON-RPC request id (helps correlate with client-side logs)
      userId: string
      companyId: string
    }}
  // tools/list — informs us whether agents are using progressive discovery
  // (gnubok_search_tools) or pulling the full list. Tool counts vary with
  // the caller's scope set.
  | { type: 'mcp.tools_list_called'; payload: {
      toolCount: number                             // tools actually returned (post scope filter)
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null
      actorLabel: string | null
      latencyMs: number
      requestId: string | number | null
      userId: string
      companyId: string
    }}
  // resources/read — informs us which skills/widgets/data resources actually
  // get loaded by agents. `kind` discriminates by URI scheme so we can
  // GROUP BY skill vs widget vs data without parsing URIs.
  | { type: 'mcp.resource_read'; payload: {
      uri: string                                   // e.g. 'gnubok://skill/month-end-close'
      kind: 'widget' | 'skill' | 'data' | 'unknown'
      success: boolean
      errorCode: string | null
      latencyMs: number
      actorType: 'user' | 'api_key' | 'mcp_oauth' | 'cron'
      actorId: string | null
      actorLabel: string | null
      requestId: string | number | null
      userId: string
      companyId: string
    }}

// ============================================================
// Helper Types
// ============================================================

/** All possible event type strings */
export type CoreEventType = CoreEvent['type']

/** Extract the payload type for a given event type */
export type EventPayload<T extends CoreEventType> = Extract<CoreEvent, { type: T }>['payload']

/** Handler function for a specific event type */
export type EventHandler<T extends CoreEventType> = (payload: EventPayload<T>) => Promise<void> | void

/** Subscription: event type + handler */
export interface EventSubscription<T extends CoreEventType = CoreEventType> {
  eventType: T
  handler: EventHandler<T>
}
