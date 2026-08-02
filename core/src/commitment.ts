/**
 * The field commitment tree (§4.2).
 *
 *   leaf_i = SHA256( 0x00 ‖ cbor(fieldName) ‖ cbor(valueOrNull) ‖ nonce_i )
 *   node   = SHA256( 0x01 ‖ left ‖ right )
 *   pad    = SHA256( 0x02 )
 *
 * The domain-separation prefixes are mandatory. Without them an internal node
 * and a leaf are drawn from the same space, and an attacker can present an
 * internal node as a leaf (the classic second-preimage attack on Merkle trees).
 *
 * The per-field nonces are equally non-negotiable. 8130-3 fields are extremely
 * low entropy — a status is one of five values, a cost is a number of dollars.
 * Without a nonce, anyone holding the root brute-forces the private fields
 * essentially instantly.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { encode as cborEncode } from '@atproto/lex-cbor'
import { canonicalizeForm } from './canonical.js'
import {
  FIELDS,
  FIELD_ORDER,
  FIELD_SET_VERSION,
  type CanonicalForm,
  type RawForm,
} from './fields.js'

export const NONCE_LENGTH = 32
export const LEAF_PREFIX = 0x00
export const NODE_PREFIX = 0x01
export const PAD_PREFIX = 0x02

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return new Uint8Array(h.digest())
}

const byte = (b: number) => new Uint8Array([b])

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`not valid hex: ${JSON.stringify(hex.slice(0, 32))}`)
  }
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function generateNonce(): Uint8Array {
  return new Uint8Array(randomBytes(NONCE_LENGTH))
}

export function generateNonces(count = FIELD_ORDER.length): Uint8Array[] {
  return Array.from({ length: count }, generateNonce)
}

/**
 * The pad leaf. A constant, and deliberately not a hash of anything a caller
 * controls — its only job is to bring the leaf count to a power of two so the
 * tree shape is fixed.
 */
export function padLeaf(): Uint8Array {
  return sha256(byte(PAD_PREFIX))
}

export function leafHash(
  fieldName: string,
  value: string | number | null,
  nonce: Uint8Array,
): Uint8Array {
  if (nonce.length !== NONCE_LENGTH) {
    throw new Error(`nonce must be ${NONCE_LENGTH} bytes, got ${nonce.length}`)
  }
  return sha256(
    byte(LEAF_PREFIX),
    cborEncode(fieldName),
    cborEncode(value),
    nonce,
  )
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(byte(NODE_PREFIX), left, right)
}

function nextPowerOfTwo(n: number): number {
  let p = 1
  while (p < n) p *= 2
  return p
}

/**
 * Builds every level of the tree, leaves first. levels[0] is the padded leaf
 * layer; the last level is a single-element array holding the root.
 */
export function buildLevels(leaves: Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) throw new Error('cannot build a tree with no leaves')

  const padded = [...leaves]
  const width = nextPowerOfTwo(padded.length)
  const pad = padLeaf()
  while (padded.length < width) padded.push(pad)

  const levels: Uint8Array[][] = [padded]
  let current = padded
  while (current.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < current.length; i += 2) {
      next.push(nodeHash(current[i]!, current[i + 1]!))
    }
    levels.push(next)
    current = next
  }
  return levels
}

export function rootFromLeaves(leaves: Uint8Array[]): Uint8Array {
  const levels = buildLevels(leaves)
  return levels[levels.length - 1]![0]!
}

export type Commitment = {
  /** The Merkle root published in the release record. */
  root: Uint8Array
  /** Per-field leaf hashes, in FIELD_ORDER. */
  leaves: Uint8Array[]
  /** Per-field nonces, in FIELD_ORDER. Secret; travels only in the bundle. */
  nonces: Uint8Array[]
  /** The canonicalized values actually committed to. */
  values: CanonicalForm
  /** Field-set schema version these bytes were produced under. */
  version: number
}

/**
 * Canonicalizes a form and commits to it.
 *
 * Nonces may be supplied to reproduce a known commitment (test vectors, or
 * recomputing from a bundle); otherwise they are freshly drawn from the CSPRNG.
 */
export function commitForm(form: RawForm, nonces?: Uint8Array[]): Commitment {
  const values = canonicalizeForm(form)
  return commitCanonicalForm(values, nonces)
}

export function commitCanonicalForm(
  values: CanonicalForm,
  nonces?: Uint8Array[],
): Commitment {
  const useNonces = nonces ?? generateNonces()
  if (useNonces.length !== FIELD_ORDER.length) {
    throw new Error(
      `expected ${FIELD_ORDER.length} nonces, got ${useNonces.length}`,
    )
  }

  const leaves = FIELDS.map((spec, i) =>
    leafHash(spec.name, values[spec.name] ?? null, useNonces[i]!),
  )

  return {
    root: rootFromLeaves(leaves),
    leaves,
    nonces: useNonces,
    values,
    version: FIELD_SET_VERSION,
  }
}

/** One step up the tree: a sibling hash and which side it sits on. */
export type ProofStep = {
  hash: Uint8Array
  side: 'left' | 'right'
}

/**
 * A selective disclosure: enough to prove one field's value is committed under
 * a root, revealing nothing about the other fourteen beyond their leaf hashes.
 */
export type FieldProof = {
  field: string
  value: string | number | null
  nonce: Uint8Array
  index: number
  path: ProofStep[]
}

export function proofForField(
  commitment: Pick<Commitment, 'leaves' | 'nonces' | 'values'>,
  fieldName: string,
): FieldProof {
  const index = FIELD_ORDER.indexOf(fieldName)
  if (index < 0) throw new Error(`unknown field: ${fieldName}`)

  const levels = buildLevels(commitment.leaves)
  const path: ProofStep[] = []
  let i = index
  for (let level = 0; level < levels.length - 1; level++) {
    const siblingIndex = i ^ 1
    path.push({
      hash: levels[level]![siblingIndex]!,
      // the sibling is on the left exactly when our own index is odd
      side: (i & 1) === 1 ? 'left' : 'right',
    })
    i >>= 1
  }

  return {
    field: fieldName,
    value: commitment.values[fieldName] ?? null,
    nonce: commitment.nonces[index]!,
    index,
    path,
  }
}

/**
 * Recomputes a root from a single field proof. This is the whole point of the
 * design: a lessor auditing a cost figure learns the cost and nothing else.
 */
export function rootFromProof(proof: FieldProof): Uint8Array {
  let hash = leafHash(proof.field, proof.value, proof.nonce)
  for (const step of proof.path) {
    hash =
      step.side === 'left' ? nodeHash(step.hash, hash) : nodeHash(hash, step.hash)
  }
  return hash
}

export function verifyFieldProof(proof: FieldProof, root: Uint8Array): boolean {
  return bytesEqual(rootFromProof(proof), root)
}
