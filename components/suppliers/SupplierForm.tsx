'use client'

import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Lock } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { CreateSupplierInput, SupplierType } from '@/types'

const schema = z.object({
  name: z.string().min(1, 'Namn krävs'),
  supplier_type: z.enum(['swedish_business', 'eu_business', 'non_eu_business']),
  email: z.string().email('Ogiltig e-postadress').optional().or(z.literal('')),
  phone: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  org_number: z.string().optional(),
  vat_number: z.string().optional(),
  bankgiro: z.string().optional(),
  plusgiro: z.string().optional(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  default_expense_account: z.string().optional(),
  default_payment_terms: z.number().min(1).optional(),
  default_currency: z.string().optional(),
  notes: z.string().optional(),
})

type FormData = z.infer<typeof schema>

interface SupplierFormProps {
  onSubmit: (data: CreateSupplierInput) => Promise<void>
  isLoading: boolean
  initialData?: Partial<FormData>
}

export default function SupplierForm({
  onSubmit,
  isLoading,
  initialData,
}: SupplierFormProps) {
  const { canWrite } = useCanWrite()
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initialData?.name || '',
      supplier_type: initialData?.supplier_type || 'swedish_business',
      email: initialData?.email || '',
      phone: initialData?.phone || '',
      address_line1: initialData?.address_line1 || '',
      postal_code: initialData?.postal_code || '',
      city: initialData?.city || '',
      country: initialData?.country || 'SE',
      org_number: initialData?.org_number || '',
      vat_number: initialData?.vat_number || '',
      bankgiro: initialData?.bankgiro || '',
      plusgiro: initialData?.plusgiro || '',
      iban: initialData?.iban || '',
      bic: initialData?.bic || '',
      default_expense_account: initialData?.default_expense_account || '',
      default_payment_terms: initialData?.default_payment_terms || 30,
      default_currency: initialData?.default_currency || 'SEK',
      notes: initialData?.notes || '',
    },
  })

  const onFormSubmit = (data: FormData) => {
    onSubmit({
      ...data,
      email: data.email || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit(onFormSubmit)} className="space-y-6">
      {/* Supplier Type */}
      <div className="space-y-2">
        <Label>Leverantörstyp *</Label>
        <Controller
          name="supplier_type"
          control={control}
          render={({ field }) => (
            <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
              <SelectTrigger>
                <SelectValue placeholder="Välj typ" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="swedish_business">Svenskt företag eller organisation</SelectItem>
                <SelectItem value="eu_business">EU-företag</SelectItem>
                <SelectItem value="non_eu_business">Företag utanför EU</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="name">Namn *</Label>
        <Input
          id="name"
          placeholder="Leverantörens namn"
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
            placeholder="fakturor@foretag.se"
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
            placeholder="+46 8 123 45 67"
            {...register('phone')}
          />
        </div>
      </div>

      {/* Business info */}
      <div className="space-y-4 pt-4 border-t">
        <h3 className="font-medium">Företagsuppgifter</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="org_number">Organisationsnummer</Label>
            <Input
              id="org_number"
              placeholder="XXXXXX-XXXX"
              {...register('org_number')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="vat_number">VAT-nummer</Label>
            <Input
              id="vat_number"
              placeholder="SE123456789001"
              {...register('vat_number')}
            />
          </div>
        </div>
      </div>

      {/* Address */}
      <div className="space-y-4 pt-4 border-t">
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
            <Input id="postal_code" placeholder="123 45" {...register('postal_code')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">Ort</Label>
            <Input id="city" placeholder="Stockholm" {...register('city')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="country">Land</Label>
            <Input id="country" placeholder="SE" {...register('country')} />
          </div>
        </div>
      </div>

      {/* Payment details */}
      <div className="space-y-4 pt-4 border-t">
        <h3 className="font-medium">Betalningsuppgifter</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="bankgiro">Bankgiro</Label>
            <Input id="bankgiro" placeholder="XXX-XXXX" {...register('bankgiro')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="plusgiro">Plusgiro</Label>
            <Input id="plusgiro" placeholder="XXXXXXX-X" {...register('plusgiro')} />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="iban">IBAN</Label>
            <Input id="iban" placeholder="SE00 0000 0000 0000 0000 0000" {...register('iban')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bic">BIC/SWIFT</Label>
            <Input id="bic" placeholder="SWEDSESS" {...register('bic')} />
          </div>
        </div>
      </div>

      {/* Defaults */}
      <div className="space-y-4 pt-4 border-t">
        <h3 className="font-medium">Standardvärden</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="default_expense_account">Kostnadskonto</Label>
            <Input
              id="default_expense_account"
              placeholder="5010"
              {...register('default_expense_account')}
            />
            <p className="text-xs text-muted-foreground">Standardkonto för denna leverantör</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="payment_terms">Betalningsvillkor (dagar)</Label>
            <Input
              id="payment_terms"
              type="number"
              {...register('default_payment_terms', { valueAsNumber: true })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="default_currency">Valuta</Label>
            <Controller
              name="default_currency"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={(v) => { if (v) field.onChange(v) }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SEK">SEK</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="GBP">GBP</SelectItem>
                    <SelectItem value="NOK">NOK</SelectItem>
                    <SelectItem value="DKK">DKK</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>
      </div>

      {/* Notes */}
      <div className="space-y-2">
        <Label htmlFor="notes">Anteckningar</Label>
        <Textarea
          id="notes"
          placeholder="Interna anteckningar..."
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
              Spara leverantör
            </>
          ) : (
            'Spara leverantör'
          )}
        </Button>
      </div>
    </form>
  )
}
