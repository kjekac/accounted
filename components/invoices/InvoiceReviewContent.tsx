'use client'

import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { formatCurrency } from '@/lib/utils'
import type { Customer, Currency } from '@/types'

interface ReviewItem {
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate?: number
}

interface InvoiceReviewContentProps {
  customer: Customer
  invoiceDate: string
  dueDate: string
  currency: Currency
  items: ReviewItem[]
  subtotal: number
  vatAmount: number
  total: number
  yourReference?: string
  ourReference?: string
  notes?: string
}

export function InvoiceReviewContent({
  customer,
  invoiceDate,
  dueDate,
  currency,
  items,
  subtotal,
  vatAmount,
  total,
  yourReference,
  ourReference,
  notes,
}: InvoiceReviewContentProps) {
  const customerTypeLabel: Record<string, string> = {
    individual: 'Privatperson',
    swedish_business: 'Svenskt företag eller organisation',
    eu_business: 'EU-företag',
    non_eu_business: 'Utanför EU',
  }

  // Calculate per-rate VAT breakdown
  const vatByRate = new Map<number, number>()
  for (const item of items) {
    const rate = item.vat_rate ?? 0
    const lineTotal = item.quantity * item.unit_price
    const lineVat = Math.round(lineTotal * rate / 100 * 100) / 100
    vatByRate.set(rate, (vatByRate.get(rate) || 0) + lineVat)
  }

  const showVatColumn = vatByRate.size > 1

  return (
    <div className="space-y-4">
      {/* Customer info */}
      <div className="bg-muted rounded-lg p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium text-base truncate">{customer.name}</p>
          <p className="text-sm text-muted-foreground truncate">{customer.email}</p>
        </div>
        <Badge variant="outline" className="self-start sm:self-auto shrink-0">
          {customerTypeLabel[customer.customer_type] || customer.customer_type}
        </Badge>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">Fakturadatum</span>
          <p className="font-medium">{invoiceDate}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Förfallodatum</span>
          <p className="font-medium">{dueDate}</p>
        </div>
      </div>

      {/* Line items — table on desktop, cards on mobile */}
      <div className="hidden sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2">Beskrivning</th>
              <th className="py-2 w-16 text-right">Antal</th>
              <th className="py-2 w-16 text-center">Enhet</th>
              <th className="py-2 w-24 text-right">À-pris</th>
              {showVatColumn && <th className="py-2 w-16 text-right">Moms</th>}
              <th className="py-2 w-28 text-right">Belopp</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={index} className="border-b last:border-0">
                <td className="py-2">{item.description}</td>
                <td className="py-2 text-right">{item.quantity}</td>
                <td className="py-2 text-center">{item.unit}</td>
                <td className="py-2 text-right">{formatCurrency(item.unit_price, currency)}</td>
                {showVatColumn && (
                  <td className="py-2 text-right">{item.vat_rate ?? 0}%</td>
                )}
                <td className="py-2 text-right">
                  {formatCurrency(item.quantity * item.unit_price, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sm:hidden space-y-2">
        {items.map((item, index) => (
          <div key={index} className="border rounded-lg p-3 text-sm space-y-1.5">
            <p className="font-medium">{item.description}</p>
            <div className="flex items-center justify-between text-muted-foreground">
              <span>{item.quantity} {item.unit} × {formatCurrency(item.unit_price, currency)}</span>
              {showVatColumn && <span className="text-xs">({item.vat_rate ?? 0}% moms)</span>}
            </div>
            <p className="text-right font-medium">
              {formatCurrency(item.quantity * item.unit_price, currency)}
            </p>
          </div>
        ))}
      </div>

      {/* Totals */}
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Delsumma</span>
          <span>{formatCurrency(subtotal, currency)}</span>
        </div>
        {Array.from(vatByRate.entries())
          .filter(([, vat]) => vat > 0)
          .sort(([a], [b]) => b - a)
          .map(([rate, vat]) => (
            <div key={rate} className="flex justify-between">
              <span className="text-muted-foreground">Moms {rate}%</span>
              <span>{formatCurrency(vat, currency)}</span>
            </div>
          ))}
        {Array.from(vatByRate.values()).every((vat) => vat === 0) && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Moms</span>
            <span>{formatCurrency(0, currency)}</span>
          </div>
        )}
        <Separator />
        <div className="flex justify-between font-bold text-xl sm:text-2xl">
          <span>Totalt</span>
          <span>{formatCurrency(total, currency)}</span>
        </div>
      </div>

      {/* References/notes */}
      {(yourReference || ourReference || notes) && (
        <div className="border-t pt-3 space-y-2 text-sm text-muted-foreground">
          {yourReference && (
            <div>
              <span>Er referens:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {yourReference.split(',').map((ref, i) => (
                  <Badge key={i} variant="secondary" className="text-xs font-normal">
                    {ref.trim()}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {ourReference && (
            <div>
              <span>Vår referens:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {ourReference.split(',').map((ref, i) => (
                  <Badge key={i} variant="secondary" className="text-xs font-normal">
                    {ref.trim()}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {notes && <p>Anteckning: {notes}</p>}
        </div>
      )}
    </div>
  )
}
