'use client'

import { useState, useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, ArrowRight, ArrowLeft, CheckCircle2, AlertTriangle } from 'lucide-react'
import type { EntityType } from '@/types'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import { getBranding } from '@/lib/branding/service'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'

const branding = getBranding()

const schema = z.object({
  company_name: z.string().min(1, 'Företagsnamn krävs'),
  org_number: z.string()
    .min(1, 'Organisationsnummer krävs')
    .refine(
      (val) => normalizeOrgNumber(val) !== null,
      'Ogiltigt organisationsnummer. Kontrollera att du angett ett giltigt 10- eller 12-siffrigt organisationsnummer.',
    ),
  address_line1: z.string().optional(),
  postal_code: z.string().optional(),
  city: z.string().optional(),
})

type FormData = z.infer<typeof schema>

interface Step2Props {
  initialData: Partial<FormData>
  entityType?: EntityType
  ticEnabled?: boolean
  onTicLookup?: (result: CompanyLookupResult | null) => void
  onNext: (data: FormData) => void
  onBack: () => void
  isSaving: boolean
  orgNumberLocked?: boolean
}

export default function Step2CompanyDetails({
  initialData,
  entityType,
  ticEnabled,
  onTicLookup,
  onNext,
  onBack,
  isSaving,
  orgNumberLocked,
}: Step2Props) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      company_name: initialData.company_name || '',
      org_number: initialData.org_number || '',
      address_line1: initialData.address_line1 || '',
      postal_code: initialData.postal_code || '',
      city: initialData.city || '',
    },
  })

  const [isLooking, setIsLooking] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookupDone, setLookupDone] = useState<CompanyLookupResult | null>(null)
  const [orgNumberExists, setOrgNumberExists] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const dupAbortRef = useRef<AbortController | null>(null)

  const orgNumber = watch('org_number')

  // Debounced duplicate check against gnubok's own companies table. Runs in
  // parallel with the TIC lookup — they don't conflict. On match, the submit
  // button is disabled; the server action would also reject ('org_number_exists')
  // but blocking client-side avoids a wasted roundtrip.
  useEffect(() => {
    if (!orgNumber || normalizeOrgNumber(orgNumber) === null) {
      setOrgNumberExists(false)
      return
    }
    const timer = setTimeout(() => {
      dupAbortRef.current?.abort()
      const controller = new AbortController()
      dupAbortRef.current = controller
      fetch(`/api/company/check-org-number?org_number=${encodeURIComponent(orgNumber)}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (controller.signal.aborted || !res.ok) return
          const { data } = await res.json()
          setOrgNumberExists(!!data?.exists)
        })
        .catch(() => {
          // Network failure is non-fatal — the server action will re-check.
        })
    }, 500)
    return () => {
      clearTimeout(timer)
      dupAbortRef.current?.abort()
    }
  }, [orgNumber])

  useEffect(() => {
    if (!ticEnabled || !orgNumber || normalizeOrgNumber(orgNumber) === null) {
      return
    }

    setLookupError(null)
    setLookupDone(null)

    const timer = setTimeout(() => {
      // Abort any in-flight request
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsLooking(true)

      fetch(`/api/extensions/ext/tic/lookup?org_number=${encodeURIComponent(orgNumber)}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (controller.signal.aborted) return

          if (res.status === 403) {
            // Extension disabled — silently ignore
            return
          }
          if (res.status === 404) {
            setLookupError('Inget företag hittades med det organisationsnumret.')
            onTicLookup?.(null)
            return
          }
          if (!res.ok) {
            setLookupError('Kunde inte hämta företagsuppgifter. Du kan fylla i manuellt.')
            onTicLookup?.(null)
            return
          }

          const { data } = (await res.json()) as { data: CompanyLookupResult }

          // Guard: only apply if org_number still matches (user may have changed it)
          if (controller.signal.aborted) return

          setLookupDone(data)
          onTicLookup?.(data)

          // Auto-fill from TIC — overwrite since user just entered a new org number
          if (data.companyName) setValue('company_name', data.companyName)
          if (data.address?.street) setValue('address_line1', data.address.street)
          if (data.address?.postalCode) setValue('postal_code', data.address.postalCode)
          if (data.address?.city) setValue('city', data.address.city)
        })
        .catch((err) => {
          if ((err as Error).name === 'AbortError') return
          setLookupError('Kunde inte hämta företagsuppgifter. Du kan fylla i manuellt.')
          onTicLookup?.(null)
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLooking(false)
        })
    }, 500)

    return () => {
      clearTimeout(timer)
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticEnabled, orgNumber])

  const isAB = entityType === 'aktiebolag'

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Grunduppgifter</CardTitle>
          <CardDescription>
            {ticEnabled
              ? 'Ange organisationsnummer så hämtas övriga uppgifter automatiskt.'
              : isAB
                ? 'Ange bolagets registrerade namn och organisationsnummer.'
                : 'Ange namn på din verksamhet.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onNext, (errs) => {
            const fields = Object.keys(errs).join(', ')
            console.error('[onboarding] step 2 validation failed:', fields, errs)
            fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'step 2 validation failed', extra: { fields } }) }).catch(() => {})
          })} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="org_number">
                Organisationsnummer *
              </Label>
              <Input
                id="org_number"
                placeholder={isAB ? 'XXXXXX-XXXX' : 'ÅÅMMDD-XXXX (ditt personnummer vid EF)'}
                {...register('org_number')}
                readOnly={orgNumberLocked}
                className={orgNumberLocked ? 'bg-muted cursor-not-allowed' : undefined}
              />
              {errors.org_number && (
                <p className="text-sm text-destructive">{errors.org_number.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {isAB
                  ? 'Obligatoriskt för aktiebolag'
                  : 'Vid enskild firma är orgnummer samma som ditt personnummer'}
              </p>
              {ticEnabled && isLooking && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Hämtar företagsuppgifter...
                </div>
              )}
              {ticEnabled && lookupDone && !lookupDone.isCeased && (
                <div className="flex items-center gap-2 text-sm text-primary">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {lookupDone.companyName}
                </div>
              )}
              {ticEnabled && lookupDone?.isCeased && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {lookupDone.companyName} — företaget är avregistrerat
                </div>
              )}
              {ticEnabled && lookupError && (
                <p className="text-xs text-muted-foreground">{lookupError}</p>
              )}
              {orgNumberExists && (
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>
                    Det här företaget finns redan i {branding.appName.toLowerCase()}. Be en befintlig administratör att bjuda in dig.
                  </span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="company_name">
                {isAB ? 'Företagsnamn' : 'Verksamhetsnamn (Eller ditt namn vid EF)'} *
              </Label>
              <Input
                id="company_name"
                placeholder={isAB ? 'AB Företaget' : 'Alices Konsultverksamhet'}
                {...register('company_name')}
              />
              {errors.company_name && (
                <p className="text-sm text-destructive">{errors.company_name.message}</p>
              )}
            </div>

            <div className="pt-4 border-t">
              <h3 className="font-medium mb-4">Adress (för fakturor)</h3>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="address_line1">Gatuadress</Label>
                  <Input
                    id="address_line1"
                    placeholder="Storgatan 1"
                    {...register('address_line1')}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                </div>
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row sm:justify-between gap-3 pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={onBack}
                disabled={isSaving}
                className="w-full sm:w-auto"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Tillbaka
              </Button>
              <Button
                type="submit"
                disabled={isSaving || orgNumberExists}
                className="w-full sm:w-auto"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sparar...
                  </>
                ) : (
                  <>
                    Fortsätt
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
