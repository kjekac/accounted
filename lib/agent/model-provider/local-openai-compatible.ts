import { randomUUID } from 'node:crypto'
import { AiProviderUnavailableError, getLocalAiConfig } from '@/lib/ai/provider'
import { MalformedModelToolCallError } from './types'
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

interface LocalChatResponse {
  choices?: {
    finish_reason?: string | null
    message?: {
      content?: string | null
      tool_calls?: LocalToolCall[]
    }
  }[]
}

interface LocalToolCall {
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

export const localProvider: ModelProvider = {
  name: 'local-openai-compatible',

  async generateText(input: GenerateTextInput): Promise<string> {
    const response = await postChatCompletion({
      model: resolveLocalModel(input.model),
      max_tokens: input.maxTokens,
      messages: toOpenAiMessages(input.system, input.messages),
    })
    return response.choices?.[0]?.message?.content?.trim() ?? ''
  },

  async generateStructured<T>(
    input: GenerateStructuredInput,
    schema: StructuredSchema,
  ): Promise<T> {
    const response = await postChatCompletion({
      model: resolveLocalModel(input.model),
      max_tokens: input.maxTokens,
      messages: toOpenAiMessages(input.system, input.messages),
      tools: [toOpenAiTool(schema)],
      tool_choice: { type: 'function', function: { name: schema.name } },
      temperature: 0,
    })

    const toolCall = response.choices?.[0]?.message?.tool_calls?.[0]
    const args = toolCall?.function?.arguments
    if (args) return parseJson(args) as T

    const text = response.choices?.[0]?.message?.content
    if (text) return parseJson(text) as T

    throw new Error(`Local model did not return structured output via ${schema.name}`)
  },

  async streamWithTools(input: StreamWithToolsInput): Promise<ModelResponse> {
    const config = requireLocalConfig()
    const response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: localHeaders(),
      body: JSON.stringify({
        model: resolveLocalModel(input.model),
        max_tokens: input.maxTokens,
        messages: toOpenAiMessages(input.system, input.messages),
        tools: input.tools.length > 0 ? input.tools.map(toOpenAiAgentTool) : undefined,
        stream: true,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    await assertOk(response)
    if (!response.body) throw new Error('Local AI response did not include a stream body')

    let text = ''
    let finishReason: string | null = null
    const toolBuffers = new Map<
      number,
      { id: string; name: string; argumentsText: string; emitted: boolean }
    >()

    for await (const chunk of readOpenAiStream(response.body)) {
      const choice = chunk?.choices?.[0]
      if (!choice) continue
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason

      const delta = choice.delta ?? {}
      const textDelta = readString(delta.content)
      if (textDelta) {
        text += textDelta
        input.onEvent?.({ kind: 'text_delta', delta: textDelta })
      }

      const reasoningDelta =
        readString(delta.reasoning_content) ?? readString(delta.reasoning) ?? readString(delta.thinking)
      if (reasoningDelta) input.onEvent?.({ kind: 'reasoning_delta', delta: reasoningDelta })

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === 'number' ? tc.index : 0
          const current =
            toolBuffers.get(index) ??
            {
              id: typeof tc.id === 'string' ? tc.id : randomUUID(),
              name: '',
              argumentsText: '',
              emitted: false,
            }
          if (typeof tc.id === 'string') current.id = tc.id
          if (typeof tc.function?.name === 'string') current.name += tc.function.name
          if (typeof tc.function?.arguments === 'string') {
            current.argumentsText += tc.function.arguments
          }
          if (!current.emitted && current.name.length > 0) {
            current.emitted = true
            input.onEvent?.({
              kind: 'tool_call',
              id: current.id,
              name: current.name,
              input: {},
            })
          }
          toolBuffers.set(index, current)
        }
      }
    }

    const content: ModelContentBlock[] = []
    if (text.length > 0) content.push({ kind: 'text', text })
    for (const [, tool] of [...toolBuffers.entries()].sort(([a], [b]) => a - b)) {
      content.push({
        kind: 'tool_call',
        id: tool.id,
        name: tool.name,
        input: tool.argumentsText.trim().length > 0 ? parseJsonObject(tool.argumentsText) : {},
      })
    }

    return {
      content,
      stopReason: finishReason === 'tool_calls' ? 'tool_call' : mapFinishReason(finishReason),
    }
  },
}

async function postChatCompletion(body: Record<string, unknown>): Promise<LocalChatResponse> {
  const config = requireLocalConfig()
  const response = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: 'POST',
    headers: localHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  await assertOk(response)
  return (await response.json()) as LocalChatResponse
}

function requireLocalConfig(): { baseUrl: string; model: string; timeoutMs: number } {
  const config = getLocalAiConfig()
  if (!config.baseUrl) {
    throw new AiProviderUnavailableError('AI_PROVIDER=local requires LOCAL_AI_BASE_URL.')
  }
  if (!config.model) {
    throw new AiProviderUnavailableError('AI_PROVIDER=local requires LOCAL_AI_MODEL.')
  }
  return { baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs }
}

function resolveLocalModel(_requestedModel: string): string {
  return requireLocalConfig().model
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`
}

function localHeaders(): HeadersInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const apiKey = process.env.LOCAL_AI_API_KEY?.trim()
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return headers
}

function toOpenAiMessages(
  system: string | ModelSystemBlock[] | undefined,
  messages: ModelMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const systemText = systemToText(system)
  if (systemText) out.push({ role: 'system', content: systemText })

  for (const message of messages) {
    const text = message.content
      .filter((block): block is Extract<ModelContentBlock, { kind: 'text' }> => block.kind === 'text')
      .map((block) => block.text)
      .join('')

    const toolCalls = message.content.filter(
      (block): block is Extract<ModelContentBlock, { kind: 'tool_call' }> =>
        block.kind === 'tool_call',
    )
    const toolResults = message.content.filter(
      (block): block is Extract<ModelContentBlock, { kind: 'tool_result' }> =>
        block.kind === 'tool_result',
    )

    if (toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        tool_calls: toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input),
          },
        })),
      })
    } else if (text.length > 0 || toolResults.length === 0) {
      out.push({ role: message.role, content: text })
    }

    for (const result of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content,
      })
    }
  }

  return out
}

function systemToText(system: string | ModelSystemBlock[] | undefined): string | null {
  if (!system) return null
  if (typeof system === 'string') return system
  return system.map((block) => block.text).join('\n\n')
}

function toOpenAiTool(schema: StructuredSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.schema,
    },
  }
}

function toOpenAiAgentTool(tool: { name: string; description: string; inputSchema: unknown }) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return
  const body = await response.text().catch(() => '')
  throw new Error(`Local AI request failed (${response.status}): ${body.slice(0, 500)}`)
}

async function* readOpenAiStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice('data:'.length).trim()
      if (!data || data === '[DONE]') continue
      yield JSON.parse(data)
    }
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('Model returned invalid JSON.')
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = parseJson(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (err) {
    throw new MalformedModelToolCallError(
      err instanceof Error ? err.message : 'Model returned invalid tool-call JSON.',
    )
  }
  throw new MalformedModelToolCallError('Model returned a non-object tool-call argument payload.')
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function mapFinishReason(reason: string | null): ModelResponse['stopReason'] {
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'stop_sequence'
  return 'unknown'
}
