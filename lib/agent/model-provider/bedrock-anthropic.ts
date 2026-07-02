import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import { assertBedrockAllowed } from '@/lib/ai/provider'
import type { AgentTool } from '@/lib/agent/tools/types'
import type {
  GenerateStructuredInput,
  GenerateTextInput,
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelResponse,
  ModelSystemBlock,
  StreamWithToolsInput,
  StructuredSchema,
} from './types'
import { extractText } from './types'

let cachedClient: AnthropicBedrock | null = null

function getAnthropicBedrock(): AnthropicBedrock {
  if (cachedClient) return cachedClient
  assertBedrockAllowed()
  const awsRegion = process.env.AWS_REGION || 'eu-north-1'
  const awsAccessKey = process.env.AWS_ACCESS_KEY_ID
  const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY
  cachedClient =
    awsAccessKey && awsSecretKey
      ? new AnthropicBedrock({ awsRegion, awsAccessKey, awsSecretKey })
      : new AnthropicBedrock({ awsRegion })
  return cachedClient
}

export function resetBedrockAnthropicProviderForTest(): void {
  cachedClient = null
}

export const bedrockAnthropicProvider: ModelProvider = {
  name: 'bedrock-anthropic',

  async generateText(input: GenerateTextInput): Promise<string> {
    const response = await getAnthropicBedrock().messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: toAnthropicSystem(input.system),
      messages: toAnthropicMessages(input.messages),
    } as never)
    return extractText(fromAnthropicContent(response.content))
  },

  async generateStructured<T>(
    input: GenerateStructuredInput,
    schema: StructuredSchema,
  ): Promise<T> {
    const response = await getAnthropicBedrock().messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: toAnthropicSystem(input.system),
      messages: toAnthropicMessages(input.messages),
      tools: [
        {
          name: schema.name,
          description: schema.description,
          input_schema: schema.schema,
        },
      ],
      tool_choice: { type: 'tool', name: schema.name },
    } as never)

    const toolCall = fromAnthropicContent(response.content).find(
      (block): block is Extract<ModelContentBlock, { kind: 'tool_call' }> =>
        block.kind === 'tool_call',
    )
    if (!toolCall) {
      throw new Error(`Model did not return structured output via ${schema.name}`)
    }
    return toolCall.input as T
  },

  async streamWithTools(input: StreamWithToolsInput): Promise<ModelResponse> {
    const stream = getAnthropicBedrock().messages.stream({
      model: input.model,
      max_tokens: input.maxTokens,
      system: toAnthropicSystem(input.system),
      messages: toAnthropicMessages(input.messages),
      tools: input.tools.length > 0 ? input.tools.map(toAnthropicTool) : undefined,
      ...(input.thinkingBudgetTokens
        ? {
            thinking: {
              type: 'enabled' as const,
              budget_tokens: input.thinkingBudgetTokens,
            },
          }
        : {}),
    } as never)

    stream.on('text', (delta) => {
      input.onEvent?.({ kind: 'text_delta', delta })
    })

    const emittedToolIds = new Set<string>()
    stream.on('streamEvent', (ev) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = ev as any
      if (
        e?.type === 'content_block_delta' &&
        e?.delta?.type === 'thinking_delta' &&
        typeof e.delta.thinking === 'string'
      ) {
        input.onEvent?.({ kind: 'reasoning_delta', delta: e.delta.thinking })
        return
      }
      if (e?.type === 'content_block_start' && e?.content_block?.type === 'tool_use') {
        const block = e.content_block
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          emittedToolIds.add(block.id)
          input.onEvent?.({
            kind: 'tool_call',
            id: block.id,
            name: block.name,
            input: {},
          })
        }
      }
    })

    const response = await stream.finalMessage()
    const content = fromAnthropicContent(response.content)

    for (const block of content) {
      if (block.kind === 'tool_call' && !emittedToolIds.has(block.id)) {
        input.onEvent?.({
          kind: 'tool_call',
          id: block.id,
          name: block.name,
          input: block.input,
        })
      }
    }

    return {
      content,
      stopReason: response.stop_reason === 'tool_use' ? 'tool_call' : mapStopReason(response.stop_reason),
    }
  },
}

function toAnthropicSystem(
  system: string | ModelSystemBlock[] | undefined,
): string | unknown[] | undefined {
  if (typeof system === 'string' || system == null) return system
  return system.map((block) => ({
    type: 'text',
    text: block.text,
    ...(block.cache ? { cache_control: { type: block.cache.type, ttl: block.cache.ttl } } : {}),
  }))
}

function toAnthropicMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicContentBlock),
  }))
}

function toAnthropicContentBlock(block: ModelContentBlock): unknown {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'tool_call') {
    return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
  }
  if (block.kind === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: block.toolCallId,
      content: block.content,
      ...(block.isError ? { is_error: true } : {}),
    }
  }
  if (block.kind === 'reasoning' || block.kind === 'redacted_reasoning') {
    return block.providerMetadata ?? {
      type: block.kind === 'reasoning' ? 'thinking' : 'redacted_thinking',
      thinking: block.kind === 'reasoning' ? block.text : undefined,
    }
  }
}

function fromAnthropicContent(content: unknown): ModelContentBlock[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(fromAnthropicContentBlock)
}

function fromAnthropicContentBlock(block: unknown): ModelContentBlock[] {
  const b = block as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return []
  if (b.type === 'text' && typeof b.text === 'string') return [{ kind: 'text', text: b.text }]
  if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
    return [
      {
        kind: 'tool_call',
        id: b.id,
        name: b.name,
        input: isRecord(b.input) ? b.input : {},
      },
    ]
  }
  if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
    return [
      {
        kind: 'tool_result',
        toolCallId: b.tool_use_id,
        content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
        isError: b.is_error === true,
      },
    ]
  }
  if (b.type === 'thinking') {
    return [
      {
        kind: 'reasoning',
        text: typeof b.thinking === 'string' ? b.thinking : '',
        providerMetadata: b,
      },
    ]
  }
  if (b.type === 'redacted_thinking') {
    return [{ kind: 'redacted_reasoning', providerMetadata: b }]
  }
  return []
}

function toAnthropicTool(t: AgentTool) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as { type: 'object' } & Record<string, unknown>,
  }
}

function mapStopReason(reason: unknown): ModelResponse['stopReason'] {
  if (reason === 'end_turn') return 'end_turn'
  if (reason === 'max_tokens') return 'max_tokens'
  if (reason === 'stop_sequence') return 'stop_sequence'
  return 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
