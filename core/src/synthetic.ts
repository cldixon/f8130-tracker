/**
 * Building synthetic 8130-3 forms.
 *
 * One generator, used by the seed job and by the app's issue page. They had no
 * business being separate: the seed writes the demonstration data and the issue
 * page writes more of it, and two builders would drift the way the roster and
 * the record shape both did — quietly, and only visibly once something failed.
 *
 * What this guarantees is structural rather than cosmetic. Every form comes out
 * with all seventeen blocks, a `certifyingBlock` derived from the status rather
 * than chosen, and an `approvalBasis` legal under that column. A caller cannot
 * produce the impossible document — a return to service certified against
 * approved design data — by forgetting a rule.
 *
 * EVERYTHING HERE IS FICTIONAL. Invented part numbers, invented certificates,
 * invented shop findings.
 */

import { RELEASE_STATUS, type RawForm } from './fields.js'
import type { Org } from './roster.js'

export type ReleaseStatus = (typeof RELEASE_STATUS)[number]

export type ApprovalBasis =
  | 'APPROVED_DESIGN_DATA'
  | 'NON_APPROVED_DESIGN_DATA'
  | 'PART_43_RETURN_TO_SERVICE'
  | 'OTHER_REGULATION'

/** One shop visit, in the terms the form actually needs. */
export type FormSpec = {
  /** Drives the form tracking number and the work order, so they cannot collide. */
  formSeq: number
  partNumber: string
  serialNumber: string
  description: string
  status: ReleaseStatus
  /** Block 12 — findings, workscope, and anything else written down. */
  remarks: string
  completedAt: string
  organizationName: string
  organizationAddress: string
  signerCert: string
  signerName: string
  /** Line item on the form. Defaults to 1: this model is one record per item. */
  item?: number
  quantity?: number
  /**
   * Block 13a/14a override.
   *
   * Left absent, the basis follows the status: new manufacture is certified
   * for conformity against approved design data, everything else is approved
   * for return to service under part 43.
   */
  approvalBasis?: ApprovalBasis
}

/** Which certifying column a status implies. Block 13 or Block 14, never both. */
export function certifyingBlockFor(status: string): 'CONFORMITY' | 'RETURN_TO_SERVICE' {
  return status === 'NEW' ? 'CONFORMITY' : 'RETURN_TO_SERVICE'
}

/** Builds a complete seventeen-block form. */
export function buildForm(spec: FormSpec): RawForm {
  const year = spec.completedAt.slice(0, 4)
  const seq = String(spec.formSeq).padStart(4, '0')
  const certifyingBlock = certifyingBlockFor(spec.status)
  const approvalBasis =
    spec.approvalBasis ??
    (certifyingBlock === 'CONFORMITY'
      ? 'APPROVED_DESIGN_DATA'
      : 'PART_43_RETURN_TO_SERVICE')

  return {
    approvingAuthority: 'FAA/United States',
    formNumber: `SYNTHETIC-8130-${seq}`,
    organizationName: spec.organizationName,
    organizationAddress: spec.organizationAddress,
    workOrder: `WO/${year}/${seq}`,
    item: spec.item ?? 1,
    description: spec.description,
    partNumber: spec.partNumber,
    quantity: spec.quantity ?? 1,
    serialNumber: spec.serialNumber,
    status: spec.status,
    remarks: spec.remarks,
    certifyingBlock,
    approvalBasis,
    signerCert: spec.signerCert,
    signerName: spec.signerName,
    completedAt: spec.completedAt,
  }
}

// ---------------------------------------------------------------------------
// The catalogue an example is drawn from
// ---------------------------------------------------------------------------

/** Invented rotables. Part numbers follow no real manufacturer's scheme. */
export const PARTS: { partNumber: string; description: string }[] = [
  { partNumber: 'NT-8821-04', description: 'Fuel control unit' },
  { partNumber: 'NT-9004-11', description: 'Hydraulic actuator' },
  { partNumber: 'NT-7702-09', description: 'Bleed air valve' },
  { partNumber: 'NT-6110-02', description: 'Engine-driven hydraulic pump' },
  { partNumber: 'NT-1180-45', description: 'Constant speed drive' },
  { partNumber: 'NT-2245-63', description: 'Nose wheel steering actuator' },
  { partNumber: 'CA-4420-07', description: 'Cabin pressure controller' },
  { partNumber: 'CA-3315-22', description: 'Air cycle machine' },
  { partNumber: 'CA-7761-08', description: 'Anti-ice valve' },
  { partNumber: 'VP-2208-30', description: 'Starter-generator' },
  { partNumber: 'VP-5540-16', description: 'Fuel metering unit' },
  { partNumber: 'VP-3390-12', description: 'Oil cooler' },
]

/** Block 12 text, paired with the status that makes it plausible. */
const FINDINGS: Record<ReleaseStatus, string[]> = {
  NEW: [
    'Production acceptance test complete. New manufacture; no findings.',
    'Manufactured and tested to drawing. No discrepancies noted.',
  ],
  OVERHAULED: [
    'Bearing wear beyond limits; seal weeping. Full overhaul per CMM.',
    'Gear scoring and pressure decay beyond limits. Full overhaul per CMM.',
    'Metering valve wear beyond limits. Full overhaul per CMM.',
  ],
  REPAIRED: [
    'Case porosity at mounting flange. Flange repair per CMM.',
    'Seal degradation. Seal replacement per CMM.',
    'Transducer drift beyond tolerance. Transducer replaced per CMM.',
  ],
  INSPECTED: [
    'No defects noted. Bench functional check per CMM.',
    'Receiving inspection on asset transfer. No defects noted.',
  ],
  TESTED: [
    'Bench functional test per CMM. All parameters within limits.',
    'Acceptance test performed; results within published tolerances.',
  ],
  MODIFIED: [
    'Pre-modification condition serviceable. Service bulletin embodied.',
    'Modification standard raised per service bulletin. Retest satisfactory.',
  ],
}

/**
 * Signers, shuffled rather than narrated.
 *
 * A model asked for a technician's name returns the same initial every time —
 * five surnames and five T.s across one live batch. A pool has more range than
 * that and costs nothing.
 */
export const SIGNERS = [
  'A. Technician',
  'R. Inspector',
  'J. Mercado',
  'K. Osei',
  'L. Fontaine',
  'D. Whitfield',
  'S. Nakamura',
  'P. Halloran',
  'M. Okonkwo',
  'B. Terzić',
  'C. Vasquez',
  'E. Lindqvist',
  'F. Haddad',
  'G. Ferreira',
  'H. Nowak',
  'N. Abebe',
  'O. Brennan',
  'T. Adeyemi',
  'V. Choudhury',
  'W. Kowalski',
]

/**
 * A small deterministic mixer.
 *
 * Not for anything that needs to be unguessable — this picks a part number and
 * a technician's name. Nonces come from the CSPRNG in commitment.ts and never
 * from here.
 */
function mix(seed: number, salt: number): number {
  let x = (seed * 2654435761 + salt * 40503) >>> 0
  x ^= x >>> 15
  x = (x * 2246822519) >>> 0
  x ^= x >>> 13
  return x >>> 0
}

const pick = <T>(items: readonly T[], seed: number, salt: number): T =>
  items[mix(seed, salt) % items.length]!

/**
 * A complete, plausible, valid form for an organization to issue.
 *
 * Deterministic in `seed`, so the same number always produces the same example
 * — a test can pin one, and a visitor clicking twice gets two different parts.
 */
export function syntheticForm(params: {
  org: Pick<Org, 'displayName' | 'address' | 'certificate' | 'kind'>
  /** Any integer. The same one always yields the same form. */
  seed: number
  /** Anchors `completedAt`. Injected so the output can be pinned in tests. */
  now?: Date
}): RawForm {
  const { org, seed } = params
  const part = pick(PARTS, seed, 1)

  // A manufacturer issues new parts; everyone else returns them to service.
  const statuses: ReleaseStatus[] =
    org.kind === 'oem'
      ? ['NEW']
      : ['OVERHAULED', 'REPAIRED', 'INSPECTED', 'TESTED', 'MODIFIED']
  const status = pick(statuses, seed, 2)

  const now = params.now ?? new Date()
  // Somewhere in the last ninety days, on a whole minute.
  const daysAgo = mix(seed, 3) % 90
  const completed = new Date(now.getTime() - daysAgo * 86_400_000)
  completed.setUTCSeconds(0, 0)

  const serial = 100000 + (mix(seed, 4) % 900000)

  return buildForm({
    formSeq: 9000 + (mix(seed, 5) % 1000),
    partNumber: part.partNumber,
    serialNumber: `SN-${serial}`,
    description: part.description,
    status,
    remarks: pick(FINDINGS[status], seed, 6),
    completedAt: completed.toISOString().replace(/\.\d+Z$/, 'Z'),
    organizationName: org.displayName,
    organizationAddress: org.address,
    signerCert: org.certificate ?? `SYNTHETIC-CERT-9${String(mix(seed, 7) % 10000).padStart(4, '0')}`,
    signerName: pick(SIGNERS, seed, 8),
  })
}
