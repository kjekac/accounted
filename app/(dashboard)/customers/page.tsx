'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { Plus, Search, Users, Lock } from 'lucide-react'
import CustomerForm from '@/components/customers/CustomerForm'
import { EmptyCustomers } from '@/components/ui/empty-state'
import Link from 'next/link'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { Customer, CustomerType, CreateCustomerInput } from '@/types'

const customerTypeLabels: Record<CustomerType, string> = {
  individual: 'Privatperson',
  swedish_business: 'Svenskt företag eller organisation',
  eu_business: 'EU-företag',
  non_eu_business: 'Utanför EU',
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export default function CustomersPage() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()

  async function fetchCustomers() {
    if (!company) return
    setIsLoading(true)
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('company_id', company.id)
      .order('name', { ascending: true })

    if (error) {
      toast({
        title: 'Kunde inte ladda kunder',
        description: 'Kontrollera din anslutning och försök igen.',
        variant: 'destructive',
      })
    } else {
      setCustomers(data || [])
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchCustomers()
  }, [])

  async function handleCreateCustomer(data: CreateCustomerInput) {
    setIsCreating(true)

    const response = await fetch('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    const result = await response.json()

    if (!response.ok) {
      toast({
        title: 'Kunde inte skapa kund',
        description: getErrorMessage(result, { context: 'customer' }),
        variant: 'destructive',
      })
    } else {
      toast({
        title: 'Kund skapad',
        description: `${data.name} har lagts till`,
      })
      setCustomers([...customers, result.data])
      setIsDialogOpen(false)
    }

    setIsCreating(false)
  }

  const filteredCustomers = customers.filter((customer) =>
    customer.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    customer.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    customer.org_number?.includes(searchTerm)
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">Kunder</h1>
          <p className="text-muted-foreground">
            Hantera dina kunder och deras faktureringsuppgifter
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
              Ny kund
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Lägg till kund</DialogTitle>
            </DialogHeader>
            <CustomerForm
              onSubmit={handleCreateCustomer}
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

      {/* Customer list */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 bg-muted rounded w-1/2" />
                <div className="h-4 bg-muted rounded w-1/3 mt-2" />
              </CardHeader>
              <CardContent>
                <div className="h-4 bg-muted rounded w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredCustomers.length === 0 ? (
        <Card>
          <CardContent>
            {searchTerm ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Users className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">Inga träffar</h3>
                <p className="text-muted-foreground text-center mt-1">
                  Inga kunder matchar &quot;{searchTerm}&quot;
                </p>
              </div>
            ) : (
              <EmptyCustomers onAction={() => setIsDialogOpen(true)} />
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredCustomers.map((customer) => (
              <Link key={customer.id} href={`/customers/${customer.id}`}>
                <Card className="cursor-pointer transition-all duration-150 hover:border-primary/50 hover:bg-accent/50 hover:shadow-sm motion-safe:active:scale-[0.99] active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 h-full group">
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-3.5">
                      <div className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-sm font-semibold text-primary tracking-tight">
                        {getInitials(customer.name)}
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-base truncate group-hover:text-primary transition-colors">{customer.name}</CardTitle>
                        <Badge variant="secondary" className="mt-1">
                          {customerTypeLabels[customer.customer_type]}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1.5 text-sm text-muted-foreground">
                      {customer.email && (
                        <p className="truncate">{customer.email}</p>
                      )}
                      {customer.org_number && (
                        <div className="flex items-center gap-2">
                          <span>{customer.org_number}</span>
                          {customer.vat_number_validated && (
                            <Badge variant="success" className="text-xs">Verifierad</Badge>
                          )}
                        </div>
                      )}
                      {customer.city && (
                        <p>{customer.city}, {customer.country}</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
          ))}
        </div>
      )}
    </div>
  )
}
