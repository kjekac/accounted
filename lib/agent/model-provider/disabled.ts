import { AiProviderUnavailableError } from '@/lib/ai/provider'
import type {
  GenerateStructuredInput,
  GenerateTextInput,
  ModelProvider,
  StreamWithToolsInput,
  StructuredSchema,
} from './types'

function unavailable(): never {
  throw new AiProviderUnavailableError('AI provider is disabled for this installation.')
}

export const disabledProvider: ModelProvider = {
  name: 'disabled',
  async generateText(_input: GenerateTextInput): Promise<string> {
    unavailable()
  },
  async generateStructured<T>(
    _input: GenerateStructuredInput,
    _schema: StructuredSchema,
  ): Promise<T> {
    unavailable()
  },
  async streamWithTools(_input: StreamWithToolsInput) {
    unavailable()
  },
}
