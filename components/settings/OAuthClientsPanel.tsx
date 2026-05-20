'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Plus, Trash2, Globe } from 'lucide-react'

interface OAuthClient {
  id: string
  client_name: string
  redirect_uri: string
  created_at: string
  revoked_at: string | null
}

export function OAuthClientsPanel() {
  const { toast } = useToast()
  const { dialogProps: revokeDialogProps, confirm: confirmRevoke } = useDestructiveConfirm()

  const [clients, setClients] = useState<OAuthClient[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [clientName, setClientName] = useState('')
  const [redirectUri, setRedirectUri] = useState('')

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/oauth-clients')
      const json = await res.json()
      if (json.data) {
        setClients(json.data.filter((c: OAuthClient) => !c.revoked_at))
      }
    } catch {
      toast({ title: 'Kunde inte hämta OAuth-klienter', variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchClients()
  }, [fetchClients])

  async function handleCreate() {
    setIsCreating(true)
    try {
      const res = await fetch('/api/settings/oauth-clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: clientName.trim() || 'OAuth-klient',
          redirect_uri: redirectUri.trim(),
        }),
      })
      const json = await res.json()

      if (!res.ok) {
        toast({ title: json.error ?? 'Kunde inte registrera redirect URI', variant: 'destructive' })
        return
      }

      setShowCreateDialog(false)
      setClientName('')
      setRedirectUri('')
      fetchClients()
    } catch {
      toast({ title: 'Kunde inte registrera redirect URI', variant: 'destructive' })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleRevoke(id: string, name: string) {
    const ok = await confirmRevoke({
      title: 'Återkalla OAuth-klient',
      description: `"${name}" tas bort från allowlist. Pågående auth-flöden slutar fungera direkt; redan utfärdade API-nycklar fortsätter att gälla tills de återkallas separat.`,
      confirmLabel: 'Återkalla',
    })
    if (!ok) return

    try {
      const res = await fetch(`/api/settings/oauth-clients/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        // Surface the server error rather than optimistically pretending the
        // revocation succeeded — a silent fail leaves the row in the
        // allowlist while the UI says it's gone, which is the opposite of
        // what the user expected.
        const body = await res.json().catch(() => ({}))
        toast({
          title: body?.error || 'Kunde inte återkalla klient',
          variant: 'destructive',
        })
        return
      }
      setClients((prev) => prev.filter((c) => c.id !== id))
      toast({ title: 'Klient återkallad' })
    } catch {
      toast({ title: 'Kunde inte återkalla klient', variant: 'destructive' })
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('sv-SE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>OAuth-klienter</CardTitle>
              <CardDescription>
                Registrera redirect-URI:er för egenutvecklade MCP-klienter. Claude.ai och localhost
                är redan godkända som standard — registrera bara här om du bygger en egen app.
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => setShowCreateDialog(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Registrera URI
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : clients.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Globe className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">Inga egna OAuth-klienter registrerade.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Bygger du en agent som ska ansluta via OAuth? Registrera dess callback-URI här.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {clients.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded-md border px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{c.client_name}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <code className="text-xs text-muted-foreground font-mono truncate">
                        {c.redirect_uri}
                      </code>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        Registrerad {formatDate(c.created_at)}
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRevoke(c.id, c.client_name)}
                    aria-label={`Återkalla ${c.client_name}`}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrera redirect URI</DialogTitle>
            <DialogDescription>
              Bara för egenbyggda MCP-klienter med en publik HTTPS-callback. Lägg{' '}
              <span className="font-medium">inte</span> till{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">localhost</code>{' '}
              eller{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">claude.ai</code>{' '}
              — de fungerar redan utan registrering. URI:n jämförs ord-för-ord mot
              redirect_uri-parametern i OAuth-flödet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="client-name">Klientnamn</Label>
              <Input
                id="client-name"
                placeholder="t.ex. Min bokföringsagent"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="redirect-uri">Redirect URI</Label>
              <Input
                id="redirect-uri"
                type="url"
                placeholder="https://min-agent.exempel.se/oauth/callback"
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && redirectUri && handleCreate()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Avbryt
            </Button>
            <Button onClick={handleCreate} disabled={isCreating || !redirectUri.trim()}>
              {isCreating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Registrera
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...revokeDialogProps} />
    </div>
  )
}
