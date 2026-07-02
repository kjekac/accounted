import { afterEach, describe, expect, it, vi } from 'vitest'
import { setModelProviderForTest, type ModelProvider } from '@/lib/agent/model-provider'
import type { ComposerInputs } from '../inputs'
import { selectAtoms } from '../atom-selection'

afterEach(() => {
  setModelProviderForTest(null)
  vi.clearAllMocks()
})

function inputs(): ComposerInputs {
  return {
    companyId: 'company-1',
    companyName: 'Acme AB',
    entityType: 'AB',
    ticSnapshot: null,
    ticFetchedAt: null,
    companySettings: null,
    sieSummary: null,
    bankingSummary: null,
    userIsConfirmedDirector: false,
    atomIndex: [
      {
        id: 'horizontal/swedish-vat',
        tier: 'horizontal',
        title: 'Moms',
        description: 'Svensk moms',
        sni_prefixes: [],
        trigger_signals: {},
        estimated_tokens: 100,
        version: 1,
      },
    ],
  }
}

describe('selectAtoms', () => {
  it('uses the internal provider structured-output API', async () => {
    const generateStructured = vi.fn().mockResolvedValue({
      horizontal_atoms: ['horizontal/swedish-vat'],
      vertical_atoms: [],
      modifier_atoms: [],
      is_multi_vertical: false,
      verification_questions: ['Säljer ni mest 25%- eller 12%-momsvaror?'],
      uncertainty_notes: [],
    })
    const fakeProvider: ModelProvider = {
      name: 'disabled',
      generateText: vi.fn(),
      generateStructured,
      streamWithTools: vi.fn(),
    }
    setModelProviderForTest(fakeProvider)

    const selection = await selectAtoms(inputs())

    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 2048 }),
      expect.objectContaining({ name: 'compose_agent_profile' }),
    )
    expect(selection.horizontal_atoms).toEqual(['horizontal/swedish-vat'])
  })
})
