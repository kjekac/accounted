#!/usr/bin/env npx tsx
/**
 * Smoke test: send a 1-token request to Bedrock with both the Opus and
 * Sonnet model ids the agent uses. Confirms AWS creds + region work and
 * the models are enabled on the account before we exercise the full chat
 * loop with real user data.
 *
 * Usage: npx tsx scripts/smoke-bedrock.ts
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { OPUS_MODEL, SONNET_MODEL } from '../lib/agent/composer/client'
import { bedrockAnthropicProvider, textMessage } from '../lib/agent/model-provider'

async function ping(model: string): Promise<void> {
  const start = Date.now()
  try {
    const text = await bedrockAnthropicProvider.generateText({
      model,
      maxTokens: 10,
      messages: [textMessage('user', 'Säg "hej" på svenska.')],
    })
    console.log(`  ✓ ${model} — ${Date.now() - start}ms — "${text.trim()}"`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`  ✗ ${model} — ${message}`)
    process.exitCode = 1
  }
}

async function main() {
  console.log(`Region: ${process.env.AWS_REGION || 'eu-north-1'}`)
  console.log('Pinging Bedrock for both agent models…\n')
  await ping(SONNET_MODEL)
  await ping(OPUS_MODEL)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
