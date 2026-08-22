import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildBundle } from '../src/bundle.js'
import { commitForm, fromHex, toHex } from '../src/commitment.js'
import {
  buildDisclosure,
  DisclosureError,
  discloseFromJson,
  exposedHashes,
  parseDisclosure,
  verifyDisclosure,
} from '../src/disclosure.js'
import { FIELD_ORDER } from '../src/fields.js'
import { overhaulForm } from '../src/verify/memory.js'

const URI = 'at://did:plc:cs4gk2mp7yv6nbcdefghijkl/dev.cldixon.f8130.release/3abc'

function fixture() {
  const commitment = commitForm(overhaulForm)
  const bundle = buildBundle({
    uri: URI,
    issuerHandle: 'cascadia-mro.f8130.cldixon.dev',
    commitment,
  })
  return { commitment, bundle }
}

describe('building a disclosure', () => {
  test('reveals only the requested field', () => {
    const { bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks'] })

    assert.equal(d.fields.length, 1)
    assert.equal(d.fields[0]!.field, 'remarks')
    assert.equal(d.fields[0]!.value, overhaulForm.remarks)

    // The document a lessor would receive must not contain the fields it was
    // not given.
    const json = JSON.stringify(d)
    assert.ok(!json.includes('A. Technician'), 'signerName leaked')
    assert.ok(!json.includes('WO20260042'), 'workOrder leaked')
    assert.ok(!json.includes('OVERHAULED'), 'status leaked')
  })

  test('carries exactly one nonce, not seventeen', () => {
    const { bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks'] })
    const json = JSON.stringify(d)
    const leaked = bundle.nonces.filter((n) => json.includes(n))
    assert.deepEqual(leaked, [bundle.nonces[FIELD_ORDER.indexOf('remarks')]])
  })

  test('names the withheld fields without valuing them', () => {
    const { commitment, bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks'] })
    const result = verifyDisclosure(d, commitment.root)
    assert.equal(result.withheld.length, 16)
    assert.ok(result.withheld.includes('status'))
    assert.ok(!result.withheld.includes('remarks'))
  })

  test('multiple fields verify together', () => {
    const { commitment, bundle } = fixture()
    const d = buildDisclosure({
      bundle,
      fields: ['remarks', 'status', 'completedAt'],
    })
    const result = verifyDisclosure(d, commitment.root)
    assert.equal(result.verified, true)
    assert.equal(result.fields.length, 3)
  })

  test('field order is normalized, so requests are order-independent', () => {
    const { bundle } = fixture()
    const a = buildDisclosure({ bundle, fields: ['completedAt', 'remarks'] })
    const b = buildDisclosure({ bundle, fields: ['remarks', 'completedAt'] })
    assert.deepEqual(
      a.fields.map((f) => f.field),
      b.fields.map((f) => f.field),
    )
  })

  test('rejects fields outside the committed set', () => {
    const { bundle } = fixture()
    assert.throws(
      () => buildDisclosure({ bundle, fields: ['secretMargin'] }),
      DisclosureError,
    )
  })

  test('rejects an empty disclosure', () => {
    const { bundle } = fixture()
    assert.throws(() => buildDisclosure({ bundle, fields: [] }), DisclosureError)
  })
})

describe('verifying a disclosure', () => {
  test('a genuine disclosure verifies against the published commitment', () => {
    const { commitment, bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks'] })
    const result = verifyDisclosure(d, commitment.root)
    assert.equal(result.verified, true)
    assert.equal(result.fields[0]!.verified, true)
  })

  test('survives a JSON round trip', () => {
    const { commitment, bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks'] })
    const reparsed = parseDisclosure(JSON.parse(JSON.stringify(d)))
    assert.equal(verifyDisclosure(reparsed, commitment.root).verified, true)
  })

  test('a claimed value that was not committed fails', () => {
    const { commitment, bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks'] })
    // The holder tries to understate what the overhaul cost.
    d.fields[0]!.value = 1
    assert.equal(verifyDisclosure(d, commitment.root).verified, false)
  })

  test('a tampered sibling path fails', () => {
    const { commitment, bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks'] })
    d.fields[0]!.path[0]!.hash = 'ab'.repeat(32)
    assert.equal(verifyDisclosure(d, commitment.root).verified, false)
  })

  test('a proof against a different record fails', () => {
    const { bundle } = fixture()
    const other = commitForm({ ...overhaulForm, remarks: 'Something else entirely.' })
    const d = buildDisclosure({ bundle, fields: ['remarks'] })
    assert.equal(verifyDisclosure(d, other.root).verified, false)
  })

  test('one bad field fails the whole disclosure', () => {
    const { commitment, bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks', 'status'] })
    d.fields[1]!.value = 'NEW'
    const result = verifyDisclosure(d, commitment.root)
    assert.equal(result.verified, false)
    assert.equal(result.fields[0]!.verified, true)
    assert.equal(result.fields[1]!.verified, false)
  })

  test('every committed field can be disclosed on its own', () => {
    const { commitment, bundle } = fixture()
    for (const field of FIELD_ORDER) {
      const d = buildDisclosure({ bundle, fields: [field] })
      assert.ok(
        verifyDisclosure(d, commitment.root).verified,
        `${field} did not verify`,
      )
    }
  })
})

describe('what a disclosure leaks', () => {
  test('sibling hashes are exposed but reveal nothing', () => {
    const { bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['remarks'] })
    const hashes = exposedHashes(d)

    // Five sibling hashes for a 32-leaf tree. They are unavoidable — they are
    // how the root is recomputed — and useless, because each covers a 32-byte
    // random nonce.
    assert.equal(hashes.length, 5)
    for (const h of hashes) assert.equal(fromHex(h).length, 32)

    // None of them is a leaf an attacker could reproduce by guessing a
    // low-entropy value, because every leaf is salted.
    const json = JSON.stringify(d)
    for (const value of ['OVERHAULED', 'NEW', 'Example Air', '1']) {
      assert.ok(!hashes.includes(value))
      assert.ok(!json.includes('A. Technician'))
    }
  })

  test('withholding is visible: the verifier knows what it was not shown', () => {
    const { commitment, bundle } = fixture()
    const d = buildDisclosure({ bundle, fields: ['status'] })
    const result = verifyDisclosure(d, commitment.root)
    // A verifier that could not tell which fields were withheld could be shown
    // a favourable subset and told it was the whole form.
    assert.equal(result.withheld.length + result.fields.length, 17)
  })
})

describe('parsing untrusted disclosures', () => {
  test('rejects a mismatched field index', () => {
    const { bundle } = fixture()
    const d = JSON.parse(
      JSON.stringify(buildDisclosure({ bundle, fields: ['remarks'] })),
    )
    d.fields[0].index = 0
    assert.throws(() => parseDisclosure(d), DisclosureError)
  })

  test('rejects a short nonce', () => {
    const { bundle } = fixture()
    const d = JSON.parse(
      JSON.stringify(buildDisclosure({ bundle, fields: ['remarks'] })),
    )
    d.fields[0].nonce = 'abcd'
    assert.throws(() => parseDisclosure(d), DisclosureError)
  })

  test('rejects an unknown field-set version', () => {
    const { bundle } = fixture()
    const d = JSON.parse(
      JSON.stringify(buildDisclosure({ bundle, fields: ['remarks'] })),
    )
    d.version = 99
    assert.throws(() => parseDisclosure(d), DisclosureError)
  })

  test('builds straight from bundle JSON', () => {
    const { commitment, bundle } = fixture()
    const d = discloseFromJson(JSON.parse(JSON.stringify(bundle)), ['remarks'])
    assert.equal(verifyDisclosure(d, commitment.root).verified, true)
  })
})
