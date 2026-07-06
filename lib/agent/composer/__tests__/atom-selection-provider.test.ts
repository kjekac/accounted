import { afterEach, describe, expect, it, vi } from 'vitest'
import { setModelProviderForTest, type ModelProvider } from '@/lib/agent/model-provider'
import type { ComposerInputs } from '../inputs'
import { selectAtoms, selectAtomsWithFallback } from '../atom-selection'

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
      {
        id: 'horizontal/swedish-invoice-compliance',
        tier: 'horizontal',
        title: 'Fakturering',
        description: 'Svensk fakturering',
        sni_prefixes: [],
        trigger_signals: {},
        estimated_tokens: 100,
        version: 1,
      },
      {
        id: 'horizontal/swedish-year-end-closing',
        tier: 'horizontal',
        title: 'Bokslut',
        description: 'Svenskt bokslut',
        sni_prefixes: [],
        trigger_signals: {},
        estimated_tokens: 100,
        version: 1,
      },
    ],
  }
}

function fakeProvider(generateStructured: ModelProvider['generateStructured']): ModelProvider {
  return {
    name: 'disabled',
    generateText: vi.fn(),
    generateStructured,
    streamWithTools: vi.fn(),
  }
}

describe('selectAtoms', () => {
  it('accepts valid structured atom selection from the provider', async () => {
    const generateStructured = vi.fn().mockResolvedValue({
      horizontal_atoms: ['horizontal/swedish-vat'],
      vertical_atoms: [],
      modifier_atoms: [],
      is_multi_vertical: false,
      verification_questions: ['Säljer ni mest 25%- eller 12%-momsvaror?'],
      uncertainty_notes: [],
    })
    setModelProviderForTest(fakeProvider(generateStructured))

    const selection = await selectAtoms(inputs())

    expect(generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 2048 }),
      expect.objectContaining({ name: 'compose_agent_profile' }),
    )
    expect(selection.horizontal_atoms).toEqual(['horizontal/swedish-vat'])
  })

  it('adds deterministic atoms from authoritative company signals', async () => {
    const generateStructured = vi.fn().mockResolvedValue({
      horizontal_atoms: [],
      vertical_atoms: [],
      modifier_atoms: [],
      is_multi_vertical: false,
      verification_questions: ['Hur många anställda har ni?'],
      uncertainty_notes: [],
    })
    setModelProviderForTest(fakeProvider(generateStructured))

    const selection = await selectAtoms({
      ...inputs(),
      companySettings: {
        city: 'Malmö',
        moms_period: 'monthly',
        fiscal_year_start_month: 1,
        f_skatt: true,
        vat_registered: true,
        employee_count: 4,
        has_employees: true,
        pays_salaries: true,
        accounting_method: 'cash',
      },
      ticSnapshot: {
        legalEntityType: 'AB',
        registration: { vat: true, payroll: true },
        sniCodes: [{ code: '56100', name: 'Restaurangverksamhet' }],
        beneficialOwners: [{ name: 'Person A' }, { name: 'Person B' }],
        payrolls: [{ payroll2: [{ employeeCount: 4 }] }],
      },
      atomIndex: [
        ...inputs().atomIndex,
        {
          id: 'horizontal/swedish-payroll',
          tier: 'horizontal',
          title: 'Lön',
          description: 'Svensk lön',
          sni_prefixes: [],
          trigger_signals: {},
          estimated_tokens: 100,
          version: 1,
        },
        {
          id: 'vertical/restaurant',
          tier: 'vertical',
          title: 'Restaurang',
          description: 'Restaurang',
          sni_prefixes: ['56'],
          trigger_signals: {},
          estimated_tokens: 100,
          version: 1,
        },
        {
          id: 'modifier/small-employer',
          tier: 'modifier',
          title: 'Liten arbetsgivare',
          description: '1 till 9 anställda',
          sni_prefixes: [],
          trigger_signals: {},
          estimated_tokens: 100,
          version: 1,
        },
      ],
    })

    expect(selection.horizontal_atoms).toEqual([
      'horizontal/swedish-vat',
      'horizontal/swedish-payroll',
    ])
    expect(selection.vertical_atoms).toEqual(['vertical/restaurant'])
    expect(selection.modifier_atoms).toEqual(['modifier/small-employer'])
    expect(selection.verification_questions).toEqual([])
  })

  it('drops unknown atom IDs from structured output', async () => {
    const generateStructured = vi.fn().mockResolvedValue({
      horizontal_atoms: ['horizontal/swedish-vat', 'horizontal/not-real'],
      vertical_atoms: ['vertical/not-real'],
      modifier_atoms: ['modifier/not-real'],
      is_multi_vertical: true,
      verification_questions: [],
      uncertainty_notes: [],
    })
    const fakeProvider: ModelProvider = {
      name: 'local-openai-compatible',
      generateText: vi.fn(),
      generateStructured,
      streamWithTools: vi.fn(),
    }
    setModelProviderForTest(fakeProvider)

    const selection = await selectAtoms(inputs())

    expect(selection.horizontal_atoms).toEqual(['horizontal/swedish-vat'])
    expect(selection.vertical_atoms).toEqual([])
    expect(selection.modifier_atoms).toEqual([])
    expect(selection.uncertainty_notes).toContain(
      'Composer returned 3 unknown atom id(s): horizontal/not-real, vertical/not-real, modifier/not-real',
    )
  })

  it('falls back when structured output fails validation', async () => {
    const generateStructured = vi.fn().mockResolvedValue({
      horizontal_atoms: ['horizontal/swedish-vat'],
    })
    const fakeProvider: ModelProvider = {
      name: 'local-openai-compatible',
      generateText: vi.fn(),
      generateStructured,
      streamWithTools: vi.fn(),
    }
    setModelProviderForTest(fakeProvider)

    const { selection, usedFallback } = await selectAtomsWithFallback({
      ...inputs(),
      entityType: 'aktiebolag',
    })

    expect(usedFallback).toBe(true)
    expect(selection.horizontal_atoms).toEqual([
      'horizontal/swedish-vat',
      'horizontal/swedish-invoice-compliance',
      'horizontal/swedish-year-end-closing',
    ])
    expect(selection.uncertainty_notes[0]).toMatch(/deterministic fallback/i)
  })
})
