/**
 * The mappers between database rows and index rows.
 *
 * These exist as their own test because the feed reads its rows in a shape
 * nothing else does. Every other query is `SELECT *`, where node-postgres
 * parses timestamptz into a Date; the feed wraps rows in `to_jsonb` so both
 * record kinds merge in one query, and JSON has no date type, so identical
 * columns come back as ISO strings.
 *
 * The mappers declared Date and passed either through. That was invisible
 * until a feed card started rendering the date on the document rather than the
 * moment the row was observed, at which point the front page threw
 * "at.getTime is not a function" — in production only, because every test in
 * this suite runs against the in-memory index, which deals in real Dates.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { toRelease, toAttestation } from '../src/postgres.js'

const ISO = '2026-08-17T20:36:00.000Z'

describe('row mapping', () => {
  test('parses the ISO strings the feed query produces', () => {
    const r = toRelease({ completed_at: ISO, observed_at: ISO })
    assert.ok(r.completedAt instanceof Date)
    assert.ok(r.observedAt instanceof Date)
    assert.equal(r.completedAt.toISOString(), ISO)

    const a = toAttestation({ verified_at: ISO, observed_at: ISO })
    assert.ok(a.verifiedAt instanceof Date)
    assert.equal(a.verifiedAt.toISOString(), ISO)
  })

  test('leaves the Dates the column queries produce alone', () => {
    const when = new Date(ISO)
    const r = toRelease({ completed_at: when, observed_at: when })
    assert.ok(r.completedAt instanceof Date)
    assert.equal(r.completedAt.getTime(), when.getTime())

    const a = toAttestation({ verified_at: when, observed_at: when })
    assert.equal(a.verifiedAt.getTime(), when.getTime())
  })

  test('every date a card can render survives the round trip', () => {
    // The specific failure: a card calling a Date method on a value the mapper
    // had promised was a Date.
    const r = toRelease({ completed_at: ISO, observed_at: ISO })
    const a = toAttestation({ verified_at: ISO, observed_at: ISO })
    for (const d of [r.completedAt, r.observedAt, a.verifiedAt, a.observedAt]) {
      assert.doesNotThrow(() => d.getTime())
      assert.ok(!Number.isNaN(d.getTime()), 'an unparseable date reached a card')
    }
  })
})
