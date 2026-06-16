import InvoiceEditor from '@/components/invoices/InvoiceEditor'

// The invoice creator lives in the shared <InvoiceEditor> component so the same
// form powers both creating a new invoice and editing an existing draft
// (app/(dashboard)/invoices/[id]/edit).
export default function NewInvoicePage() {
  return <InvoiceEditor mode="create" />
}
