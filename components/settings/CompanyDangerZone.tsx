'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useCompany } from '@/contexts/CompanyContext'
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
import { RetentionNotice } from '@/components/ui/retention-notice'
import { Loader2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()

/**
 * Danger zone for the currently-active company. Only visible to owners.
 *
 * Archive = soft delete: companies.archived_at is stamped via
 * POST /api/company/[id]/delete. All bookkeeping data is retained per
 * BFL 7 kap. 2§; the row just disappears from the user's UI.
 *
 * TODO(bankid): once users have a linked BankID identity, wrap the
 * confirm step in a BankID signature gate. Guarded behind a
 * capabilities.bankIdLinked boolean fetched from the user profile.
 */
export function CompanyDangerZone() {
  const router = useRouter()
  const { toast } = useToast()
  const { company, role } = useCompany()

  const [showDialog, setShowDialog] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)

  if (!company || role !== 'owner') return null

  async function handleDelete() {
    if (!company) return
    if (confirmText.trim() !== company.name.trim()) return

    setIsDeleting(true)
    try {
      const res = await fetch(`/api/company/${company.id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_name: confirmText }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Kunde inte radera företaget')
      }

      toast({ title: 'Företaget raderades', description: company.name })
      // Stay inside settings. If the user had another company, the dashboard
      // layout will resolve it and /settings/account still renders as
      // normal. If this was their last company, the layout falls into the
      // no-company shell rooted at /settings/account.
      router.push('/settings/account')
      router.refresh()
    } catch (err) {
      toast({
        title: 'Kunde inte radera företaget',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
      setIsDeleting(false)
    }
  }

  return (
    <>
      <section className="space-y-4 border-t border-border/8 pt-8">
        <h2 className="text-sm font-medium uppercase tracking-wider text-destructive/80">
          Radera företag
        </h2>

        <RetentionNotice variant="company" />

        <div className="flex justify-end">
          <Button
            variant="destructive"
            className="w-full sm:w-auto"
            onClick={() => setShowDialog(true)}
          >
            Radera företag
          </Button>
        </div>
      </section>

      <Dialog
        open={showDialog}
        onOpenChange={(open) => {
          if (isDeleting) return
          setShowDialog(open)
          if (!open) setConfirmText('')
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Radera {company.name}</DialogTitle>
            <DialogDescription>
              Företaget döljs från {branding.appName.toLowerCase()}. Bokföringen behålls säkert i 7 år enligt BFL.
              Skriv företagets namn exakt för att bekräfta.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="company-delete-confirm">
              Skriv <strong>{company.name}</strong> för att bekräfta
            </Label>
            <Input
              id="company-delete-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={company.name}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDialog(false)
                setConfirmText('')
              }}
              disabled={isDeleting}
            >
              Avbryt
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={confirmText.trim() !== company.name.trim() || isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Raderar...
                </>
              ) : (
                'Radera företag'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
