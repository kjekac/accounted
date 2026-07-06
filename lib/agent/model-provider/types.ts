import type { AgentTool } from '@/lib/agent/tools/types'

export type ModelRole = 'user' | 'assistant'

export interface ModelSystemBlock {
  kind: 'text'
  text: string
  cache?: { type: 'ephemeral'; ttl?: '5m' | '1h' }
}

export type ModelContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | { kind: 'reasoning'; text: string; providerMetadata?: unknown }
  | { kind: 'redacted_reasoning'; providerMetadata?: unknown }

export interface ModelMessage {
  role: ModelRole
  content: ModelContentBlock[]
}

export interface ModelResponse {
  content: ModelContentBlock[]
  stopReason: 'end_turn' | 'tool_call' | 'max_tokens' | 'stop_sequence' | 'unknown'
}

export type ModelStreamEvent =
  | { kind: 'text_delta'; delta: string }
  | { kind: 'reasoning_delta'; delta: string }
  | { kind: 'tool_call'; id: string; name: string; input: Record<string, unknown> }

export interface GenerateTextInput {
  model: string
  maxTokens: number
  system?: string | ModelSystemBlock[]
  messages: ModelMessage[]
}

export interface StructuredSchema {
  name: string
  description?: string
  schema: { type: 'object' } & Record<string, unknown>
}

export interface GenerateStructuredInput {
  model: string
  maxTokens: number
  system?: string | ModelSystemBlock[]
  messages: ModelMessage[]
}

export interface StreamWithToolsInput {
  model: string
  maxTokens: number
  system: ModelSystemBlock[]
  messages: ModelMessage[]
  tools: AgentTool[]
  thinkingBudgetTokens?: number
  onEvent?: (event: ModelStreamEvent) => void
}

export interface ModelProvider {
  name: 'bedrock-anthropic' | 'local-openai-compatible' | 'disabled'
  generateText(input: GenerateTextInput): Promise<string>
  generateStructured<T>(input: GenerateStructuredInput, schema: StructuredSchema): Promise<T>
  streamWithTools(input: StreamWithToolsInput): Promise<ModelResponse>
}

export class MalformedModelToolCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedModelToolCallError'
  }
}

export function textMessage(role: ModelRole, text: string): ModelMessage {
  return { role, content: [{ kind: 'text', text }] }
}

export function extractText(content: ModelContentBlock[]): string {
  return content
    .filter((block): block is { kind: 'text'; text: string } => block.kind === 'text')
    .map((block) => block.text)
    .join('')
}
