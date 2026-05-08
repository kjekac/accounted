'use client'

import { useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, CheckCircle, XCircle, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { CreateCustomerInput, CustomerType } from '@/types'

const schema = z.object({
  name: z.string().min(1, 'Namn krävs'),
  customer_type: z.enum(['individual', 'swedish_business', 'eu_business', 'non_eu_business']),
  email: z.string().email('Ogiltig e-postadress').optional().or(z.literal('')),
  phone: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  org_number: z.string().optional(),
  vat_number: z.string().optional(),
  default_payment_terms: z.number().min(1).optional(),
  notes: z.string().optional(),
})

type FormData = z.infer<typeof schema>

interface CustomerFormProps {
  onSubmit: (data: CreateCustomerInput) => Promise<void>
  isLoading: boolean
  initialData?: Partial<FormData>
}

export default function CustomerForm({
  onSubmit,
  isLoading,
  initialData,
}: CustomerFormProps) {
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const [isValidatingVat, setIsValidatingVat] = useState(false)
  const [vatValidationResult, setVatValidationResult] = useState<{
    valid: boolean
    name?: string
  } | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    control,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initialData?.name || '',
      customer_type: initialData?.customer_type || 'swedish_business',
      email: initialData?.email || '',
      phone: initialData?.phone || '',
      address_line1: initialData?.address_line1 || '',
      postal_code: initialData?.postal_code || '',
      city: initialData?.city || '',
      country: initialData?.country || 'Sweden',
      org_number: initialData?.org_number || '',
      vat_number: initialData?.vat_number || '',
      default_payment_terms: initialData?.default_payment_terms || 30,
      notes: initialData?.notes || '',
    },
  })

  const customerType = watch('customer_type')
  const vatNumber = watch('vat_number')

  const handleValidateVat = async () => {
    if (!vatNumber) return

    setIsValidatingVat(true)
    setVatValidationResult(null)

    try {
      const response = await fetch('/api/vat/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vat_number: vatNumber }),
      })

      const result = await response.json()

      setVatValidationResult({
        valid: result.valid,
        name: result.name,
      })

      if (result.valid && result.name) {
        toast({
          title: 'VAT-nummer verifierat',
          description: `Företag: ${result.name}`,
        })
      } else if (!result.valid) {
        toast({
          title: 'Verifiering misslyckades',
          description: result.error || 'VAT-numret kunde inte verifieras',
          variant: 'destructive',
        })
      }
    } catch {
      toast({
        title: 'Fel',
        description: 'Kunde inte verifiera VAT-nummer',
        variant: 'destructive',
      })
    } finally {
      setIsValidatingVat(false)
    }
  }

  const onFormSubmit = (data: FormData) => {
    onSubmit({
      ...data,
      email: data.email || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-6">
      {/* Customer Type */}
      <div className="space-y-2">
        <Label>Kundtyp *</Label>
        <Controller
          name="customer_type"
          control={control}
          render={({ field }) => (
            <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
              <SelectTrigger>
                <SelectValue placeholder="Välj kundtyp" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="individual">Privatperson (Sverige)</SelectItem>
                <SelectItem value="swedish_business">Svenskt företag eller organisation</SelectItem>
                <SelectItem value="eu_business">EU-företag</SelectItem>
                <SelectItem value="non_eu_business">Företag utanför EU</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
        <p className="text-xs text-muted-foreground">
          Kundtypen påverkar hur moms hanteras på fakturor
        </p>
      </div>

      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="name">Namn *</Label>
        <Input
          id="name"
          placeholder="Företagsnamn eller personnamn"
          {...register('name')}
        />
        {errors.name && (
          <p className="text-sm text-destructive">{errors.name.message}</p>
        )}
      </div>

      {/* Contact */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="email">E-post</Label>
          <Input
            id="email"
            type="email"
            placeholder="namn@foretag.se"
            {...register('email')}
          />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Telefon</Label>
          <Input
            id="phone"
            placeholder="+46 70 123 45 67"
            {...register('phone')}
          />
        </div>
      </div>

      {/* Address */}
      <div className="space-y-4">
        <h3 className="font-medium">Adress</h3>
        <div className="space-y-2">
          <Label htmlFor="address_line1">Gatuadress</Label>
          <Input
            id="address_line1"
            placeholder="Storgatan 1"
            {...register('address_line1')}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="postal_code">Postnummer</Label>
            <Input
              id="postal_code"
              placeholder="123 45"
              {...register('postal_code')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">Ort</Label>
            <Input
              id="city"
              placeholder="Stockholm"
              {...register('city')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="country">Land</Label>
            <Input
              id="country"
              placeholder="Sweden"
              {...register('country')}
            />
          </div>
        </div>
      </div>

      {/* Business info */}
      {customerType !== 'individual' && (
        <div className="space-y-4 pt-4 border-t">
          <h3 className="font-medium">Företagsuppgifter</h3>

          <div className="space-y-2">
            <Label htmlFor="org_number">Organisationsnummer</Label>
            <Input
              id="org_number"
              placeholder="XXXXXX-XXXX"
              {...register('org_number')}
            />
          </div>

          {(customerType === 'eu_business' || customerType === 'swedish_business') && (
            <div className="space-y-2">
              <Label htmlFor="vat_number">VAT-nummer (momsreg.nr)</Label>
              <div className="flex gap-2">
                <Input
                  id="vat_number"
                  placeholder={customerType === 'eu_business' ? 'DE123456789' : 'SE123456789001'}
                  {...register('vat_number')}
                  className="flex-1"
                />
                {customerType === 'eu_business' && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleValidateVat}
                    disabled={!vatNumber || isValidatingVat}
                  >
                    {isValidatingVat ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : vatValidationResult?.valid ? (
                      <CheckCircle className="h-4 w-4 text-success" />
                    ) : vatValidationResult?.valid === false ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      'Verifiera'
                    )}
                  </Button>
                )}
              </div>
              {customerType === 'eu_business' && (
                <p className="text-xs text-muted-foreground">
                  Verifiera VAT-numret för att kunna fakturera med omvänd skattskyldighet (0% moms)
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Payment terms */}
      <div className="space-y-2">
        <Label htmlFor="payment_terms">Betalningsvillkor (dagar)</Label>
        <Input
          id="payment_terms"
          type="number"
          {...register('default_payment_terms', { valueAsNumber: true })}
        />
      </div>

      {/* Notes */}
      <div className="space-y-2">
        <Label htmlFor="notes">Anteckningar</Label>
        <Textarea
          id="notes"
          placeholder="Interna anteckningar om kunden..."
          {...register('notes')}
        />
      </div>

      {/* Submit */}
      <div className="flex justify-end gap-2">
        <Button
          type="submit"
          disabled={isLoading || !canWrite}
          title={!canWrite ? 'Du har endast läsbehörighet i detta företag' : undefined}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sparar...
            </>
          ) : !canWrite ? (
            <>
              <Lock className="mr-2 h-4 w-4" />
              Spara kund
            </>
          ) : (
            'Spara kund'
          )}
        </Button>
      </div>
    </form>
  )
}
