'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Plus, Copy, Check, Trash2, Key, ChevronDown } from 'lucide-react'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()
const connectorName = branding.appName.toLowerCase()

const SCOPE_GROUPS = [
  {
    domain: 'transactions',
    label: 'Transaktioner',
    read: 'transactions:read' as const,
    readLabel: 'Läs — lista transaktioner, mallförslag, kategoriförslag',
    readTools: 3,
    write: 'transactions:write' as const,
    writeLabel: 'Skriv — kategorisera, kvittomatchning, koppling mot faktura',
    writeTools: 3,
  },
  {
    domain: 'customers',
    label: 'Kunder',
    read: 'customers:read' as const,
    readLabel: 'Läs — lista kunder',
    readTools: 1,
    write: 'customers:write' as const,
    writeLabel: 'Skriv — skapa kunder',
    writeTools: 1,
  },
  {
    domain: 'invoices',
    label: 'Fakturor',
    read: 'invoices:read' as const,
    readLabel: 'Läs — lista fakturor',
    readTools: 1,
    write: 'invoices:write' as const,
    writeLabel: 'Skriv — skapa, skicka, markera betald/skickad',
    writeTools: 4,
  },
  {
    domain: 'suppliers',
    label: 'Leverantörer',
    read: 'suppliers:read' as const,
    readLabel: 'Läs — lista leverantörer och leverantörsfakturor',
    readTools: 2,
    write: null,
    writeLabel: null,
    writeTools: 0,
  },
  {
    domain: 'reports',
    label: 'Rapporter',
    read: 'reports:read' as const,
    readLabel: 'Läs — kontoplan, huvudbok, balansräkning, resultaträkning, moms, KPI, kundreskontra, leverantörsreskontra, räkenskapsperioder, bankavstämning',
    readTools: 11,
    write: null,
    writeLabel: null,
    writeTools: 0,
  },
] as const

type Scope =
  | 'transactions:read' | 'transactions:write'
  | 'customers:read' | 'customers:write'
  | 'invoices:read' | 'invoices:write'
  | 'suppliers:read'
  | 'reports:read'

const ALL_SCOPES: Scope[] = SCOPE_GROUPS.flatMap((g) =>
  g.write ? [g.read, g.write] : [g.read]
)

/** Map scope key → display label for badges */
const SCOPE_LABELS: Record<Scope, string> = {
  'transactions:read': 'Transaktioner (läs)',
  'transactions:write': 'Transaktioner (skriv)',
  'customers:read': 'Kunder (läs)',
  'customers:write': 'Kunder (skriv)',
  'invoices:read': 'Fakturor (läs)',
  'invoices:write': 'Fakturor (skriv)',
  'suppliers:read': 'Leverantörer (läs)',
  'reports:read': 'Rapporter (läs)',
}

interface ApiKey {
  id: string
  key_prefix: string
  name: string
  scopes: string[] | null
  rate_limit_rpm: number
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable (insecure context) — silently ignore
    }
  }

  return (
    <div className="relative group">
      <pre className="rounded-md bg-muted p-4 pr-12 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-1.5 top-1.5 h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleCopy}
        aria-label="Kopiera"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-600" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  )
}

export function ApiKeysPanel() {
  const { toast } = useToast()
  const { dialogProps: revokeDialogProps, confirm: confirmRevoke } = useDestructiveConfirm()

  const [keys, setKeys] = useState<ApiKey[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showKeyDialog, setShowKeyDialog] = useState(false)
  const [showApiKeyMethods, setShowApiKeyMethods] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyScopes, setNewKeyScopes] = useState<Set<Scope>>(new Set(ALL_SCOPES))
  const [newKeyValue, setNewKeyValue] = useState('')
  const [copied, setCopied] = useState(false)

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/api-keys')
      const json = await res.json()
      if (json.data) {
        setKeys(json.data.filter((k: ApiKey) => !k.revoked_at))
      }
    } catch {
      toast({ title: 'Fel', description: 'Kunde inte hämta API-nycklar', variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [toast])

  useEffect(() => {
    fetchKeys()
  }, [fetchKeys])

  async function handleCreate() {
    setIsCreating(true)
    try {
      const res = await fetch('/api/settings/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newKeyName || 'MCP-nyckel', scopes: Array.from(newKeyScopes) }),
      })
      const json = await res.json()

      if (!res.ok) {
        toast({ title: 'Fel', description: json.error, variant: 'destructive' })
        return
      }

      setNewKeyValue(json.data.key)
      setShowCreateDialog(false)
      setShowKeyDialog(true)
      setNewKeyName('')
      setNewKeyScopes(new Set(ALL_SCOPES))
      fetchKeys()
    } catch {
      toast({ title: 'Fel', description: 'Kunde inte skapa nyckel', variant: 'destructive' })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleRevoke(id: string, name: string) {
    const ok = await confirmRevoke({
      title: 'Återkalla API-nyckel',
      description: `"${name}" återkallas permanent. Alla klienter som använder nyckeln slutar fungera omedelbart.`,
      confirmLabel: 'Återkalla',
    })
    if (!ok) return

    try {
      await fetch(`/api/settings/api-keys/${id}`, { method: 'DELETE' })
      setKeys((prev) => prev.filter((k) => k.id !== id))
      toast({ title: 'Nyckel återkallad' })
    } catch {
      toast({ title: 'Fel', description: 'Kunde inte återkalla nyckel', variant: 'destructive' })
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(newKeyValue)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function formatDate(iso: string | null) {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('sv-SE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const mcpUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/extensions/ext/mcp-server/mcp`
    : '/api/extensions/ext/mcp-server/mcp'

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>API-nycklar</CardTitle>
              <CardDescription>
                Hantera nycklar för MCP-klienter (Claude, Cursor) och andra integrationer.
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => setShowCreateDialog(true)}
              disabled={keys.length >= 10}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Skapa nyckel
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Key className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">Inga API-nycklar ännu.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Skapa en nyckel för att koppla din MCP-klient.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {keys.map((key) => {
                const scopeCount = key.scopes?.length ?? 0
                return (
                  <div
                    key={key.id}
                    className="flex items-center justify-between rounded-md border px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{key.name}</p>
                        <span className="text-xs text-muted-foreground">
                          {scopeCount === ALL_SCOPES.length
                            ? 'Alla behörigheter'
                            : scopeCount === 0
                              ? 'Inga behörigheter'
                              : `${scopeCount} behörigheter`}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <code className="text-xs text-muted-foreground font-mono">
                          {key.key_prefix}...
                        </code>
                        <span className="text-xs text-muted-foreground">
                          Skapad {formatDate(key.created_at)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {key.last_used_at
                            ? `Använd ${formatDate(key.last_used_at)}`
                            : 'Aldrig använd'}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(key.id, key.name)}
                      aria-label={`Återkalla ${key.name}`}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Anslut MCP-klient</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <p className="text-sm font-medium">Claude.ai</p>
              <Badge variant="secondary" className="text-[10px] font-normal px-1.5 py-0">Rekommenderat</Badge>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              Gå till <strong>Settings &rarr; Integrations &rarr; Add Integration</strong> och klistra in MCP-serverns URL.
              Du loggas in via ditt {connectorName}-konto — ingen API-nyckel behövs.
            </p>
            <CopyBlock text={mcpUrl} />
          </div>

          <div>
            <p className="text-sm font-medium mb-2">Claude Code / Cursor</p>
            <p className="text-xs text-muted-foreground mb-2">
              Kör i terminalen — loggar in via webbläsaren:
            </p>
            <CopyBlock text={`claude mcp add ${connectorName} --transport http ${mcpUrl}`} />
          </div>

          <div className="border-t pt-4">
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowApiKeyMethods(!showApiKeyMethods)}
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showApiKeyMethods ? '' : '-rotate-90'}`} />
              Anslut med API-nyckel istället
            </button>
            {showApiKeyMethods && (
              <div className="space-y-6 pt-4 animate-in slide-in-from-top-1 duration-150">
                <div>
                  <p className="text-sm font-medium mb-1">Claude Desktop</p>
                  <p className="text-xs text-muted-foreground mb-2">
                    Lägg till i <code className="text-xs">claude_desktop_config.json</code> (Inställningar &rarr; Developer):
                  </p>
                  <CopyBlock text={`{
  "mcpServers": {
    "${connectorName}": {
      "command": "npx",
      "args": ["gnubok-mcp"],
      "env": {
        "GNUBOK_API_KEY": "gnubok_sk_..."
      }
    }
  }
}`} />
                </div>

                <div>
                  <p className="text-sm font-medium mb-1">Claude Code / Cursor</p>
                  <p className="text-xs text-muted-foreground mb-2">
                    Kör i terminalen med en API-nyckel:
                  </p>
                  <CopyBlock text={`claude mcp add ${connectorName} --transport http \\
  --url ${mcpUrl} \\
  --header "Authorization: Bearer gnubok_sk_..."`} />
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Create key dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Skapa API-nyckel</DialogTitle>
            <DialogDescription>
              Ge nyckeln ett namn så du vet vad den används till.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">Namn</Label>
              <Input
                id="key-name"
                placeholder="t.ex. Claude Desktop"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div className="space-y-2">
              <Label>Behörigheter</Label>
              <p className="text-xs text-muted-foreground">
                Välj vad nyckeln ska ha åtkomst till.
              </p>
              <div className="space-y-3 pt-1">
                {SCOPE_GROUPS.map((group) => (
                  <div key={group.domain} className="space-y-1.5">
                    <p className="text-sm font-medium">{group.label}</p>
                    <div className="space-y-1 pl-1">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                          checked={newKeyScopes.has(group.read)}
                          onCheckedChange={(checked) => {
                            setNewKeyScopes((prev) => {
                              const next = new Set(prev)
                              if (checked) {
                                next.add(group.read)
                              } else {
                                next.delete(group.read)
                                // Remove write too — write without read makes no sense
                                if (group.write) next.delete(group.write)
                              }
                              return next
                            })
                          }}
                        />
                        <span className="text-xs text-muted-foreground">{group.readLabel}</span>
                        <span className="text-[10px] tabular-nums text-muted-foreground/60">{group.readTools} verktyg</span>
                      </label>
                      {group.write && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox
                            checked={newKeyScopes.has(group.write)}
                            onCheckedChange={(checked) => {
                              setNewKeyScopes((prev) => {
                                const next = new Set(prev)
                                if (checked) {
                                  next.add(group.write!)
                                  // Auto-check read when write is checked
                                  next.add(group.read)
                                } else {
                                  next.delete(group.write!)
                                }
                                return next
                              })
                            }}
                          />
                          <span className="text-xs text-muted-foreground">{group.writeLabel}</span>
                          <span className="text-[10px] tabular-nums text-muted-foreground/60">{group.writeTools} verktyg</span>
                        </label>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Avbryt
            </Button>
            <Button onClick={handleCreate} disabled={isCreating || newKeyScopes.size === 0}>
              {isCreating && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Skapa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...revokeDialogProps} />

      {/* Show key once dialog */}
      <Dialog open={showKeyDialog} onOpenChange={(open) => {
        if (!open) {
          setNewKeyValue('')
          setCopied(false)
        }
        setShowKeyDialog(open)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Din nya API-nyckel</DialogTitle>
            <DialogDescription>
              Kopiera nyckeln nu. Den visas bara en gång.
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <code className="block rounded-md bg-muted p-4 pr-12 text-sm font-mono break-all">
              {newKeyValue}
            </code>
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-2 top-2"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setShowKeyDialog(false)
              setNewKeyValue('')
              setCopied(false)
            }}>
              Klar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
