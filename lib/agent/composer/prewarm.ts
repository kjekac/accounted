import { getModelProvider, textMessage } from '@/lib/agent/model-provider'
import { SONNET_MODEL } from './client'

// Cache pre-warm after composition: fire a max_tokens: 1 request with the
// assembled atom bodies so the Block 1 cache prefix lands warm before the
// user's first chat turn. Best-effort — if this fails, the loop still works,
// just with a cold first turn.
//
// Bodies come from the DB (agent_atom_registry.body), not disk — so pre-warm
// no longer depends on .claude/skills being present at runtime. In dev before
// `npm run skills:generate` has seeded bodies, the list is empty and pre-warm
// simply no-ops (a cold first turn, which is acceptable for a dev convenience).
//
// Note: we use maxTokens: 1 (not 0). Providers generally require at least one
// output token. Pre-warm cost is dominated by input processing, so a single
// output token is negligible.
//
// Plan ref: §6 (cache pre-warming), §10 (caching strategy).

export async function preWarmAtomCache(opts: {
  atomBodies: string[]
  ttl?: '5m' | '1h'
}): Promise<void> {
  const { atomBodies, ttl = '1h' } = opts

  const bodies = atomBodies.filter((b) => b && b.length > 0)
  if (bodies.length === 0) return

  const provider = getModelProvider()
  if (provider.name !== 'bedrock-anthropic') return

  try {
    await provider.generateText({
      model: SONNET_MODEL,
      maxTokens: 1,
      system: [
        {
          kind: 'text',
          text: bodies.join('\n\n---\n\n'),
          cache: { type: 'ephemeral', ttl },
        },
      ],
      messages: [textMessage('user', 'warmup')],
    })
  } catch {
    // Fire-and-forget — pre-warm failure must never block the composer.
  }
}
