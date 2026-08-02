import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  bytesEqual,
  buildLevels,
  commitForm,
  fromHex,
  generateNonces,
  leafHash,
  NONCE_LENGTH,
  padLeaf,
  proofForField,
  rootFromProof,
  toHex,
  verifyFieldProof,
} from '../src/commitment.js'
import {
  buildBundle,
  bundleMatchesCommitment,
  BundleError,
  commitmentFromBundle,
  parseAtUri,
  parseBundle,
} from '../src/bundle.js'
import { FIELD_ORDER } from '../src/fields.js'
import { validForm } from './canonical.test.js'

const URI = 'at://did:plc:cs4gk2mp7yv6nbcdefghijkl/dev.cldixon.f8130.release/3ms4apoyqxc2i'
const HANDLE = 'cascadia-mro.f8130.cldixon.dev'

/** A fixed nonce set, so a test can assert on exact bytes. */
const fixedNonces = () =>
  FIELD_ORDER.map((_, i) => new Uint8Array(NONCE_LENGTH).fill(i + 1))

describe('tree shape', () => {
  test('15 fields pad to 16 leaves and 5 levels', () => {
    const c = commitForm(validForm, fixedNonces())
    const levels = buildLevels(c.leaves)
    assert.equal(c.leaves.length, 15)
    assert.equal(levels[0]!.length, 16)
    assert.equal(levels.length, 5)
    assert.equal(levels[levels.length - 1]!.length, 1)
  })

  test('the padding leaf is a constant', () => {
    assert.ok(bytesEqual(padLeaf(), padLeaf()))
    assert.equal(padLeaf().length, 32)
  })

  test('tree shape does not depend on which fields are null', () => {
    const full = commitForm(validForm, fixedNonces())
    const sparse = commitForm(
      {
        partNumber: validForm.partNumber,
        serialNumber: validForm.serialNumber,
        status: validForm.status,
        formNumber: validForm.formNumber,
        signerCert: validForm.signerCert,
        completedAt: validForm.completedAt,
      },
      fixedNonces(),
    )
    assert.equal(full.leaves.length, sparse.leaves.length)
    assert.equal(buildLevels(full.leaves).length, buildLevels(sparse.leaves).length)
    assert.ok(!bytesEqual(full.root, sparse.root))
  })
})

describe('domain separation', () => {
  test('leaf, node, and pad prefixes produce distinct hashes', () => {
    const nonce = new Uint8Array(NONCE_LENGTH).fill(7)
    const leaf = leafHash('status', 'NEW', nonce)
    assert.ok(!bytesEqual(leaf, padLeaf()))
    assert.equal(leaf.length, 32)
  })

  test('a nonce of the wrong length is refused', () => {
    assert.throws(() => leafHash('status', 'NEW', new Uint8Array(16)))
  })

  test('field name is bound into the leaf', () => {
    const nonce = new Uint8Array(NONCE_LENGTH).fill(3)
    const a = leafHash('findings', 'x', nonce)
    const b = leafHash('remarks', 'x', nonce)
    assert.ok(!bytesEqual(a, b))
  })
})

describe('commitment', () => {
  test('is deterministic for the same values and nonces', () => {
    const a = commitForm(validForm, fixedNonces())
    const b = commitForm(validForm, fixedNonces())
    assert.ok(bytesEqual(a.root, b.root))
  })

  test('fresh nonces change the root for identical values', () => {
    const a = commitForm(validForm)
    const b = commitForm(validForm)
    assert.ok(!bytesEqual(a.root, b.root))
  })

  test('generated nonces are 32 CSPRNG bytes and not repeated', () => {
    const nonces = generateNonces()
    assert.equal(nonces.length, 15)
    for (const n of nonces) assert.equal(n.length, NONCE_LENGTH)
    assert.equal(new Set(nonces.map(toHex)).size, 15)
  })

  test('changing any single field changes the root', () => {
    const base = commitForm(validForm, fixedNonces())
    const mutations: Record<string, unknown> = {
      formNumber: 'SYNTHETIC-8130-0002',
      partNumber: 'NT-8821-05',
      serialNumber: 'SN-000418',
      description: 'Fuel control unit, reworked',
      status: 'REPAIRED',
      quantity: 2,
      workOrder: 'WO/2026/0043',
      findings: 'No defects found',
      workscope: 'Inspection only',
      costCents: 1_284_501,
      customer: 'Southpoint Air',
      signerCert: 'SYNTHETIC-CERT-12346',
      signerName: 'B. Technician',
      remarks: 'note added',
      completedAt: '2026-01-22T09:30:01Z',
    }
    for (const field of FIELD_ORDER) {
      const mutated = commitForm(
        { ...validForm, [field]: mutations[field] },
        fixedNonces(),
      )
      assert.ok(
        !bytesEqual(base.root, mutated.root),
        `mutating ${field} left the root unchanged`,
      )
    }
  })

  test('canonicalization means cosmetic edits do NOT change the root', () => {
    const a = commitForm(validForm, fixedNonces())
    const b = commitForm(
      {
        ...validForm,
        partNumber: 'nt 8821 04',
        findings: '  Metering valve   wear beyond limits  ',
        completedAt: '2026-01-22T04:30:00-05:00',
      },
      fixedNonces(),
    )
    assert.ok(bytesEqual(a.root, b.root))
  })
})

describe('selective disclosure', () => {
  test('every field produces a proof that recomputes the root', () => {
    const c = commitForm(validForm)
    for (const field of FIELD_ORDER) {
      const proof = proofForField(c, field)
      assert.ok(
        verifyFieldProof(proof, c.root),
        `proof for ${field} did not verify`,
      )
    }
  })

  test('a proof path is log2(16) = 4 steps', () => {
    const c = commitForm(validForm)
    assert.equal(proofForField(c, 'costCents').path.length, 4)
  })

  test('a proof reveals only its own field', () => {
    const c = commitForm(validForm)
    const proof = proofForField(c, 'costCents')
    assert.equal(proof.value, validForm.costCents)
    const serialized = JSON.stringify({
      ...proof,
      nonce: toHex(proof.nonce),
      path: proof.path.map((s) => ({ ...s, hash: toHex(s.hash) })),
    })
    assert.ok(!serialized.includes('Example Air'))
    assert.ok(!serialized.includes('Metering valve'))
  })

  test('altering the disclosed value breaks the proof', () => {
    const c = commitForm(validForm)
    const proof = proofForField(c, 'costCents')
    assert.ok(!verifyFieldProof({ ...proof, value: 1 }, c.root))
  })

  test('substituting another nonce breaks the proof', () => {
    const c = commitForm(validForm)
    const proof = proofForField(c, 'costCents')
    assert.ok(
      !verifyFieldProof({ ...proof, nonce: new Uint8Array(NONCE_LENGTH) }, c.root),
    )
  })

  test('tampering with the sibling path breaks the proof', () => {
    const c = commitForm(validForm)
    const proof = proofForField(c, 'costCents')
    const tampered = {
      ...proof,
      path: proof.path.map((s, i) =>
        i === 0 ? { ...s, hash: new Uint8Array(32).fill(9) } : s,
      ),
    }
    assert.ok(!verifyFieldProof(tampered, c.root))
  })

  test('flipping a sibling side breaks the proof', () => {
    const c = commitForm(validForm)
    const proof = proofForField(c, 'findings')
    const flipped = {
      ...proof,
      path: proof.path.map((s, i) =>
        i === 0
          ? { ...s, side: (s.side === 'left' ? 'right' : 'left') as 'left' | 'right' }
          : s,
      ),
    }
    assert.ok(!bytesEqual(rootFromProof(flipped), c.root))
  })
})

describe('bundle', () => {
  const bundleFor = () =>
    buildBundle({
      uri: URI,
      issuerHandle: HANDLE,
      commitment: commitForm(validForm),
    })

  test('round-trips through JSON and still opens the commitment', () => {
    const bundle = bundleFor()
    const expected = commitmentFromBundle(bundle).root
    const reparsed = parseBundle(JSON.parse(JSON.stringify(bundle)))
    assert.ok(bundleMatchesCommitment(reparsed, expected))
  })

  test('carries the synthetic marker', () => {
    assert.match(bundleFor().synthetic, /SYNTHETIC/)
  })

  test('detects a tampered value — the scenario-2 case', () => {
    const bundle = bundleFor()
    const root = commitmentFromBundle(bundle).root
    const tampered = parseBundle({
      ...JSON.parse(JSON.stringify(bundle)),
      values: { ...bundle.values, findings: 'No defects found' },
    })
    assert.ok(!bundleMatchesCommitment(tampered, root))
  })

  test('rejects a wrong nonce count', () => {
    const bundle = JSON.parse(JSON.stringify(bundleFor()))
    bundle.nonces = bundle.nonces.slice(0, 14)
    assert.throws(() => parseBundle(bundle), BundleError)
  })

  test('rejects a short nonce', () => {
    const bundle = JSON.parse(JSON.stringify(bundleFor()))
    bundle.nonces[3] = 'abcd'
    assert.throws(() => parseBundle(bundle), BundleError)
  })

  test('rejects a non-hex nonce', () => {
    const bundle = JSON.parse(JSON.stringify(bundleFor()))
    bundle.nonces[0] = 'z'.repeat(64)
    assert.throws(() => parseBundle(bundle), BundleError)
  })

  test('rejects a non-at:// uri', () => {
    const bundle = JSON.parse(JSON.stringify(bundleFor()))
    bundle.uri = 'https://example.invalid/record'
    assert.throws(() => parseBundle(bundle), BundleError)
  })

  test('rejects an unknown field-set version', () => {
    const bundle = JSON.parse(JSON.stringify(bundleFor()))
    bundle.version = 99
    assert.throws(() => parseBundle(bundle), BundleError)
  })

  test('re-canonicalizes sloppy values to the same root', () => {
    const bundle = bundleFor()
    const root = commitmentFromBundle(bundle).root
    const sloppy = parseBundle({
      ...JSON.parse(JSON.stringify(bundle)),
      values: { ...bundle.values, partNumber: 'nt 8821 04' },
    })
    assert.ok(bundleMatchesCommitment(sloppy, root))
  })

  test('parses at:// URIs into their parts', () => {
    const { did, collection, rkey } = parseAtUri(URI)
    assert.equal(did, 'did:plc:cs4gk2mp7yv6nbcdefghijkl')
    assert.equal(collection, 'dev.cldixon.f8130.release')
    assert.equal(rkey, '3ms4apoyqxc2i')
  })
})

describe('hex helpers', () => {
  test('round-trip', () => {
    const bytes = new Uint8Array([0, 1, 254, 255])
    assert.ok(bytesEqual(fromHex(toHex(bytes)), bytes))
  })

  test('rejects odd-length and non-hex input', () => {
    assert.throws(() => fromHex('abc'))
    assert.throws(() => fromHex('zz'))
  })
})
