'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { Plus, Search, Building2, Lock } from 'lucide-react'
import SupplierForm from '@/components/suppliers/SupplierForm'
import Link from 'next/link'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Supplier, SupplierType, CreateSupplierInput } from '@/types'

const supplierTypeLabels: Record<SupplierType, string> = {
  swedish_business: 'Svenskt företag eller organisation',
  eu_business: 'EU-företag',
  non_eu_business: 'Utanför EU',
}

function getPaymentInfo(supplier: Supplier): { label: string; value: string } | null {
  if (supplier.bankgiro) return { label: 'BG', value: supplier.bankgiro }
  if (supplier.plusgiro) return { label: 'PG', value: supplier.plusgiro }
  if (supplier.iban) return { label: 'IBAN', value: supplier.iban }
  if (supplier.bank_account) return { label: 'Bankkonto', value: supplier.bank_account }
  return null
}

function formatLocation(supplier: Supplier): string | null {
  if (supplier.city && supplier.country) return `${supplier.city}, ${supplier.country}`
  if (supplier.city) return supplier.city
  return null
}

export default function SuppliersPage() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()

  async function fetchSuppliers() {
    if (!company) return
    setIsLoading(true)
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .eq('company_id', company.id)
      .order('name', { ascending: true })

    if (error) {
      toast({
        title: 'Kunde inte ladda leverantörer',
        description: 'Kontrollera din anslutning och försök igen.',
        variant: 'destructive',
      })
    } else {
      setSuppliers(data || [])
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchSuppliers()
  }, [])

  async function handleCreateSupplier(data: CreateSupplierInput) {
    setIsCreating(true)

    const response = await fetch('/api/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    const result = await response.json()

    if (!response.ok) {
      const fieldErrors = result.errors?.map((e: { field: string; message: string }) => `${e.field}: ${e.message}`).join(', ')
      toast({
        title: 'Kunde inte skapa leverantör',
        description: fieldErrors || result.error || 'Försök igen.',
        variant: 'destructive',
      })
    } else {
      toast({
        title: 'Leverantör skapad',
        description: `${data.name} har lagts till`,
      })
      setSuppliers([...suppliers, result.data])
      setIsDialogOpen(false)
    }

    setIsCreating(false)
  }

  const filteredSuppliers = suppliers.filter((s) =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    s.org_number?.includes(searchTerm)
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Leverantörer</h1>
          <p className="text-muted-foreground">
            Hantera dina leverantörer och deras betalningsuppgifter
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button
              disabled={!canWrite}
              title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
            >
              {canWrite ? (
                <Plus className="mr-2 h-4 w-4" />
              ) : (
                <Lock className="mr-2 h-4 w-4" />
              )}
              Ny leverantör
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Lägg till leverantör</DialogTitle>
            </DialogHeader>
            <SupplierForm
              onSubmit={handleCreateSupplier}
              isLoading={isCreating}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Sök på namn, e-post eller org.nr..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Supplier list */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-5 space-y-3">
                <div className="h-5 bg-muted rounded w-1/2" />
                <div className="h-3 bg-muted rounded w-2/3" />
                <div className="h-px bg-muted" />
                <div className="h-3 bg-muted rounded w-1/2" />
                <div className="h-3 bg-muted rounded w-1/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredSuppliers.length === 0 ? (
        <Card>
          <CardContent>
            {searchTerm ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">Inga träffar</h3>
                <p className="text-muted-foreground text-center mt-1">
                  Inga leverantörer matchar &quot;{searchTerm}&quot;
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12">
                <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">Inga leverantörer</h3>
                <p className="text-muted-foreground text-center mt-1">
                  Lägg till din första leverantör för att börja registrera inköpsfakturor
                </p>
                <Button
                  className="mt-4"
                  onClick={() => setIsDialogOpen(true)}
                  disabled={!canWrite}
                  title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
                >
                  {canWrite ? (
                    <Plus className="mr-2 h-4 w-4" />
                  ) : (
                    <Lock className="mr-2 h-4 w-4" />
                  )}
                  Ny leverantör
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredSuppliers.map((supplier) => {
            const payment = getPaymentInfo(supplier)
            const location = formatLocation(supplier)
            return (
              <Link key={supplier.id} href={`/suppliers/${supplier.id}`} className="group">
                <Card className="h-full cursor-pointer transition-all duration-150 hover:border-foreground/20 hover:shadow-sm motion-safe:active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  <CardContent className="p-5 flex flex-col h-full">
                    <div className="space-y-1 mb-4">
                      <h3 className="text-[15px] font-semibold tracking-tight leading-tight truncate group-hover:text-primary transition-colors">
                        {supplier.name}
                      </h3>
                      <p className="text-xs text-muted-foreground leading-snug">
                        {supplierTypeLabels[supplier.supplier_type]}
                      </p>
                    </div>

                    <dl className="mt-auto space-y-1.5 text-sm border-t pt-3">
                      {supplier.org_number && (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-xs text-muted-foreground shrink-0">Org.nr</dt>
                          <dd className="tabular-nums truncate">{supplier.org_number}</dd>
                        </div>
                      )}
                      {payment && (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-xs text-muted-foreground shrink-0">{payment.label}</dt>
                          <dd className="tabular-nums truncate">{payment.value}</dd>
                        </div>
                      )}
                      {supplier.email && (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-xs text-muted-foreground shrink-0">E-post</dt>
                          <dd className="truncate">{supplier.email}</dd>
                        </div>
                      )}
                      {location && (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-xs text-muted-foreground shrink-0">Plats</dt>
                          <dd className="truncate">{location}</dd>
                        </div>
                      )}
                      {!supplier.org_number && !payment && !supplier.email && !location && (
                        <p className="text-xs text-muted-foreground italic">Inga kontaktuppgifter</p>
                      )}
                    </dl>
                  </CardContent>
                </Card>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
