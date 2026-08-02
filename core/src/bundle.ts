/**
 * The bundle (§4.3).
 *
 * This is the document itself — every committed value plus the nonces needed
 * to reopen the commitment. It travels bilaterally, exactly as 8130-3
 * paperwork moves today: shop to customer, customer to next shop.
 *
 * A bundle MUST NEVER be stored, logged, or indexed by an AppView. Holding
 * bundles would rebuild the central repository of commercially sensitive data
 * that this whole design exists to avoid.
 */

import {
  bytesEqual,
  commitCanonicalForm,
  fromHex,
  toHex,
  type Commitment,
} from './commitment.js'
import { canonicalizeForm } from './canonical.js'
import {
  FIELD_ORDER,
  FIELD_SET_VERSION,
  type CanonicalForm,
} from './fields.js'

export const SYNTHETIC_MARKER =
  'SYNTHETIC DEMONSTRATION DATA — not an airworthiness record'

export type Bundle = {
  /** Always present, always this string. Every artifact carries the marker. */
  synthetic: string
  /** Field-set version the commitment was produced under. */
  version: number
  /** at:// URI of the release record this bundle opens. */
  uri: string
  /** Handle of the issuer at the time the bundle was produced, for display. */
  issuerHandle: string
  /** All 15 canonicalized values, keyed by field name. */
  values: CanonicalForm
  /** All 15 nonces as hex, in FIELD_ORDER. */
  nonces: string[]
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BundleError'
  }
}

export function buildBundle(params: {
  uri: string
  issuerHandle: string
  commitment: Commitment
}): Bundle {
  return {
    synthetic: SYNTHETIC_MARKER,
    version: params.commitment.version,
    uri: params.uri,
    issuerHandle: params.issuerHandle,
    values: params.commitment.values,
    nonces: params.commitment.nonces.map(toHex),
  }
}

/**
 * Parses and structurally validates an untrusted bundle.
 *
 * Deliberately strict: a bundle is attacker-supplied input arriving from a
 * counterparty, and every field is used to drive hashing.
 */
export function parseBundle(input: unknown): Bundle {
  if (typeof input !== 'object' || input === null) {
    throw new BundleError('bundle must be a JSON object')
  }
  const b = input as Record<string, unknown>

  if (typeof b.uri !== 'string' || !b.uri.startsWith('at://')) {
    throw new BundleError('bundle.uri must be an at:// URI')
  }
  if (typeof b.issuerHandle !== 'string' || b.issuerHandle.length === 0) {
    throw new BundleError('bundle.issuerHandle must be a non-empty string')
  }

  const version = b.version === undefined ? FIELD_SET_VERSION : b.version
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new BundleError('bundle.version must be an integer')
  }
  if (version !== FIELD_SET_VERSION) {
    throw new BundleError(
      `bundle uses field set v${version}; this build only understands v${FIELD_SET_VERSION}`,
    )
  }

  if (!Array.isArray(b.nonces) || b.nonces.length !== FIELD_ORDER.length) {
    throw new BundleError(
      `bundle.nonces must be an array of ${FIELD_ORDER.length} hex strings`,
    )
  }
  const nonces = b.nonces.map((n, i) => {
    if (typeof n !== 'string') {
      throw new BundleError(`bundle.nonces[${i}] must be a hex string`)
    }
    let bytes: Uint8Array
    try {
      bytes = fromHex(n)
    } catch {
      throw new BundleError(`bundle.nonces[${i}] is not valid hex`)
    }
    if (bytes.length !== 32) {
      throw new BundleError(
        `bundle.nonces[${i}] must be 32 bytes, got ${bytes.length}`,
      )
    }
    return n
  })

  if (typeof b.values !== 'object' || b.values === null) {
    throw new BundleError('bundle.values must be an object')
  }

  // Re-canonicalize rather than trusting the supplied values. A bundle whose
  // values are already canonical is unchanged by this; one that is not gets
  // normalized before hashing, so the same document always yields the same
  // root regardless of who typed it.
  const values = canonicalizeForm(b.values as Record<string, unknown>)

  return {
    synthetic: typeof b.synthetic === 'string' ? b.synthetic : SYNTHETIC_MARKER,
    version,
    uri: b.uri,
    issuerHandle: b.issuerHandle,
    values,
    nonces,
  }
}

/** Recomputes the commitment a bundle claims to open. */
export function commitmentFromBundle(bundle: Bundle): Commitment {
  return commitCanonicalForm(bundle.values, bundle.nonces.map(fromHex))
}

/**
 * The core recompute check (§4.4 stage 4): does this bundle actually open the
 * commitment published on the record?
 */
export function bundleMatchesCommitment(
  bundle: Bundle,
  commitment: Uint8Array,
): boolean {
  return bytesEqual(commitmentFromBundle(bundle).root, commitment)
}

/** Parses the DID, collection, and record key out of an at:// URI. */
export function parseAtUri(uri: string): {
  did: string
  collection: string
  rkey: string
} {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) throw new BundleError(`malformed at:// URI: ${uri}`)
  return { did: m[1]!, collection: m[2]!, rkey: m[3]! }
}
