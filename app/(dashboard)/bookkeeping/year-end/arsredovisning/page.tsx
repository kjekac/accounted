'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/ui/page-header'
import { ArrowLeft, FileDown, Plus, ExternalLink, Loader2, Save, CheckCircle2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import type { ArsredovisningData } from '@/lib/bokslut/arsredovisning/types'
import type { SignatureRequest } from '@/lib/bokslut/arsredovisning/signature-service'

export default function ArsredovisningPage() {
  const searchParams = useSearchParams()
  const periodId = searchParams.get('period')
  const { toast } = useToast()

  const [data, setData] = useState<ArsredovisningData | null>(null)
  const [signatures, setSignatures] = useState<SignatureRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Editable narrative fields — persisted to arsredovisning_narratives so
  // the PDF always reflects the latest saved version and a refresh / new
  // user picks up the same content.
  const [description, setDescription] = useState('')
  const [importantEvents, setImportantEvents] = useState('')
  const [resultatdisposition, setResultatdisposition] = useState('')
  const [savedDescription, setSavedDescription] = useState('')
  const [savedImportantEvents, setSavedImportantEvents] = useState('')
  const [savedResultatdisposition, setSavedResultatdisposition] = useState('')
  const [agmDate, setAgmDate] = useState('')
  const [savedAgmDate, setSavedAgmDate] = useState('')
  const [savingNarrative, setSavingNarrative] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Add-signer form
  const [signerName, setSignerName] = useState('')
  const [signerRole, setSignerRole] = useState('Styrelseledamot')

  useEffect(() => {
    if (!periodId) return
    let cancelled = false
    Promise.all([
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning`).then((r) => r.json()),
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures`).then((r) =>
        r.json(),
      ),
    ])
      .then(([arBody, sigBody]) => {
        if (cancelled) return
        if (arBody?.error) {
          setError(arBody.error.message ?? 'Kunde inte hämta årsredovisning')
          return
        }
        const d = arBody.data as ArsredovisningData
        setData(d)
        // buildArsredovisningData merges persisted narrative + boilerplate,
        // so the values here are whatever the user will see in the PDF
        // unless they edit. Track both "current draft" and "last saved" so
        // we can disable Spara when there's nothing pending.
        setDescription(d.forvaltningsberattelse.description)
        setImportantEvents(d.forvaltningsberattelse.important_events)
        setResultatdisposition(d.forvaltningsberattelse.resultatdisposition)
        setAgmDate(d.forvaltningsberattelse.agm_date ?? '')
        setSavedDescription(d.forvaltningsberattelse.description)
        setSavedImportantEvents(d.forvaltningsberattelse.important_events)
        setSavedResultatdisposition(d.forvaltningsberattelse.resultatdisposition)
        setSavedAgmDate(d.forvaltningsberattelse.agm_date ?? '')
        setSignatures((sigBody.data ?? []) as SignatureRequest[])
      })
      .catch(() => {
        if (!cancelled) setError('Kunde inte hämta årsredovisning')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [periodId])

  const hasUnsavedNarrative =
    description !== savedDescription ||
    importantEvents !== savedImportantEvents ||
    resultatdisposition !== savedResultatdisposition ||
    agmDate !== savedAgmDate

  const handleSaveNarrative = useCallback(async () => {
    if (!periodId) return
    setSavingNarrative(true)
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/narrative`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description,
            important_events: importantEvents,
            resultatdisposition,
            agm_date: agmDate || null,
          }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte spara texten',
          description: body?.error?.message ?? '',
          variant: 'destructive',
        })
        return
      }
      setSavedDescription(description)
      setSavedImportantEvents(importantEvents)
      setSavedResultatdisposition(resultatdisposition)
      setSavedAgmDate(agmDate)
      setSavedAt(Date.now())
    } catch (err) {
      toast({
        title: 'Kunde inte spara texten',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setSavingNarrative(false)
    }
  }, [periodId, description, importantEvents, resultatdisposition, agmDate, toast])

  const handleMarkSigned = useCallback(
    async (signatureId: string) => {
      if (!periodId) return
      try {
        const res = await fetch(
          `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures/${signatureId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'signed' }),
          },
        )
        const body = await res.json()
        if (!res.ok) {
          toast({
            title: 'Kunde inte markera som signerad',
            description: body?.error?.message ?? '',
            variant: 'destructive',
          })
          return
        }
        setSignatures((prev) =>
          prev.map((s) => (s.id === signatureId ? (body.data as SignatureRequest) : s)),
        )
        toast({ title: 'Underskrift registrerad' })
      } catch (err) {
        toast({
          title: 'Kunde inte markera som signerad',
          description: err instanceof Error ? err.message : 'Okänt fel',
          variant: 'destructive',
        })
      }
    },
    [periodId, toast],
  )

  const handleAddSigner = useCallback(async () => {
    if (!periodId || !signerName.trim()) return
    try {
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/signatures`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: signerRole, signer_name: signerName.trim() }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte lägga till undertecknare',
          description: body?.error?.message ?? '',
          variant: 'destructive',
        })
        return
      }
      setSignatures((prev) => [...prev, body.data as SignatureRequest])
      setSignerName('')
      toast({ title: 'Undertecknare tillagd', description: `${signerRole}: ${signerName}` })
    } catch (err) {
      toast({
        title: 'Kunde inte lägga till undertecknare',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    }
  }, [periodId, signerName, signerRole, toast])

  if (!periodId) {
    return (
      <div className="space-y-8">
        <PageHeader title="Årsredovisning" />
        <Card>
          <CardContent className="p-6 text-muted-foreground">
            Saknar periodparameter. Öppna sidan från bokslutet via{' '}
            <Link href="/bookkeeping/year-end" className="text-primary hover:underline">
              /bookkeeping/year-end
            </Link>
            .
          </CardContent>
        </Card>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <PageHeader title="Årsredovisning" />
        <Card>
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-8">
        <PageHeader title="Årsredovisning" />
        <Card>
          <CardContent className="p-6 text-destructive">
            {error ?? 'Kunde inte hämta data'}
          </CardContent>
        </Card>
      </div>
    )
  }

  // PDF route reads persisted narrative from the new arsredovisning_narratives
  // table. The save button below writes overrides; the URL stays clean.
  const pdfUrl = `/api/bookkeeping/fiscal-periods/${periodId}/arsredovisning/pdf`

  return (
    <div className="space-y-8">
      <PageHeader
        title={`Årsredovisning ${data.fiscal_period.name}`}
        description={`${data.company.name} · ${data.company.org_number}`}
        action={
          <Button variant="outline" asChild>
            <Link href={`/bookkeeping/year-end?period=${periodId}`}>
              <ArrowLeft className="mr-2 h-4 w-4" /> Tillbaka till bokslut
            </Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Förvaltningsberättelse — narrativ</CardTitle>
          <p className="text-sm text-muted-foreground">
            Texten nedan visas i PDF:en. Förändringar är lokala till denna sida tills
            vidare; en framtida version kommer att spara dem mellan sessioner.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ar-description">Verksamhetsbeskrivning</Label>
            <Textarea
              id="ar-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-events">Väsentliga händelser</Label>
            <Textarea
              id="ar-events"
              value={importantEvents}
              onChange={(e) => setImportantEvents(e.target.value)}
              rows={4}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-rd">Resultatdisposition</Label>
            <Textarea
              id="ar-rd"
              value={resultatdisposition}
              onChange={(e) => setResultatdisposition(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ar-agm-date">Datum för årsstämma</Label>
            <Input
              id="ar-agm-date"
              type="date"
              value={agmDate}
              onChange={(e) => setAgmDate(e.target.value)}
              className="max-w-[220px]"
            />
            <p className="text-xs text-muted-foreground">
              Datum då årsstämman fastställde årsredovisningen — fyller i datumraden på
              fastställelseintyget i PDF:en (krävs för inlämning till Bolagsverket).
            </p>
          </div>
          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-muted-foreground">
              {hasUnsavedNarrative ? (
                <span>Ändringar sparas inte automatiskt.</span>
              ) : savedAt ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Sparat
                </span>
              ) : (
                <span>Alla ändringar är sparade.</span>
              )}
            </div>
            <Button
              onClick={handleSaveNarrative}
              disabled={savingNarrative || !hasUnsavedNarrative}
            >
              {savingNarrative ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sparar…
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" /> Spara texten
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Flerårsöversikt</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="py-2">År</th>
                <th className="py-2 text-right">Nettoomsättning</th>
                <th className="py-2 text-right">Resultat efter fin.</th>
                <th className="py-2 text-right">Soliditet</th>
              </tr>
            </thead>
            <tbody>
              {data.forvaltningsberattelse.flerarsoversikt.map((row) => (
                <tr key={row.year} className="border-b border-border last:border-b-0">
                  <td className="py-2">{row.year}</td>
                  <td className="py-2 text-right tabular-nums">
                    {row.net_revenue.toLocaleString('sv-SE')}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.result_after_financial.toLocaleString('sv-SE')}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.soliditet_pct === null
                      ? '—'
                      : `${row.soliditet_pct.toFixed(1)} %`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Underskrifter</CardTitle>
          <p className="text-sm text-muted-foreground">
            Lägg till varje styrelseledamot + VD som ska skriva under. BankID-signering
            kommer i en kommande version — för nu visas slottar och status här, och
            själva underskriften görs på pappret.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {signatures.length === 0 && (
            <p className="text-sm text-muted-foreground italic">
              Inga undertecknare tillagda än.
            </p>
          )}
          {signatures.map((sig) => (
            <div
              key={sig.id}
              className="flex items-center justify-between border-b border-border last:border-b-0 pb-3 last:pb-0"
            >
              <div>
                <p className="text-sm font-medium">{sig.signer_name}</p>
                <p className="text-xs text-muted-foreground">{sig.role}</p>
              </div>
              <div className="flex items-center gap-2">
                {sig.status === 'signed' ? (
                  <Badge variant="success">Signerad</Badge>
                ) : sig.status === 'declined' ? (
                  <Badge variant="destructive">Avböjd</Badge>
                ) : (
                  <>
                    <Badge variant="outline">Väntar på underskrift</Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleMarkSigned(sig.id)}
                    >
                      Markera som signerad
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 items-end pt-2">
            <div className="space-y-1">
              <Label htmlFor="signer-role" className="text-xs">
                Roll
              </Label>
              <select
                id="signer-role"
                className="border border-border rounded-md h-9 text-sm px-2 bg-background"
                value={signerRole}
                onChange={(e) => setSignerRole(e.target.value)}
              >
                <option>Styrelseledamot</option>
                <option>Styrelseordförande</option>
                <option>VD</option>
                <option>Verkställande direktör</option>
              </select>
            </div>
            <div className="space-y-1 flex-1 min-w-[200px]">
              <Label htmlFor="signer-name" className="text-xs">
                Namn
              </Label>
              <Input
                id="signer-name"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="t.ex. Anna Andersson"
                className="h-9"
              />
            </div>
            <Button onClick={handleAddSigner} disabled={!signerName.trim()}>
              <Plus className="mr-1 h-4 w-4" /> Lägg till
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ladda ner & lämna in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Ladda ner PDF-utkastet, granska, skriv ut och låt undertecknarna signera
            fastställelseintyget. Ladda sedan upp PDF:en till Bolagsverkets e-tjänst.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href={pdfUrl} target="_blank" rel="noopener noreferrer">
                <FileDown className="mr-2 h-4 w-4" /> Ladda ner PDF (utkast)
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link
                href="https://www.bolagsverket.se/foretag/aktiebolag/arsredovisning/lamna-in-arsredovisning"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" /> Bolagsverket Mina Sidor
              </Link>
            </Button>
          </div>
          {data.warnings.length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning-foreground space-y-1">
              <p className="font-medium">Innan inlämning till Bolagsverket:</p>
              <ul className="list-disc pl-5 space-y-1">
                {data.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-warning-foreground">
            <strong>Notis om digital inlämning:</strong> Bolagsverket har föreslagit att
            digital inlämning (iXBRL) av årsredovisning för aktiebolag ska bli
            obligatorisk — beslut och ikraftträdande är ännu inte fastställda. Idag är
            PDF-inlämning fortfarande godkänd. Gnubok stödjer för närvarande endast
            PDF-utkast; iXBRL-generering är planerad till en kommande version.
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
