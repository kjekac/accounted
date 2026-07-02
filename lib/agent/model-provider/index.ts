import { getAiProvider } from '@/lib/ai/provider'
import { bedrockAnthropicProvider } from './bedrock-anthropic'
import { disabledProvider } from './disabled'
import { localProvider } from './local-openai-compatible'
import type { ModelProvider } from './types'

export type {
  GenerateStructuredInput,
  GenerateTextInput,
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelResponse,
  ModelStreamEvent,
  ModelSystemBlock,
  StreamWithToolsInput,
  StructuredSchema,
} from './types'
export { extractText, textMessage } from './types'
export { bedrockAnthropicProvider } from './bedrock-anthropic'
export { disabledProvider } from './disabled'
export { localProvider } from './local-openai-compatible'

let overrideProvider: ModelProvider | null = null

export function getModelProvider(): ModelProvider {
  if (overrideProvider) return overrideProvider
  const configured = getAiProvider()
  if (configured === 'bedrock') return bedrockAnthropicProvider
  if (configured === 'local') return localProvider
  return disabledProvider
}

export function setModelProviderForTest(provider: ModelProvider | null): void {
  overrideProvider = provider
}
