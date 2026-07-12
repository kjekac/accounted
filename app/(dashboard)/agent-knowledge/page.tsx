import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId, getCompanyDisplayName } from '@/lib/company/context'
import { buildLedgerContext } from '@/lib/agent-context/ledger-context'
import { buildDeepEntities } from '@/lib/agent-context/ledger-deep'
import { buildAgentCompetence } from '@/lib/agent-context/agent-competence'
import { PageHeader } from '@/components/ui/page-header'
import { AgentKnowledgeView } from '@/components/agent-knowledge/AgentKnowledgeView'

// Derived per request from live bookings; never cache a stale profile.
export const dynamic = 'force-dynamic'

/**
 * "Vad din agent vet" (P2): the human-facing render of the same ledger-context
 * the AI agent reads before booking. Fetches server-side via the shared
 * lib/agent-context aggregation (one payload, two renderers) and shows it as a
 * readable profile of how this company books. Read-only, no interactive
 * controls, so a plain Server Component.
 */
export default async function AgentKnowledgePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const [t, context, deep, competence, companyName] = await Promise.all([
    getTranslations('agentKnowledge'),
    buildLedgerContext(supabase, companyId),
    buildDeepEntities(supabase, companyId),
    buildAgentCompetence(supabase, companyId),
    getCompanyDisplayName(supabase, companyId),
  ])

  return (
    <div className="space-y-8">
      <PageHeader title={t('title')} description={t('description')} />
      <AgentKnowledgeView
        context={context}
        deep={deep}
        competence={competence}
        companyName={companyName ?? ''}
      />
    </div>
  )
}
