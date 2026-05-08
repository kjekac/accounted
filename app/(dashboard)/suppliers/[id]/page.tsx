'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ArrowLeft, Edit, Trash2, FileText, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import SupplierForm from '@/components/suppliers/SupplierForm'
import Link from 'next/link'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import type { Supplier, SupplierType, CreateSupplierInput, SupplierInvoice } from '@/types'

const supplierTypeLabels: Record<SupplierType, string> = {
  swedish_business: 'Svenskt företag eller organisation',
  eu_business: 'EU-företag',
  non_eu_business: 'Utanför EU',
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function SupplierDetailPage() {
  const { canWrite } = useCanWrite()
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const [supplier, setSupplier] = useState<Supplier & { stats?: { total_outstanding: number; total_paid: number; invoice_count: number } } | null>(null)
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useDestructiveConfirm()

  async function fetchSupplier() {
    setIsLoading(true)
    const res = await fetch(`/api/suppliers/${params.id}`)
    const { data, error } = await res.json()
    if (error) {
      toast({ title: 'Kunde inte ladda leverantör', description: error, variant: 'destructive' })
    } else {
      setSupplier(data)
    }
    setIsLoading(false)
  }

  async function fetchInvoices() {
    const res = await fetch(`/api/supplier-invoices?status=all`)
    const { data } = await res.json()
    if (data) {
      setInvoices(data.filter((inv: SupplierInvoice) => inv.supplier_id === params.id))
    }
  }

  useEffect(() => {
    fetchSupplier()
    fetchInvoices()
  }, [params.id])

  async function handleUpdate(data: CreateSupplierInput) {
    setIsSaving(true)
    const res = await fetch(`/api/suppliers/${params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Kunde inte uppdatera leverantör', description: getErrorMessage(result, { context: 'supplier' }), variant: 'destructive' })
    } else {
      toast({ title: 'Sparat', description: 'Leverantören har uppdaterats' })
      setSupplier({ ...result.data, stats: supplier?.stats })
      setIsEditOpen(false)
    }
    setIsSaving(false)
  }

  async function handleDelete() {
    const ok = await confirmAction({
      title: 'Ta bort leverantör',
      description: `"${supplier?.name}" och tillhörande data tas bort permanent. Denna åtgärd kan inte ångras.`,
      confirmLabel: 'Ta bort',
      variant: 'destructive',
    })
    if (!ok) return

    const res = await fetch(`/api/suppliers/${params.id}`, { method: 'DELETE' })
    const result = await res.json()
    if (!res.ok) {
      toast({ title: 'Kunde inte ta bort leverantör', description: getErrorMessage(result, { context: 'supplier' }), variant: 'destructive' })
    } else {
      toast({ title: 'Borttagen', description: 'Leverantören har tagits bort' })
      router.push('/suppliers')
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-muted rounded w-48 animate-pulse" />
        <Card className="animate-pulse">
          <CardContent className="h-48" />
        </Card>
      </div>
    )
  }

  if (!supplier) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Leverantören hittades inte</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/suppliers')}>
          Tillbaka
        </Button>
      </div>
    )
  }

  const statusColors: Record<string, string> = {
    registered: 'bg-blue-100 text-blue-800',
    approved: 'bg-yellow-100 text-yellow-800',
    paid: 'bg-success/10 text-success',
    partially_paid: 'bg-orange-100 text-orange-800',
    overdue: 'bg-destructive/10 text-destructive',
    credited: 'bg-gray-100 text-gray-800',
  }

  const statusLabels: Record<string, string> = {
    registered: 'Registrerad',
    approved: 'Godkänd',
    paid: 'Betald',
    partially_paid: 'Delbetald',
    overdue: 'Förfallen',
    credited: 'Krediterad',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => router.push('/suppliers')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">{supplier.name}</h1>
            <p className="text-muted-foreground">
              {supplierTypeLabels[supplier.supplier_type]}
              {supplier.org_number && ` | Org.nr: ${supplier.org_number}`}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setIsEditOpen(true)}
            disabled={!canWrite}
            title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
          >
            {canWrite ? <Edit className="mr-2 h-4 w-4" /> : <Lock className="mr-2 h-4 w-4" />}
            Redigera
          </Button>
          <Button
            variant="destructive"
            size="icon"
            onClick={handleDelete}
            disabled={!canWrite}
            title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
          >
            {canWrite ? <Trash2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Utestående</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums">{formatAmount(supplier.stats?.total_outstanding || 0)} kr</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Totalt betalt</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums">{formatAmount(supplier.stats?.total_paid || 0)} kr</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Antal fakturor</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-display text-2xl font-medium tabular-nums">{supplier.stats?.invoice_count || 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* Contact & Payment Info */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Kontaktuppgifter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {supplier.email && <p>E-post: {supplier.email}</p>}
            {supplier.phone && <p>Telefon: {supplier.phone}</p>}
            {supplier.address_line1 && <p>{supplier.address_line1}</p>}
            {supplier.postal_code && <p>{supplier.postal_code} {supplier.city}</p>}
            {supplier.vat_number && <p>VAT: {supplier.vat_number}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Betalningsuppgifter</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {supplier.bankgiro && <p>Bankgiro: {supplier.bankgiro}</p>}
            {supplier.plusgiro && <p>Plusgiro: {supplier.plusgiro}</p>}
            {supplier.iban && <p>IBAN: {supplier.iban}</p>}
            {supplier.bic && <p>BIC: {supplier.bic}</p>}
            <p>Betalningsvillkor: {supplier.default_payment_terms} dagar</p>
            <p>Valuta: {supplier.default_currency}</p>
            {supplier.default_expense_account && <p>Kostnadskonto: {supplier.default_expense_account}</p>}
          </CardContent>
        </Card>
      </div>

      {/* Invoices */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">Fakturor</CardTitle>
          <Link href="/supplier-invoices/new">
            <Button size="sm">
              <FileText className="mr-2 h-4 w-4" />
              Ny faktura
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">
              Inga fakturor registrerade för denna leverantör
            </p>
          ) : (
            <>
            {/* Desktop table */}
            <div className="hidden sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2">Ankomst</th>
                    <th className="py-2">Fakturanr</th>
                    <th className="py-2">Datum</th>
                    <th className="py-2">Förfaller</th>
                    <th className="py-2 text-right">Belopp</th>
                    <th className="py-2 text-right">Kvar</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-b last:border-0">
                      <td className="py-2 font-mono">{inv.arrival_number}</td>
                      <td className="py-2">
                        <Link href={`/supplier-invoices/${inv.id}`} className="text-primary hover:underline">
                          {inv.supplier_invoice_number}
                        </Link>
                      </td>
                      <td className="py-2">{inv.invoice_date}</td>
                      <td className="py-2">{inv.due_date}</td>
                      <td className="py-2 text-right">{formatAmount(inv.total)} kr</td>
                      <td className="py-2 text-right">{formatAmount(inv.remaining_amount)} kr</td>
                      <td className="py-2">
                        <Badge className={statusColors[inv.status] || ''}>
                          {statusLabels[inv.status] || inv.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="sm:hidden space-y-3">
              {invoices.map((inv) => (
                <div key={inv.id} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Link href={`/supplier-invoices/${inv.id}`} className="text-primary hover:underline font-medium text-sm">
                      {inv.supplier_invoice_number}
                    </Link>
                    <Badge className={statusColors[inv.status] || ''}>
                      {statusLabels[inv.status] || inv.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{inv.invoice_date} → {inv.due_date}</span>
                    <span className="font-mono">{formatAmount(inv.total)} kr</span>
                  </div>
                  {Number(inv.remaining_amount) > 0 && Number(inv.remaining_amount) !== Number(inv.total) && (
                    <div className="text-xs text-muted-foreground text-right">
                      Kvar: {formatAmount(inv.remaining_amount)} kr
                    </div>
                  )}
                </div>
              ))}
            </div>
            </>
          )}
        </CardContent>
      </Card>

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {/* Edit Dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Redigera leverantör</DialogTitle>
          </DialogHeader>
          <SupplierForm
            onSubmit={handleUpdate}
            isLoading={isSaving}
            initialData={{
              name: supplier.name,
              supplier_type: supplier.supplier_type,
              email: supplier.email || '',
              phone: supplier.phone || '',
              address_line1: supplier.address_line1 || '',
              address_line2: supplier.address_line2 || '',
              postal_code: supplier.postal_code || '',
              city: supplier.city || '',
              country: supplier.country || 'SE',
              org_number: supplier.org_number || '',
              vat_number: supplier.vat_number || '',
              bankgiro: supplier.bankgiro || '',
              plusgiro: supplier.plusgiro || '',
              iban: supplier.iban || '',
              bic: supplier.bic || '',
              default_expense_account: supplier.default_expense_account || '',
              default_payment_terms: supplier.default_payment_terms,
              default_currency: supplier.default_currency || 'SEK',
              notes: supplier.notes || '',
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
