import type { Invoice, Customer, CompanySettings, InvoiceDocumentType } from '@/types'
import { formatCurrency, formatDate, getCompanyDisplayName, getCompanyPrimaryName } from '@/lib/utils'

function getDocumentLabel(invoice: Invoice): string {
  if (invoice.credited_invoice_id) return 'Kreditfaktura'
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  if (docType === 'proforma') return 'Proformafaktura'
  if (docType === 'delivery_note') return 'Följesedel'
  return 'Faktura'
}

export interface InvoiceEmailData {
  invoice: Invoice
  customer: Customer
  company: CompanySettings
}

/**
 * Generate HTML email for sending an invoice
 */
export function generateInvoiceEmailHtml(data: InvoiceEmailData): string {
  const { invoice, customer, company } = data

  const documentType = getDocumentLabel(invoice)
  const isCreditNote = !!invoice.credited_invoice_id
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'
  const isProforma = docType === 'proforma'
  const hidePayment = isCreditNote || isDeliveryNote || isProforma

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${documentType} ${invoice.invoice_number}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <!-- Header -->
    <div style="margin-bottom: 30px;">
      <h1 style="margin: 0 0 10px 0; font-size: 24px; font-weight: 600; color: #111;">
        ${documentType} från ${getCompanyPrimaryName(company)}
      </h1>
      <p style="margin: 0; color: #666; font-size: 14px;">
        ${documentType}nummer: ${invoice.invoice_number}
      </p>
    </div>

    <!-- Greeting -->
    <div style="margin-bottom: 30px;">
      <p style="margin: 0 0 15px 0;">
        Hej${customer.name ? ` ${customer.name.split(' ')[0]}` : ''},
      </p>
      <p style="margin: 0;">
        ${isCreditNote
          ? `Bifogat hittar du en kreditfaktura som korrigerar en tidigare faktura.`
          : `Tack för ditt förtroende! Bifogat hittar du din faktura.`
        }
      </p>
    </div>

    <!-- Invoice Summary Box -->
    <div style="background: #f8f9fa; border-radius: 8px; padding: 25px; margin-bottom: 30px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">${documentType}nummer:</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500;">${invoice.invoice_number}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">${documentType}datum:</td>
          <td style="padding: 8px 0; text-align: right;">${formatDate(invoice.invoice_date)}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">Förfallodatum:</td>
          <td style="padding: 8px 0; text-align: right; font-weight: 500; color: ${isCreditNote ? '#333' : '#e11d48'};">
            ${formatDate(invoice.due_date)}
          </td>
        </tr>
        <tr>
          <td colspan="2" style="padding: 15px 0 8px 0; border-top: 1px solid #e5e7eb;"></td>
        </tr>
        <tr>
          <td style="padding: 8px 0; font-size: 18px; font-weight: 600;">Att betala:</td>
          <td style="padding: 8px 0; text-align: right; font-size: 18px; font-weight: 600; color: ${isCreditNote ? '#059669' : '#111'};">
            ${formatCurrency(invoice.total, invoice.currency)}
          </td>
        </tr>
      </table>
    </div>

    <!-- Payment Details -->
    ${!hidePayment ? `
    <div style="margin-bottom: 30px;">
      <h2 style="margin: 0 0 15px 0; font-size: 16px; font-weight: 600; color: #111;">
        Betalningsinformation
      </h2>
      <table style="width: 100%; border-collapse: collapse;">
        ${company.bank_name ? `
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px; width: 140px;">Bank:</td>
          <td style="padding: 6px 0;">${company.bank_name}</td>
        </tr>
        ` : ''}
        ${company.clearing_number && company.account_number ? `
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px;">Kontonummer:</td>
          <td style="padding: 6px 0;">${company.clearing_number}-${company.account_number}</td>
        </tr>
        ` : ''}
        ${company.iban ? `
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px;">IBAN:</td>
          <td style="padding: 6px 0;">${company.iban}</td>
        </tr>
        ` : ''}
        ${company.bic ? `
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px;">BIC/SWIFT:</td>
          <td style="padding: 6px 0;">${company.bic}</td>
        </tr>
        ` : ''}
        <tr>
          <td style="padding: 6px 0; color: #666; font-size: 14px;">Meddelande:</td>
          <td style="padding: 6px 0; font-weight: 500;">${invoice.invoice_number}</td>
        </tr>
      </table>
    </div>
    ` : ''}

    <!-- Footer -->
    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
      <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">
        Har du frågor om fakturan? Svara direkt på detta mejl så hjälper vi dig.
      </p>
      <p style="margin: 0; color: #666; font-size: 14px;">
        Med vänliga hälsningar,<br>
        <strong>${getCompanyPrimaryName(company)}</strong>
      </p>
      ${company.org_number ? `
      <p style="margin: 10px 0 0 0; color: #999; font-size: 12px;">
        Org.nr: ${company.org_number}
        ${company.vat_number ? ` | VAT: ${company.vat_number}` : ''}
        ${company.f_skatt ? ' | Innehar F-skattsedel' : ''}
      </p>
      ` : ''}
    </div>
  </div>
</body>
</html>
`
}

/**
 * Generate plain text email for sending an invoice
 */
export function generateInvoiceEmailText(data: InvoiceEmailData): string {
  const { invoice, customer, company } = data

  const documentType = getDocumentLabel(invoice)
  const isCreditNote = !!invoice.credited_invoice_id
  const docType = (invoice as Invoice & { document_type?: InvoiceDocumentType }).document_type || 'invoice'
  const isDeliveryNote = docType === 'delivery_note'
  const isProforma = docType === 'proforma'
  const hidePayment = isCreditNote || isDeliveryNote || isProforma

  let text = `${documentType} från ${getCompanyPrimaryName(company)}\n`
  text += `${documentType}nummer: ${invoice.invoice_number}\n\n`

  text += `Hej${customer.name ? ` ${customer.name.split(' ')[0]}` : ''},\n\n`

  if (isCreditNote) {
    text += `Bifogat hittar du en kreditfaktura som korrigerar en tidigare faktura.\n\n`
  } else {
    text += `Tack för ditt förtroende! Bifogat hittar du din faktura.\n\n`
  }

  text += `${documentType}sammanfattning:\n`
  text += `---\n`
  text += `${documentType}nummer: ${invoice.invoice_number}\n`
  text += `${documentType}datum: ${formatDate(invoice.invoice_date)}\n`
  text += `Förfallodatum: ${formatDate(invoice.due_date)}\n`
  text += `Att betala: ${formatCurrency(invoice.total, invoice.currency)}\n`
  text += `---\n\n`

  if (!hidePayment) {
    text += `Betalningsinformation:\n`
    if (company.bank_name) text += `Bank: ${company.bank_name}\n`
    if (company.clearing_number && company.account_number) {
      text += `Kontonummer: ${company.clearing_number}-${company.account_number}\n`
    }
    if (company.iban) text += `IBAN: ${company.iban}\n`
    if (company.bic) text += `BIC/SWIFT: ${company.bic}\n`
    text += `Meddelande: ${invoice.invoice_number}\n\n`
  }

  text += `Har du frågor om fakturan? Svara direkt på detta mejl så hjälper vi dig.\n\n`
  text += `Med vänliga hälsningar,\n`
  text += `${getCompanyDisplayName(company)}\n`

  if (company.org_number) {
    text += `\nOrg.nr: ${company.org_number}`
    if (company.vat_number) text += ` | VAT: ${company.vat_number}`
    if (company.f_skatt) text += ` | Innehar F-skattsedel`
    text += `\n`
  }

  return text
}

/**
 * Generate email subject for an invoice
 */
export function generateInvoiceEmailSubject(data: InvoiceEmailData): string {
  const { invoice, company } = data
  const documentType = getDocumentLabel(invoice)

  return `${documentType} ${invoice.invoice_number} från ${getCompanyPrimaryName(company)}`
}
