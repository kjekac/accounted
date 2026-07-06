import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AtomSelection } from '../schemas'
import type { ComposerInputs } from '../inputs'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.resetModules()
  vi.clearAllMocks()
})

function inputs(): ComposerInputs {
  return {
    companyId: 'company-1',
    companyName: 'Acme AB',
    entityType: 'aktiebolag',
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

const selection: AtomSelection = {
  horizontal_atoms: ['horizontal/swedish-vat'],
  vertical_atoms: [],
  modifier_atoms: [],
  is_multi_vertical: false,
  verification_questions: [],
  uncertainty_notes: [],
}

describe('composeAgentProfile', () => {
  it('does not block local onboarding when narrative generation fails', async () => {
    process.env.AI_PROVIDER = 'local'
    process.env.LOCAL_AI_BASE_URL = 'http://127.0.0.1:11434/v1'
    process.env.LOCAL_AI_MODEL = 'test-local'

    const sourceSignals = {
      tic: null,
      sie_summary: null,
      banking_summary: null,
      atom_registry_version: 1,
    }

    vi.doMock('../inputs', () => ({
      gatherComposerInputs: vi.fn().mockResolvedValue(inputs()),
      inputsToSourceSignals: vi.fn().mockReturnValue(sourceSignals),
    }))
    vi.doMock('../atom-selection', () => ({
      selectAtoms: vi.fn().mockResolvedValue(selection),
      selectAtomsWithFallback: vi.fn().mockResolvedValue({
        selection,
        usedFallback: false,
      }),
    }))
    vi.doMock('../narrative', () => ({
      writeNarrative: vi.fn().mockRejectedValue(new Error('local model down')),
    }))
    vi.doMock('../fallback', () => ({
      fallbackNarrative: vi.fn().mockReturnValue('Fallback profile summary.'),
    }))

    const upsert = vi.fn().mockResolvedValue({ error: null })
    const supabase = {
      from: vi.fn().mockReturnValue({ upsert }),
    }

    const { composeAgentProfile } = await import('../index')
    const profile = await composeAgentProfile(supabase as never, 'company-1', {
      skipPrewarm: true,
    })

    expect(profile.profileSummary).toBe('Fallback profile summary.')
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: 'company-1',
        profile_summary: 'Fallback profile summary.',
      }),
      { onConflict: 'company_id' },
    )
  })
})
