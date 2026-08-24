/**
 * Narrated synthetic forms.
 *
 * The catalogue in synthetic.ts produces valid forms and always the same
 * twelve parts with the same handful of findings. Read three of them and you
 * have read all of them, which undercuts the thing a live feed is for — a
 * world with more in it than a demonstration has patience to hand-author.
 *
 * So the prose comes from a model. What the model may write, and what it may
 * not, is the whole design of this file.
 *
 * ---------------------------------------------------------------- the split
 *
 * A language model writes plausible aviation prose, which is exactly what
 * Block 7 and Block 12 need. It is also perfectly capable of writing a real
 * manufacturer's part number, and a record published to a repository is
 * permanent and public. So the model narrates and the code composes:
 *
 *   MODEL   description, remarks, signerName, status
 *   CODE    every identifier, every date, every regulatory field
 *
 * Part numbers in particular are never narrated. They are derived from an
 * invented prefix registry, which removes the entire class of "the model
 * invented a real part number" and buys coherence for nothing: the same
 * component from the same fictional manufacturer always lands on the same
 * prefix. Nobody reads a part number for flavour.
 *
 * The regulatory fields are not narrated either, for a different reason. Which
 * certifying column applies follows from the status, and the legal approval
 * bases follow from the column. Those are derivations, not opinions, and a
 * model that gets one wrong produces a document that cannot exist.
 *
 * ------------------------------------------------------------- determinism
 *
 * The skeleton stays seed-deterministic: the same seed always picks the same
 * status, the same date, the same sequence numbers. Only the prose varies, and
 * it is memoized by seed, so asking twice for seed N gives the same form both
 * times. A test can pin one; a visitor clicking twice gets two different
 * parts.
 *
 * ------------------------------------------------------------- degradation
 *
 * Every failure — no key, a refusal, a timeout, a validation failure, a
 * denylist hit — falls back to the catalogue. The demonstration has always run
 * from a fresh clone with nothing installed, and a narrator is an enrichment
 * rather than a dependency.
 *
 * This module holds no SDK and makes no network call. `Narrator` is a port,
 * the same shape the verification pipeline uses for identity and repositories,
 * so core stays pure and the network lives at the edge.
 */

import { RELEASE_STATUS } from './fields.js'
import type { RawForm } from './fields.js'
import type { Org } from './roster.js'
import { buildForm, PARTS, SIGNERS, syntheticForm, type ReleaseStatus } from './synthetic.js'

/** What a narrator is asked for. Everything else the caller already knows. */
export type NarrationBrief = {
  /** What kind of shop is issuing: shapes what work is plausible. */
  orgKind: Org['kind']
  /** The organization's own name, for tone. Never to be echoed into prose. */
  orgName: string
  /** The status the skeleton already chose. The prose must match it. */
  status: ReleaseStatus
  /**
   * A component family to stay near, so a part's description is in the right
   * neighbourhood rather than arbitrary.
   */
  familyHint: string
  /**
   * Makes two otherwise identical briefs distinct to the cache, and nothing
   * else — it is never shown to the model.
   *
   * Set for a part being described for the first time and left unset for one
   * coming back. Without it the memo answered every new part in a family with
   * the prose it had already written for a different one, so two unrelated
   * part numbers shared a description and a set of findings. That is a worse
   * failure than a cache miss: it says the two are the same component.
   */
  variant?: string
}

/**
 * The only fields a model is permitted to author.
 *
 * `signerName` used to be here and was taken back. Across six live briefs the
 * model returned T. Alwera, T. Alonso, T. Hollis, T. Aldous and T. Adeyemi —
 * five different surnames and the same initial every time. A name is exactly
 * the kind of field a shuffled pool does better than a model: more range, for
 * free, deterministic in the seed, and one less field on the surface a model
 * could write something unwanted into.
 */
export type Narration = {
  /** Block 7. A component name, title case, no manufacturer. */
  description: string
  /** Block 12. What was found and what was done. */
  remarks: string
}

/**
 * A source of prose.
 *
 * Returns null for any failure at all. A narrator never throws and never
 * partially succeeds: the caller's fallback is one branch, not five.
 *
 * It writes Block 7 and Block 12, and nothing else. It used to also write the
 * reason an operator rejected a part, which was a mistake of a specific kind:
 * the model invented a finding that no check had produced, in prose confident
 * enough to be read as one. The network no longer carries rejections at all —
 * an attestation says a document verified, and nothing says it did not — so
 * there is nothing left here for a model to make up.
 */
export interface Narrator {
  narrate(brief: NarrationBrief): Promise<Narration | null>
}

// ---------------------------------------------------------------------------
// The tool the model is made to call
// ---------------------------------------------------------------------------

/**
 * A strict tool schema, which is the first of three validation layers.
 *
 * `strict: true` plus `additionalProperties: false` means the API itself
 * guarantees the arguments match this shape — no missing keys, no extra ones,
 * no prose wrapped around a JSON blob for us to fish out. What it cannot
 * guarantee is that the *content* is safe or coherent, which is what
 * `validateNarration` is for.
 */
export type NarrationToolSchema = {
  name: string
  description: string
  strict: true
  input_schema: {
    type: 'object'
    additionalProperties: false
    required: string[]
    properties: Record<string, { type: 'string'; maxLength: number; description: string }>
  }
}

export const NARRATION_TOOL: NarrationToolSchema = {
  name: 'record_shop_findings',
  description:
    'Record what a repair station found and what it did, for one component ' +
    'on one FAA Form 8130-3. Call this exactly once.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'remarks'],
    properties: {
      description: {
        type: 'string',
        maxLength: 120,
        description:
          'Block 7. The component, in the terms a parts catalogue would use — ' +
          '"Fuel metering unit", "Main landing gear actuator". Two to five ' +
          'words, no manufacturer name, no part number, no model number.',
      },
      remarks: {
        type: 'string',
        maxLength: 400,
        description:
          'Block 12. What was found and what was done, in the register a ' +
          'shop actually writes: a finding, then the work, then the ' +
          'disposition. One or two short sentences, under 200 characters. ' +
          'Maintenance references are written plainly — "per CMM 29-11-08" ' +
          '— and no company is ever named.',
      },
    },
  },
}

/**
 * The standing instruction.
 *
 * Deliberately stable byte for byte across every request, so it can be cached
 * and so two calls differ only in the brief. It says what the model is writing
 * and, more importantly, the two things it must never write.
 */
export const NARRATION_SYSTEM = [
  'You write the narrative fields of synthetic FAA Form 8130-3 release',
  'certificates for a protocol demonstration. Nothing you write describes a',
  'real part, a real shop visit, or a real organization, and none of it is',
  'airworthiness evidence.',
  '',
  'Write the way a repair station actually writes: specific, unglamorous,',
  'and short. "Bearing wear beyond limits; seal weeping. Full overhaul per',
  'CMM." Not marketing copy, not a narrative, not an explanation of what an',
  '8130-3 is.',
  '',
  'Length matters. Block 12 is one or two short sentences, under 200',
  'characters. A shop writes the minimum that records what happened.',
  '',
  'Two absolute rules:',
  '1. No company is ever named — not a manufacturer, airline, operator,',
  '   lessor or repair station. This is ordinary practice rather than a',
  '   restriction to write around: a maintenance reference on a form is',
  '   "per CMM 29-11-08" or "per SB 73-0042", never "per <company> CMM".',
  '   Do not acknowledge the rule in the text or invent a circumlocution',
  '   for it; just write the reference the plain way.',
  '2. Never write a part number, serial number, certificate number or work',
  '   order. Those are composed elsewhere and are not yours to invent.',
  '',
  'Call record_shop_findings exactly once. Write nothing else.',
].join('\n')

/** The per-request half. Kept after the stable prefix so caching still works. */
export function narrationPrompt(brief: NarrationBrief): string {
  const work =
    brief.status === 'NEW'
      ? 'This is new manufacture certified for conformity under Block 13, so the remarks describe production acceptance testing. There is no prior defect to find, and nothing is being returned to service — that phrase belongs to Block 14 and must not appear.'
      : `The Block 11 status is ${brief.status}, so the remarks must describe work consistent with exactly that and not with a different status.`

  return [
    `Issuing organization kind: ${brief.orgKind}.`,
    `Component family to stay near: ${brief.familyHint}.`,
    work,
    'Vary the component from the obvious ones. Call the tool.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Validation — the second and third layers
// ---------------------------------------------------------------------------

/**
 * Real names that must never reach a published record.
 *
 * Not a security control — a model that wanted to evade this could. It is a
 * mistake filter, and the mistake it filters is the likely one: a model
 * reaching for a familiar manufacturer while writing plausible prose.
 *
 * Matched on word boundaries against the lower-cased text, so "GE" does not
 * fire on "gear" and "CFM" does not fire inside a longer token.
 */
export const REAL_WORLD_NAMES = [
  'boeing', 'airbus', 'embraer', 'bombardier', 'cessna', 'gulfstream',
  'lockheed', 'northrop', 'dassault', 'atr', 'comac', 'sukhoi',
  'honeywell', 'collins', 'rockwell', 'safran', 'thales', 'liebherr',
  'parker', 'eaton', 'moog', 'meggitt', 'crane', 'woodward', 'ametek',
  'pratt', 'whitney', 'rolls-royce', 'rolls royce', 'cfm', 'ge aviation',
  'general electric', 'williams international', 'engine alliance',
  'united', 'delta', 'american airlines', 'southwest', 'jetblue', 'alaska',
  'lufthansa', 'ryanair', 'easyjet', 'emirates', 'qatar', 'etihad',
  'british airways', 'air france', 'klm', 'iberia', 'qantas', 'singapore',
  'fedex', 'ups airlines', 'dhl', 'atlas air',
  'aar corp', 'haeco', 'ameco', 'st engineering', 'lufthansa technik',
  'aercap', 'avolon', 'air lease', 'smbc',
] as const

const NAME_PATTERNS = REAL_WORLD_NAMES.map(
  (n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
)

/** Anything shaped like an identifier the model was told not to write. */
const IDENTIFIER_SHAPES = [
  /\b[A-Z]{1,4}[- ]?\d{3,}[- ]?\d*\b/,      // NT-8821-04, PN 1234567
  /\b\d{3,}-\d{2,}\b/,                      // 4420-07, a bare part number
  /\bs\/?n[:. ]*[A-Z0-9-]{4,}/i,             // s/n SN-000417
  /\bp\/?n[:. ]*[A-Z0-9-]{4,}/i,             // p/n NT882104
]

export type NarrationCheck =
  | { ok: true; narration: Narration }
  | { ok: false; reason: string }

/**
 * The last gate before anything reaches a form.
 *
 * Runs on the model's output regardless of what the strict schema already
 * guaranteed, because the schema constrains shape and this constrains content.
 * Rejection is cheap — the caller falls back to the catalogue — so every check
 * here fails closed.
 */
export function validateNarration(
  raw: unknown,
  brief: NarrationBrief,
): NarrationCheck {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'not an object' }
  }
  const o = raw as Record<string, unknown>

  for (const key of ['description', 'remarks'] as const) {
    if (typeof o[key] !== 'string') return { ok: false, reason: `${key} is not a string` }
  }

  const description = (o.description as string).trim()
  const remarks = (o.remarks as string).trim()

  // Lengths, against the lexicon's own limits rather than the tool schema's.
  // The record is what has to fit; the schema is only a hint to the model.
  if (description.length === 0 || description.length > 256) {
    return { ok: false, reason: 'description length' }
  }
  if (remarks.length === 0 || remarks.length > 1000) {
    return { ok: false, reason: 'remarks length' }
  }
  // Control characters would survive canonicalization as invisible bytes in a
  // committed leaf, which is a bad thing to be unable to see.
  for (const [key, v] of [['description', description], ['remarks', remarks]] as const) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) {
      return { ok: false, reason: `${key} has control characters` }
    }
  }

  const haystack = `${description}\n${remarks}`
  for (const pattern of NAME_PATTERNS) {
    const hit = pattern.exec(haystack)
    if (hit) return { ok: false, reason: `names ${hit[0]}` }
  }

  // Identifiers are composed, never narrated. One appearing in the prose means
  // the model ignored the instruction, and the safe response is to discard the
  // whole narration rather than to edit it into shape.
  //
  // Generic manual references survive on purpose — "per CMM 29-11-08" is an
  // ATA chapter, not an identifier, and it is exactly the detail that makes
  // the prose read like a shop wrote it.
  for (const pattern of IDENTIFIER_SHAPES) {
    const hit = pattern.exec(haystack)
    if (hit) return { ok: false, reason: `contains an identifier: ${hit[0]}` }
  }

  // The organization's own name in Block 12 would read as a shop talking about
  // itself in the third person, and more importantly means the model is using
  // the brief as source material rather than as context.
  if (new RegExp(`\\b${brief.orgName.split(/\s+/)[0]}\\b`, 'i').test(remarks)) {
    return { ok: false, reason: 'remarks name the issuing organization' }
  }

  return { ok: true, narration: { description, remarks } }
}

// ---------------------------------------------------------------------------
// Composing the identifiers the model is not allowed to touch
// ---------------------------------------------------------------------------

/**
 * Invented manufacturer prefixes, one per fictional OEM plus a spare.
 *
 * A part number is `<prefix>-<four digits>-<two digits>`, which resembles the
 * shape of a real one closely enough to read right and belongs to no real
 * scheme. The prefix is chosen from the description rather than at random, so
 * two hydraulic actuators narrated a month apart carry the same family.
 */
const PART_PREFIXES = ['NT', 'CA', 'VP', 'HL', 'MR', 'SG'] as const

function hash(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** A part number for a narrated component. Deterministic in the description. */
export function composePartNumber(description: string, seed: number): string {
  const family = hash(description.toLowerCase().replace(/\s+/g, ' ').trim())
  const prefix = PART_PREFIXES[family % PART_PREFIXES.length]!
  const block = String(family % 10000).padStart(4, '0')
  const dash = String(seed % 100).padStart(2, '0')
  return `${prefix}-${block}-${dash}`
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

/** A small deterministic mixer, matching synthetic.ts. */
function mix(seed: number, salt: number): number {
  let x = (seed * 2654435761 + salt * 40503) >>> 0
  x ^= x >>> 15
  x = (x * 2246822519) >>> 0
  x ^= x >>> 13
  return x >>> 0
}

/**
 * A complete form whose prose came from a narrator and whose identifiers,
 * dates and regulatory fields came from here.
 *
 * Falls back to the catalogue for any failure. The caller cannot tell which
 * happened, and does not need to: both outcomes are a valid seventeen-block
 * form for this organization to sign.
 */
export async function narratedForm(params: {
  org: Pick<Org, 'displayName' | 'address' | 'certificate' | 'kind'>
  seed: number
  narrator?: Narrator | null
  now?: Date
  /**
   * How many days before `now` the certificate claims to have been signed.
   *
   * Defaults to a spread over the last ninety days, which is right for a
   * one-off example and wrong for anything choreographed. A caller building a
   * sequence of events needs to say when each one happened, because the gap
   * between a release and the receipt of the part it covers is the shipping
   * time, and shipping time is the thing that makes the sequence read as a
   * supply chain rather than as two records written in the same second.
   */
  agedDays?: number
  /**
   * The part this form continues, when it is a later visit rather than a
   * birth.
   *
   * A component does not change its name or its number between shop visits,
   * so those are carried forward rather than regenerated. Only the work is
   * new. Without this a chain would be three records that each describe a
   * different component and claim to be the same part.
   */
  continues?: { partNumber: string; serialNumber: string; description: string }
}): Promise<RawForm> {
  const { org, seed } = params
  const fallback = (): RawForm => {
    const form = syntheticForm({
      org,
      seed,
      now: params.now,
      ...(params.agedDays === undefined ? {} : { agedDays: params.agedDays }),
    })
    return params.continues ? { ...form, ...params.continues } : form
  }

  if (!params.narrator) return fallback()

  // The skeleton, identical to the catalogue path so a narrated form and a
  // fallback form are the same document with different words in it.
  const statuses: ReleaseStatus[] =
    org.kind === 'oem'
      ? ['NEW']
      : ['OVERHAULED', 'REPAIRED', 'INSPECTED', 'TESTED', 'MODIFIED']
  const status = statuses[mix(seed, 2) % statuses.length]!

  const now = params.now ?? new Date()
  const completed = new Date(
    now.getTime() - (params.agedDays ?? mix(seed, 3) % 90) * 86_400_000,
  )
  completed.setUTCSeconds(0, 0)

  const brief: NarrationBrief = {
    orgKind: org.kind,
    orgName: org.displayName,
    status,
    // A later visit is briefed on the component it is actually about, so the
    // remarks describe work on that part rather than on an unrelated one.
    familyHint:
      params.continues?.description ?? PARTS[mix(seed, 1) % PARTS.length]!.description,
    // A returning part is meant to hit the cache — that is what keeps its
    // description the same across the visits of its life. A new one must not,
    // or it inherits the description of whatever was last written in its
    // family and arrives as a different part number saying the same thing.
    variant: params.continues ? undefined : String(seed),
  }

  const narration = await params.narrator.narrate(brief)
  if (!narration) return fallback()

  const identity = params.continues ?? {
    partNumber: composePartNumber(narration.description, seed),
    serialNumber: `SN-${100000 + (mix(seed, 4) % 900000)}`,
    description: narration.description,
  }

  return buildForm({
    formSeq: 9000 + (mix(seed, 5) % 1000),
    partNumber: identity.partNumber,
    serialNumber: identity.serialNumber,
    description: identity.description,
    status,
    remarks: narration.remarks,
    completedAt: completed.toISOString().replace(/\.\d+Z$/, 'Z'),
    organizationName: org.displayName,
    organizationAddress: org.address,
    signerCert:
      org.certificate ?? `SYNTHETIC-CERT-9${String(mix(seed, 7) % 10000).padStart(4, '0')}`,
    // From the pool rather than the model — see Narration.
    signerName: SIGNERS[mix(seed, 8) % SIGNERS.length]!,
  })
}

/**
 * Wraps a narrator so the same brief is only ever paid for once.
 *
 * Keyed on the brief, which for a returning part is deliberately the brief its
 * earlier visit carried — that is what makes a part's description stable
 * across the visits of its life. A part being described for the first time
 * carries a variant, so it gets prose of its own rather than inheriting the
 * prose of the last part in its family.
 */
export function memoize(inner: Narrator, cap = 200): Narrator {
  const cache = new Map<string, Narration | null>()
  return {
    async narrate(brief) {
      const key = [
        brief.orgKind,
        brief.status,
        brief.familyHint,
        brief.orgName,
        brief.variant ?? '',
      ].join('|')
      if (cache.has(key)) return cache.get(key)!
      const out = await inner.narrate(brief)
      // Failures are not cached: an outage should not poison the key for the
      // rest of the process.
      if (out) {
        if (cache.size >= cap) cache.delete(cache.keys().next().value as string)
        cache.set(key, out)
      }
      return out
    },
  }
}

/** Every status the skeleton can choose, for tests that sweep them. */
export const NARRATABLE_STATUSES = RELEASE_STATUS
