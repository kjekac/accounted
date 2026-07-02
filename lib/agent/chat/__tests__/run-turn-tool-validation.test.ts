import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentIntent } from '@/lib/agent/intents/types'
import type { AgentTool } from '@/lib/agent/tools/types'
import type { ModelProvider, StreamWithToolsInput } from '@/lib/agent/model-provider'
import { MalformedModelToolCallError } from '@/lib/agent/model-provider/types'
import type { StreamEvent } from '../run-turn'

const modelResponseQueue = vi.fn()
const streamWithToolsMock = vi.fn(async (args: StreamWithToolsInput) => {
  const response = await modelResponseQueue(args)
  for (const block of response.content) {
    if (block.kind === 'text') args.onEvent?.({ kind: 'text_delta', delta: block.text })
    if (block.kind === 'tool_call') {
      args.onEvent?.({ kind: 'tool_call', id: block.id, name: block.name, input: block.input })
    }
  }
  return response
})

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
    getMany: (...args: unknown[]) => getManyMock(...args),
  },
}))

import { runChatTurn } from '../run-turn'

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

function categorizationIntent(): AgentIntent {
  return {
    id: 'transaction.categorization',
    buttonLabel: 'x',
    sheetTitle: 'x',
    atoms: { mode: 'declarative', horizontal: [], includeCompanyVertical: false, includeCompanyModifiers: false },
    tools: ['gnubok_categorize_transaction'],
    model: 'claude-sonnet-4-6',
    capture: async () => ({}),
    promptTemplate: () => '',
  }
}

function categorizeTool(execute = vi.fn().mockResolvedValue({ staged: true, risk_level: 'medium' })): AgentTool {
  return {
    name: 'gnubok_categorize_transaction',
    description: 'Categorize',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: { type: 'string' },
        category: { type: 'string', enum: ['expense_software', 'expense_other'] },
      },
      required: ['transaction_id', 'category'],
    },
    execute,
  }
}

async function run(events: StreamEvent[] = []) {
  await runChatTurn({
    supabase: fakeSupabase(),
    userId: 'user-1',
    companyId: 'company-1',
    companyName: 'Acme AB',
    firstName: 'Anna',
    intent: categorizationIntent(),
    conversationId: 'conv-1',
    contextRef: 'transaction:tx-expected',
    userMessage: 'Kategorisera transaction_id: tx-expected',
    persist: false,
    emit: (event) => {
      events.push(event)
      return true
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runChatTurn tool-call validation', () => {
  it('executes a valid intent-scoped tool call', async () => {
    const execute = vi.fn().mockResolvedValue({ staged: true, risk_level: 'medium' })
    getManyMock.mockResolvedValue([categorizeTool(execute)])
    modelResponseQueue
      .mockResolvedValueOnce({
        content: [
          {
            kind: 'tool_call',
            id: 'tool-1',
            name: 'gnubok_categorize_transaction',
            input: { transaction_id: 'tx-expected', category: 'expense_software' },
          },
        ],
        stopReason: 'tool_call',
      })
      .mockResolvedValueOnce({ content: [{ kind: 'text', text: 'Klart.' }], stopReason: 'end_turn' })

    await run()

    expect(execute).toHaveBeenCalledWith(
      { transaction_id: 'tx-expected', category: 'expense_software' },
      'company-1',
      'user-1',
      expect.anything(),
      expect.objectContaining({ type: 'agent_chat', id: 'conv-1' }),
    )
  })

  it('rejects a schema-invalid tool call before execution', async () => {
    const execute = vi.fn()
    getManyMock.mockResolvedValue([categorizeTool(execute)])
    modelResponseQueue
      .mockResolvedValueOnce({
        content: [
          {
            kind: 'tool_call',
            id: 'tool-1',
            name: 'gnubok_categorize_transaction',
            input: { transaction_id: 'tx-expected', category: 'made_up' },
          },
        ],
        stopReason: 'tool_call',
      })
      .mockResolvedValueOnce({ content: [{ kind: 'text', text: 'Jag behöver justera.' }], stopReason: 'end_turn' })

    const events: StreamEvent[] = []
    await run(events)

    expect(execute).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_result',
        result: expect.objectContaining({ error: expect.stringContaining('enum-listan') }),
      }),
    )
  })

  it('rejects a hallucinated tool name even if a different tool is registered for the intent', async () => {
    const execute = vi.fn()
    getManyMock.mockResolvedValue([categorizeTool(execute)])
    modelResponseQueue
      .mockResolvedValueOnce({
        content: [
          {
            kind: 'tool_call',
            id: 'tool-1',
            name: 'gnubok_create_voucher',
            input: { entry_date: '2026-07-01', lines: [] },
          },
        ],
        stopReason: 'tool_call',
      })
      .mockResolvedValueOnce({ content: [{ kind: 'text', text: 'Jag kan inte använda det här.' }], stopReason: 'end_turn' })

    const events: StreamEvent[] = []
    await run(events)

    expect(execute).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_result',
        result: expect.objectContaining({ error: expect.stringContaining('inte tillåtet') }),
      }),
    )
  })

  it('rejects a categorization for the wrong transaction id before execution', async () => {
    const execute = vi.fn()
    getManyMock.mockResolvedValue([categorizeTool(execute)])
    modelResponseQueue
      .mockResolvedValueOnce({
        content: [
          {
            kind: 'tool_call',
            id: 'tool-1',
            name: 'gnubok_categorize_transaction',
            input: { transaction_id: 'tx-other', category: 'expense_software' },
          },
        ],
        stopReason: 'tool_call',
      })
      .mockResolvedValueOnce({ content: [{ kind: 'text', text: 'Jag håller mig till rätt rad.' }], stopReason: 'end_turn' })

    const events: StreamEvent[] = []
    await run(events)

    expect(execute).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool_result',
        result: expect.objectContaining({ error: expect.stringContaining('Fel transaction_id') }),
      }),
    )
  })

  it('recovers from malformed local-model tool JSON with a repair prompt', async () => {
    getManyMock.mockResolvedValue([categorizeTool()])
    modelResponseQueue
      .mockRejectedValueOnce(new MalformedModelToolCallError('Model returned invalid JSON.'))
      .mockResolvedValueOnce({ content: [{ kind: 'text', text: 'Jag behöver fråga först.' }], stopReason: 'end_turn' })

    await run()

    expect(streamWithToolsMock).toHaveBeenCalledTimes(2)
    const retryMessages = streamWithToolsMock.mock.calls[1][0].messages
    expect(
      retryMessages.some((message) =>
        message.content.some((block) => block.kind === 'text' && block.text.includes('strikt giltig JSON')),
      ),
    ).toBe(true)
  })

  it('falls back to manual review after malformed tool JSON retries are exhausted', async () => {
    getManyMock.mockResolvedValue([categorizeTool()])
    modelResponseQueue.mockRejectedValue(new MalformedModelToolCallError('Model returned invalid JSON.'))

    const events: StreamEvent[] = []
    await run(events)

    expect(streamWithToolsMock).toHaveBeenCalledTimes(3)
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'turn_complete',
        assistant_text: expect.stringContaining('manuell granskning'),
      }),
    )
  })
})
