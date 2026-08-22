/**
 * Pins the TypeScript core against the shared vectors.
 *
 * If this fails, either a normalization rule changed or the tree changed —
 * both of which invalidate every commitment ever published under this field
 * set version. Regenerating the vectors to make this pass is almost always the
 * wrong fix; bumping FIELD_SET_VERSION is the right one.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cidForLex } from '@atproto/lex-cbor'

import { commitForm, fromHex, toHex, verifyFieldProof } from '../src/commitment.js'
import { FIELD_ORDER, FIELD_SET_VERSION, publicValues } from '../src/fields.js'

const vectorsPath = resolve(import.meta.dirname, '../../testdata/vectors.json')
const doc = JSON.parse(readFileSync(vectorsPath, 'utf8'))

describe('shared vectors', () => {
  test('field set metadata matches the implementation', () => {
    assert.equal(doc.fieldSetVersion, FIELD_SET_VERSION)
    assert.deepEqual(doc.fieldOrder, [...FIELD_ORDER])
    assert.equal(doc.nonceLength, 32)
    assert.deepEqual(doc.prefixes, { leaf: 0, node: 1, pad: 2 })
  })

  for (const v of doc.vectors) {
    describe(v.name, () => {
      const commitment = commitForm(v.input, v.nonces.map(fromHex))

      test('canonical values match', () => {
        assert.deepEqual(commitment.values, v.canonical)
      })

      test('every leaf hash matches', () => {
        assert.deepEqual(commitment.leaves.map(toHex), v.leaves)
      })

      test('root matches', () => {
        assert.equal(toHex(commitment.root), v.root)
      })

      test('record CID matches', async () => {
        // Assembled from PUBLIC_FIELDS rather than a restated field list, for
        // the same reason the generator is: a restated list is how a record
        // and its field set drift apart without anything failing.
        const record: Record<string, unknown> = {
          $type: doc.lexicon,
          commitment: commitment.root,
          fieldSetVersion: FIELD_SET_VERSION,
          issuerDid: v.issuerDid,
          ...publicValues(commitment.values),
        }
        const cid = await cidForLex(record as any)
        assert.equal(cid.toString(), v.recordCid)
      })

      test('the worked selective-disclosure proof verifies', () => {
        const proof = {
          field: v.proof.field,
          value: v.proof.value,
          index: v.proof.index,
          nonce: fromHex(v.proof.nonce),
          path: v.proof.path.map((s: any) => ({
            hash: fromHex(s.hash),
            side: s.side as 'left' | 'right',
          })),
        }
        assert.ok(verifyFieldProof(proof, fromHex(v.root)))
      })
    })
  }
})
