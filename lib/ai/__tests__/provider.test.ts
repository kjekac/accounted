import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.resetModules()
  vi.clearAllMocks()
})

describe('AI provider guardrails', () => {
  it('does not construct AnthropicBedrock when AI_PROVIDER=none', async () => {
    process.env.AI_PROVIDER = 'none'
    process.env.AWS_ACCESS_KEY_ID = 'test-key'
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'

    const constructor = vi.fn()
    vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
      default: class FakeBedrock {
        constructor(...args: unknown[]) {
          constructor(...args)
        }
      },
    }))

    const { getAnthropic } = await import('@/lib/agent/composer/client')

    expect(() => getAnthropic()).toThrow(/AI_PROVIDER=none forbids constructing bedrock/i)
    expect(constructor).not.toHaveBeenCalled()
  })

  it('does not construct AnthropicBedrock when AI_PROVIDER=local', async () => {
    process.env.AI_PROVIDER = 'local'
    process.env.LOCAL_AI_BASE_URL = 'http://127.0.0.1:11434/v1'
    process.env.AWS_ACCESS_KEY_ID = 'test-key'
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'

    const constructor = vi.fn()
    vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
      default: class FakeBedrock {
        constructor(...args: unknown[]) {
          constructor(...args)
        }
      },
    }))

    const { getAnthropic } = await import('@/lib/agent/composer/client')

    expect(() => getAnthropic()).toThrow(/AI_PROVIDER=local forbids constructing bedrock/i)
    expect(constructor).not.toHaveBeenCalled()
  })

  it('does not construct AnthropicBedrock in LOCAL_ONLY mode', async () => {
    process.env.AI_PROVIDER = 'bedrock'
    process.env.LOCAL_ONLY = 'true'
    process.env.AWS_ACCESS_KEY_ID = 'test-key'
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'

    const constructor = vi.fn()
    vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
      default: class FakeBedrock {
        constructor(...args: unknown[]) {
          constructor(...args)
        }
      },
    }))

    const { getAnthropic } = await import('@/lib/agent/composer/client')

    expect(() => getAnthropic()).toThrow(/LOCAL_ONLY=true forbids constructing bedrock/i)
    expect(constructor).not.toHaveBeenCalled()
  })
})
