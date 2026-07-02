import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'
import type { ModelProvider, StreamWithToolsInput } from '@/lib/agent/model-provider'

// Verifies the extended-thinking ("tänka längre") wiring: an opted-in intent
// gets a provider thinking budget + bumped maxTokens on the model call, an
// intent without it gets neither; and reasoning blocks are stripped before
// persistence.
const streamWithToolsMock = vi.fn(async (args: StreamWithToolsInput) => {
  const response = await modelResponseQueue()
  for (const block of response.content) {
    if (block.kind === 'text') args.onEvent?.({ kind: 'text_delta', delta: block.text })
  }
  return response
})
const modelResponseQueue = vi.fn()
const fakeProvider: ModelProvider = {
  name: 'disabled',
  generateText: vi.fn(),
  generateStructured: vi.fn(),
  streamWithTools: streamWithToolsMock,
}
vi.mock('@/lib/agent/model-provider', () => ({
  getModelProvider: () => fakeProvider,
}))

vi.mock('../system-prompt', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue({
    blocks: [],
    promptHash: 'sha256:test',
    atomsLoaded: [],
  }),
}))

const getManyMock = vi.fn()
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: {
    get: () => undefined,
    getMany: (...args: unknown[]) => getManyMock(...args),
  },
}))

import { runChatTurn, stripReasoning } from '../run-turn'

function fakeSupabase() {
  const passthrough: Record<string, unknown> = {}
  const proxy: unknown = new Proxy(passthrough, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      }
      return () => proxy
    },
  })
  return proxy as unknown as Parameters<typeof runChatTurn>[0]['supabase']
}

function baseIntent(): AgentIntent {
  return {
    id: 'general.help',
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'progressive', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: [],
    model: 'claude-sonnet-4-6',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

async function runWith(intent: AgentIntent) {
  modelResponseQueue.mockResolvedValueOnce({
    content: [{ kind: 'text', text: 'ok' }],
    stopReason: 'end_turn',
  })
  getManyMock.mockResolvedValue([])
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'u',
    companyId: 'c',
    companyName: 'X',
    firstName: 'A',
    intent,
    conversationId: 'conv',
    userMessage: 'hej',
    persist: false,
    emit: () => true,
  })
  return streamWithToolsMock.mock.calls[0][0]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runChatTurn — extended thinking wiring', () => {
  it('passes a thinking config and bumps max_tokens when the intent opts in', async () => {
    const args = await runWith({ ...baseIntent(), thinking: { budgetTokens: 2000 } })
    expect(args.thinkingBudgetTokens).toBe(2000)
    // budget must be strictly below max_tokens — we add the normal output budget.
    expect(args.maxTokens).toBe(2000 + 4096)
  })

  it('omits thinking and keeps the default budget when the intent does not opt in', async () => {
    const args = await runWith(baseIntent())
    expect(args.thinkingBudgetTokens).toBeUndefined()
    expect(args.maxTokens).toBe(4096)
  })
})

describe('stripReasoning', () => {
  it('drops reasoning and redacted_reasoning blocks but keeps text and tool_call', () => {
    const blocks = [
      { kind: 'reasoning', text: 'raw chain of thought', providerMetadata: { signature: 'sig' } },
      { kind: 'redacted_reasoning', providerMetadata: { data: 'xxx' } },
      { kind: 'text', text: 'svar' },
      { kind: 'tool_call', id: 't1', name: 'gnubok_load_skill', input: {} },
    ]
    expect(stripReasoning(blocks)).toEqual([
      { kind: 'text', text: 'svar' },
      { kind: 'tool_call', id: 't1', name: 'gnubok_load_skill', input: {} },
    ])
  })

  it('is a no-op when there are no thinking blocks', () => {
    const blocks = [{ kind: 'text', text: 'x' }]
    expect(stripReasoning(blocks)).toEqual(blocks)
  })
})
