export type AiProvider = 'none' | 'bedrock' | 'local'
export type ExternalAiProvider = 'bedrock' | 'openai'

export class AiProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiProviderUnavailableError'
  }
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true' || value === '1'
}

export function getAiProvider(): AiProvider {
  const raw = (process.env.AI_PROVIDER ?? 'bedrock').trim().toLowerCase()
  if (raw === 'none' || raw === 'bedrock' || raw === 'local') return raw
  throw new AiProviderUnavailableError(
    `Invalid AI_PROVIDER="${process.env.AI_PROVIDER}". Expected one of: none, bedrock, local.`,
  )
}

export function isLocalOnlyMode(): boolean {
  return parseBoolean(process.env.LOCAL_ONLY)
}

export function getLocalAiConfig(): {
  baseUrl: string | null
  model: string | null
  timeoutMs: number
} {
  const parsedTimeout = Number(process.env.LOCAL_AI_TIMEOUT_MS)
  return {
    baseUrl: process.env.LOCAL_AI_BASE_URL?.trim() || null,
    model: process.env.LOCAL_AI_MODEL?.trim() || null,
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 30_000,
  }
}

export function isAiFallbackOnly(): boolean {
  const provider = getAiProvider()
  if (provider === 'none') return true
  if (provider === 'local') return getLocalAiConfig().baseUrl == null
  return false
}

export function assertExternalAiProviderAllowed(provider: ExternalAiProvider): void {
  const configured = getAiProvider()
  if (isLocalOnlyMode()) {
    throw new AiProviderUnavailableError(
      `LOCAL_ONLY=true forbids constructing ${provider} AI clients.`,
    )
  }
  if (configured !== provider) {
    throw new AiProviderUnavailableError(
      `AI_PROVIDER=${configured} forbids constructing ${provider} AI clients.`,
    )
  }
}

export function assertBedrockAllowed(): void {
  assertExternalAiProviderAllowed('bedrock')
}
