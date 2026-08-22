/**
 * Selective disclosure (§4.2).
 *
 * A bundle opens the whole document. Often that is more than the situation
 * calls for: a lessor checking what condition an asset came back in needs
 * Block 12 and has no business seeing the work order or the operator's whole
 * maintenance posture. A leasing company that must be handed the entire form to
 * read one box is a leasing company that now holds more than it asked for.
 *
 * A disclosure carries only the fields being revealed, each with its own nonce
 * and the sibling path back to the published root. Everything else appears as
 * opaque hashes — enough to recompute the root, not enough to learn anything.
 * The commitment the issuer already published is what the proof is checked
 * against, so no new signature and no cooperation from the issuer is needed.
 */

import { parseBundle, type Bundle } from './bundle.js'
import {
  bytesEqual,
  buildLevels,
  commitCanonicalForm,
  fromHex,
  leafHash,
  proofForField,
  rootFromProof,
  toHex,
  type FieldProof,
  type ProofStep,
} from './commitment.js'
import { FIELDS, FIELD_ORDER, FIELD_SET_VERSION } from './fields.js'

export const DISCLOSURE_MARKER =
  'SYNTHETIC DEMONSTRATION DATA — selective disclosure, not an airworthiness record'

export type DisclosedField = {
  field: string
  value: string | number | null
  /** Hex. Only this field's nonce; the other fourteen stay secret. */
  nonce: string
  index: number
  path: { hash: string; side: 'left' | 'right' }[]
}

export type Disclosure = {
  synthetic: string
  version: number
  /** at:// URI of the release whose commitment this opens. */
  uri: string
  issuerHandle: string
  fields: DisclosedField[]
}

export class DisclosureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DisclosureError'
  }
}

function serializeProof(p: FieldProof): DisclosedField {
  return {
    field: p.field,
    value: p.value,
    nonce: toHex(p.nonce),
    index: p.index,
    path: p.path.map((s) => ({ hash: toHex(s.hash), side: s.side })),
  }
}

function deserializeProof(d: DisclosedField): FieldProof {
  return {
    field: d.field,
    value: d.value,
    nonce: fromHex(d.nonce),
    index: d.index,
    path: d.path.map((s) => ({
      hash: fromHex(s.hash),
      side: s.side,
    })) as ProofStep[],
  }
}

/**
 * Builds a disclosure for the named fields from a bundle.
 *
 * The bundle is the input because only the holder of the document can produce
 * one — which is the correct shape. The party who received the paperwork
 * decides what to reveal, not the issuer and not any service.
 */
export function buildDisclosure(params: {
  bundle: Bundle
  fields: string[]
}): Disclosure {
  const unknown = params.fields.filter((f) => !FIELD_ORDER.includes(f))
  if (unknown.length > 0) {
    throw new DisclosureError(`not committed fields: ${unknown.join(', ')}`)
  }
  if (params.fields.length === 0) {
    throw new DisclosureError('a disclosure must reveal at least one field')
  }

  const commitment = commitCanonicalForm(
    params.bundle.values,
    params.bundle.nonces.map(fromHex),
  )

  // Deduplicated and ordered, so the same request always produces the same
  // document regardless of how the caller listed the fields.
  const wanted = FIELD_ORDER.filter((f) => params.fields.includes(f))

  return {
    synthetic: DISCLOSURE_MARKER,
    version: commitment.version,
    uri: params.bundle.uri,
    issuerHandle: params.bundle.issuerHandle,
    fields: wanted.map((f) => serializeProof(proofForField(commitment, f))),
  }
}

export function parseDisclosure(input: unknown): Disclosure {
  if (typeof input !== 'object' || input === null) {
    throw new DisclosureError('disclosure must be a JSON object')
  }
  const d = input as Record<string, unknown>

  if (typeof d.uri !== 'string' || !d.uri.startsWith('at://')) {
    throw new DisclosureError('disclosure.uri must be an at:// URI')
  }
  const version = d.version === undefined ? FIELD_SET_VERSION : d.version
  if (version !== FIELD_SET_VERSION) {
    throw new DisclosureError(
      `disclosure uses field set v${version}; this build only understands v${FIELD_SET_VERSION}`,
    )
  }
  if (!Array.isArray(d.fields) || d.fields.length === 0) {
    throw new DisclosureError('disclosure.fields must be a non-empty array')
  }

  const fields = d.fields.map((raw, i) => {
    const f = raw as Record<string, unknown>
    if (typeof f.field !== 'string' || !FIELD_ORDER.includes(f.field)) {
      throw new DisclosureError(`fields[${i}].field is not a committed field`)
    }
    if (typeof f.nonce !== 'string') {
      throw new DisclosureError(`fields[${i}].nonce must be a hex string`)
    }
    if (fromHex(f.nonce).length !== 32) {
      throw new DisclosureError(`fields[${i}].nonce must be 32 bytes`)
    }
    if (typeof f.index !== 'number' || f.index !== FIELD_ORDER.indexOf(f.field)) {
      throw new DisclosureError(
        `fields[${i}].index does not match the committed position of ${f.field}`,
      )
    }
    if (!Array.isArray(f.path)) {
      throw new DisclosureError(`fields[${i}].path must be an array`)
    }
    for (const [j, step] of f.path.entries()) {
      const s = step as Record<string, unknown>
      if (typeof s.hash !== 'string' || fromHex(s.hash).length !== 32) {
        throw new DisclosureError(`fields[${i}].path[${j}].hash must be 32 bytes`)
      }
      if (s.side !== 'left' && s.side !== 'right') {
        throw new DisclosureError(`fields[${i}].path[${j}].side must be left or right`)
      }
    }
    const value = f.value === undefined ? null : f.value
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
      throw new DisclosureError(`fields[${i}].value must be a string, number or null`)
    }
    return {
      field: f.field,
      value: value as string | number | null,
      nonce: f.nonce,
      index: f.index,
      path: f.path as { hash: string; side: 'left' | 'right' }[],
    }
  })

  return {
    synthetic: typeof d.synthetic === 'string' ? d.synthetic : DISCLOSURE_MARKER,
    version: FIELD_SET_VERSION,
    uri: d.uri,
    issuerHandle: typeof d.issuerHandle === 'string' ? d.issuerHandle : '',
    fields,
  }
}

export type DisclosedFieldResult = {
  field: string
  value: string | number | null
  /** Whether this field's proof recomputes the published root. */
  verified: boolean
  /** Human-readable label for the field's role on the form. */
  isPublic: boolean
}

export type DisclosureResult = {
  synthetic: string
  verified: boolean
  fields: DisclosedFieldResult[]
  /** Fields the disclosure did NOT reveal — named, but not valued. */
  withheld: string[]
}

/**
 * Checks a disclosure against the commitment published on the record.
 *
 * Note what is *not* required: the issuer's participation, a fresh signature,
 * or any state held by this service. The root was published once; anyone
 * holding a proof can check against it forever.
 */
export function verifyDisclosure(
  disclosure: Disclosure,
  commitment: Uint8Array,
): DisclosureResult {
  const revealed = new Set(disclosure.fields.map((f) => f.field))

  const fields = disclosure.fields.map((f) => {
    let verified = false
    try {
      verified = bytesEqual(rootFromProof(deserializeProof(f)), commitment)
    } catch {
      verified = false
    }
    return {
      field: f.field,
      value: f.value,
      verified,
      isPublic: FIELDS.find((s) => s.name === f.field)?.public ?? false,
    }
  })

  return {
    synthetic: DISCLOSURE_MARKER,
    verified: fields.length > 0 && fields.every((f) => f.verified),
    fields,
    withheld: FIELD_ORDER.filter((f) => !revealed.has(f)),
  }
}

/** Convenience: build a disclosure straight from untrusted bundle JSON. */
export function discloseFromJson(input: unknown, fields: string[]): Disclosure {
  return buildDisclosure({ bundle: parseBundle(input), fields })
}

/**
 * The leaf hashes a disclosure necessarily exposes, for demonstration.
 *
 * Sibling hashes are unavoidable — they are how the root is recomputed. They
 * are also useless: each is SHA256 over a 32-byte random nonce, so an
 * undisclosed field cannot be brute-forced out of one even though the value
 * space is tiny. This exists so the UI can show what leaks rather than assert
 * that nothing does.
 */
export function exposedHashes(disclosure: Disclosure): string[] {
  const seen = new Set<string>()
  for (const f of disclosure.fields) {
    for (const step of f.path) seen.add(step.hash)
  }
  return [...seen]
}

/** Recomputes the full leaf layer, for tests and diagnostics. */
export function leafLayer(bundle: Bundle): Uint8Array[] {
  const nonces = bundle.nonces.map(fromHex)
  const leaves = FIELDS.map((spec, i) =>
    leafHash(spec.name, bundle.values[spec.name] ?? null, nonces[i]!),
  )
  buildLevels(leaves)
  return leaves
}
