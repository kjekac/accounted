'use client'

import Link from 'next/link'
import {
  ArrowRight,
  FileText,
  Landmark,
  ArrowRightLeft,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()

interface NewUserChecklistProps {
  onFreshStart: () => void
  className?: string
}

export default function NewUserChecklist({
  onFreshStart,
  className,
}: NewUserChecklistProps) {
  const hasMigration = ENABLED_EXTENSION_IDS.has('arcim-migration')
  const hasBanking = ENABLED_EXTENSION_IDS.has('enable-banking')

  return (
    <div className={cn('min-h-[75vh] flex flex-col items-center justify-center px-4 sm:px-0 stagger-enter', className)}>
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8 md:mb-12">
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
            Välkommen till {branding.appName.toLowerCase()}
          </h1>
          <p className="text-muted-foreground text-sm md:text-base leading-relaxed max-w-md mx-auto mt-3">
            Börja med att hämta din bokföring, sedan kopplar du banken.
            Ingenting ändras i ditt nuvarande system.
          </p>
        </div>

        {/* Step 1: Migrate bookkeeping */}
        <div className="mb-6 md:mb-8">
          <div className="flex items-center gap-3 mb-4">
            <span className="h-7 w-7 rounded-full bg-foreground text-background flex items-center justify-center text-xs font-semibold flex-shrink-0 tabular-nums">
              1
            </span>
            <h2 className="font-display text-base font-medium tracking-tight">
              Hämta din bokföring
            </h2>
          </div>

          <div className="space-y-3 ml-0 sm:ml-10">
            {hasMigration && (
              <Link
                href="/import?mode=migration"
                className="group block p-4 sm:p-5 rounded-xl border border-primary/20 bg-primary/[0.02] hover:bg-primary/[0.05] hover:border-primary/40 transition-all duration-150 active:scale-[0.99]"
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="p-2 sm:p-2.5 rounded-lg bg-primary/[0.08] group-hover:bg-primary/[0.12] transition-colors flex-shrink-0">
                    <ArrowRightLeft className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                      Hämta från annat system
                    </p>
                    <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed underline decoration-foreground/20 underline-offset-2">
                      Inget ändras i ditt befintliga system.
                    </p>
                    <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-2.5 sm:mt-3">
                      {([
                        { name: 'Fortnox', logo: '/logos/fortnox.svg' },
                        { name: 'Visma', logo: '/logos/visma.jpeg' },
                        { name: 'Bokio', logo: '/logos/bokio.png' },
                        { name: 'Björn Lundén', logo: '/logos/bjornlunden.png' },
                        { name: 'Briox', logo: '/logos/Briox_logo.png' },
                      ] as const).map(provider => (
                        <div key={provider.name} className="flex items-center gap-1 sm:gap-1.5 rounded border border-border/60 bg-muted/30 px-1.5 sm:px-2 py-0.5 sm:py-1">
                          <img src={provider.logo} alt={provider.name} className="h-3.5 w-3.5 sm:h-4 sm:w-4 shrink-0 rounded-sm object-contain" />
                          <span className="text-[10px] sm:text-[11px] font-medium text-muted-foreground">{provider.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
                </div>
              </Link>
            )}

            <Link
              href="/import?mode=sie"
              className="group block p-4 sm:p-5 rounded-xl border border-border/60 hover:border-primary/40 hover:bg-primary/[0.02] transition-all duration-150 active:scale-[0.99]"
            >
              <div className="flex items-start gap-3 sm:gap-4">
                <div className="p-2 sm:p-2.5 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                  <FileText className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                    Importera SIE-fil
                  </p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed">
                    Exportera en SIE4-fil från ditt nuvarande bokföringsprogram och ladda upp den här.
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
              </div>
            </Link>
          </div>
        </div>

        {/* Step 2: Connect bank */}
        <div className="mb-8 md:mb-12">
          <div className="flex items-center gap-3 mb-4">
            <span className="h-7 w-7 rounded-full bg-foreground text-background flex items-center justify-center text-xs font-semibold flex-shrink-0 tabular-nums">
              2
            </span>
            <h2 className="font-display text-base font-medium tracking-tight">
              Koppla din bank
            </h2>
          </div>

          <div className="ml-0 sm:ml-10">
            <Link
              href={hasBanking ? '/import?mode=psd2' : '/import?mode=bank'}
              className="group block p-4 sm:p-5 rounded-xl border border-border/60 hover:border-primary/40 hover:bg-primary/[0.02] transition-all duration-150 active:scale-[0.99]"
            >
              <div className="flex items-start gap-3 sm:gap-4">
                <div className="p-2 sm:p-2.5 rounded-lg bg-muted/60 group-hover:bg-primary/[0.08] transition-colors flex-shrink-0">
                  <Landmark className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium group-hover:text-primary transition-colors text-sm sm:text-base">
                    Anslut ditt bankkonto
                  </p>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5 leading-relaxed">
                    {hasBanking
                      ? 'Koppla via PSD2 — transaktioner synkas automatiskt varje dag.'
                      : 'Importera kontoutdrag från din bank — CSV, OFX och de flesta svenska banker.'}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-primary/60 mt-1 flex-shrink-0 transition-colors" />
              </div>
            </Link>
          </div>
        </div>

        {/* Escape hatch */}
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-border/60" />
            <span className="text-xs text-muted-foreground">eller</span>
            <div className="flex-1 h-px bg-border/60" />
          </div>

          <div className="text-center">
            <button
              onClick={onFreshStart}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1.5 group"
            >
              Jag startar en ny verksamhet utan tidigare bokföring
              <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>

          <div className="flex items-center justify-center gap-2 pt-2">
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground/50">
              Din data är krypterad och lagras säkert i Sverige
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
