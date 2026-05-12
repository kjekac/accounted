/**
 * AGI (Arbetsgivardeklaration) field codes per Skatteverket Teknisk beskrivning.
 *
 * FK = Fältkod (field code)
 * Ruta = Box number on the form
 */

// ============================================================
// Huvuduppgift (Employer totals)
// ============================================================

/** Employer-level field codes */
export const HUVUDUPPGIFT_FIELDS = {
  /** Total skatteavdrag — sum of all employee tax withholdings */
  RUTA_001: '001',
  /** Total underlag for arbetsgivaravgifter */
  RUTA_020: '020',
  /** Arbetsgivaravgifter — standard rate (31.42%) */
  RUTA_060: '060',
  /** Arbetsgivaravgifter — age-reduced (10.21%, born ≤1959 for 2026) */
  RUTA_061: '061',
  /** Arbetsgivaravgifter — youth rate (20.81%, vid årets ingång 18–22 år, Apr 2026–Sep 2027; Prop. 2025/26:66) */
  RUTA_062: '062',
} as const

// ============================================================
// Individuppgift (Per-employee data)
// ============================================================

/** Per-employee field codes */
export const INDIVID_FIELDS = {
  /** Personnummer/samordningsnummer (12 digits, CRITICAL: must be decrypted) */
  FK215: '215',
  /** Specifikationsnummer — MUST stay consistent per employee for corrections */
  FK570: '570',
  /** Kontant bruttolön (gross cash salary) */
  RUTA_011: '011',
  /** Avdragen skatt (withheld preliminary tax) */
  RUTA_001: '001',
  /** Förmånsvärde — bilförmån */
  RUTA_012: '012',
  /** Förmånsvärde — drivmedel vid bilförmån */
  RUTA_013: '013',
  /** Förmånsvärde — bostad */
  RUTA_014: '014',
  /** Förmånsvärde — kost */
  RUTA_015: '015',
  /** Förmånsvärde — ränta */
  RUTA_016: '016',
  /** Förmånsvärde — övriga */
  RUTA_019: '019',
  /** Underlag för arbetsgivaravgifter */
  RUTA_020: '020',
  /** Ersättning till mottagare med F-skattsedel (not subject to avgifter) */
  RUTA_131: '131',
  // Absence fields (from 2025)
  /** Sjukfrånvaro — antal dagar */
  FK821: '821',
  /** VAB — antal dagar */
  FK822: '822',
  /** Föräldraledighet — antal dagar */
  FK823: '823',
  /** Graviditetspenning — antal dagar */
  FK824: '824',
  /** Smittbärarpenning — antal dagar */
  FK825: '825',
  /** Sjuk-/aktivitetsersättning — antal dagar */
  FK826: '826',
  /** Rehabilitering — antal dagar */
  FK827: '827',
} as const

// ============================================================
// Benefit type to ruta mapping
// ============================================================

/** Map benefit item types to AGI individuppgift rutor */
export const BENEFIT_RUTA_MAP: Record<string, string> = {
  benefit_car: INDIVID_FIELDS.RUTA_012,
  benefit_housing: INDIVID_FIELDS.RUTA_014,
  benefit_meals: INDIVID_FIELDS.RUTA_015,
  benefit_wellness: INDIVID_FIELDS.RUTA_019,
  benefit_bike: INDIVID_FIELDS.RUTA_019,
  benefit_other: INDIVID_FIELDS.RUTA_019,
}

// ============================================================
// Avgifter category to ruta mapping
// ============================================================

export type AvgifterCategory = 'standard' | 'reduced_65plus' | 'youth' | 'vaxa_stod' | 'exempt'

/** Map avgifter categories to huvuduppgift rutor */
export const AVGIFTER_RUTA_MAP: Record<AvgifterCategory, string> = {
  standard: HUVUDUPPGIFT_FIELDS.RUTA_060,
  reduced_65plus: HUVUDUPPGIFT_FIELDS.RUTA_061,
  youth: HUVUDUPPGIFT_FIELDS.RUTA_062,
  vaxa_stod: HUVUDUPPGIFT_FIELDS.RUTA_061, // Växa-stöd uses same rate as 65+
  exempt: '', // No avgifter
}
