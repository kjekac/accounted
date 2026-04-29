'use client'

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBranding } from '@/lib/branding/service'

interface RetentionNoticeProps {
  variant: 'company' | 'account'
  className?: string
}

/**
 * Shared BFL retention notice shown before destructive actions that
 * affect bookkeeping data. Keeps the legal copy consistent between the
 * account danger zone and the company danger zone.
 *
 * Swedish Bokföringslagen (BFL) 7 kap. 2§ requires räkenskapsinformation
 * to be retained for 7 years. gnubok is the system of record, so deleting
 * a company or an account does not remove the underlying data — it only
 * hides it from the UI and anonymizes PII where applicable.
 */
export function RetentionNotice({ variant, className }: RetentionNoticeProps) {
  const { appName } = getBranding()
  const copy =
    variant === 'company'
      ? {
          title: 'Bokföringen behålls i 7 år',
          body: (
            <>
              Enligt bokföringslagen (BFL 7 kap. 2§) sparas räkenskapsinformation i 7 år.
              När du raderar företaget döljs det i {appName.toLowerCase()}, men verifikationer, dokument och
              bokföring behålls säkert tills lagkravet löpt ut. Du kan{' '}
              <Link
                href="/settings/backup"
                className="underline underline-offset-2 hover:text-foreground"
              >
                ladda ner en säkerhetsbackup
              </Link>{' '}
              innan du fortsätter.
            </>
          ),
        }
      : {
          title: 'Kontoraderingen är permanent',
          body: (
            <>
              Ditt konto avidentifieras och du loggas ut från alla enheter.
              Räkenskapsinformation från företag du ägt behålls säkert i 7 år enligt BFL 7
              kap. 2§. Du kan inte skapa ett nytt konto med samma e-postadress — kontakta
              support om du vill återaktivera kontot i framtiden. Ladda gärna ner en{' '}
              <Link
                href="/settings/backup"
                className="underline underline-offset-2 hover:text-foreground"
              >
                säkerhetsbackup
              </Link>{' '}
              innan du fortsätter.
            </>
          ),
        }

  return (
    <div
      className={cn(
        'rounded-lg border border-destructive/30 bg-destructive/5 p-4',
        className
      )}
    >
      <div className="flex gap-3">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        <div className="space-y-1 text-sm">
          <p className="font-medium text-destructive">{copy.title}</p>
          <p className="text-muted-foreground">{copy.body}</p>
        </div>
      </div>
    </div>
  )
}
