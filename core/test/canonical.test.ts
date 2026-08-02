import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  CanonicalizationError,
  canonicalizeForm,
  normalizeIdentifier,
  normalizeText,
  normalizeTimestamp,
} from '../src/canonical.js'
import { FIELDS, FIELD_ORDER } from '../src/fields.js'

const validForm = {
  formNumber: 'SYNTHETIC-8130-0001',
  partNumber: 'NT-8821-04',
  serialNumber: 'SN-000417',
  description: 'Fuel control unit',
  status: 'OVERHAULED',
  quantity: 1,
  workOrder: 'WO/2026/0042',
  findings: 'Metering valve wear beyond limits',
  workscope: 'Full overhaul per CMM 73-21-05',
  costCents: 1_284_500,
  customer: 'Example Air',
  signerCert: 'SYNTHETIC-CERT-12345',
  signerName: 'A. Technician',
  remarks: '',
  completedAt: '2026-01-22T09:30:00Z',
}

describe('identifier normalization', () => {
  test('strips separators and uppercases', () => {
    assert.equal(normalizeIdentifier('nt-8821/04'), 'NT882104')
    assert.equal(normalizeIdentifier('NT 8821 04'), 'NT882104')
    assert.equal(normalizeIdentifier('n.t._8821-04'), 'NT882104')
  })

  test('is idempotent', () => {
    for (const input of ['nt-8821/04', 'SN 000417', 'a_b.c-d', '']) {
      const once = normalizeIdentifier(input)
      assert.equal(normalizeIdentifier(once), once, `not idempotent: ${input}`)
    }
  })

  test('transcription variants of the same plate converge', () => {
    const variants = ['NT-8821-04', 'nt 8821 04', 'NT.8821/04', 'nt_882104']
    const normalized = new Set(variants.map(normalizeIdentifier))
    assert.equal(normalized.size, 1)
  })
})

describe('text normalization', () => {
  test('collapses internal whitespace and trims', () => {
    assert.equal(normalizeText('  wear   beyond \n limits '), 'wear beyond limits')
  })

  test('is idempotent', () => {
    for (const input of ['  a  b ', 'a', '', '\t\nx\ty\n']) {
      const once = normalizeText(input)
      assert.equal(normalizeText(once), once, `not idempotent: ${input}`)
    }
  })

  test('applies NFC so composed and decomposed forms agree', () => {
    const composed = 'é'
    const decomposed = 'é'
    assert.notEqual(composed, decomposed)
    assert.equal(normalizeText(composed), normalizeText(decomposed))
  })
})

describe('timestamp normalization', () => {
  test('forces UTC with a Z suffix at second precision', () => {
    assert.equal(
      normalizeTimestamp('completedAt', '2026-01-22T09:30:00Z'),
      '2026-01-22T09:30:00Z',
    )
    assert.equal(
      normalizeTimestamp('completedAt', '2026-01-22T04:30:00-05:00'),
      '2026-01-22T09:30:00Z',
    )
  })

  test('truncates sub-second precision', () => {
    assert.equal(
      normalizeTimestamp('completedAt', '2026-01-22T09:30:00.847Z'),
      '2026-01-22T09:30:00Z',
    )
  })

  test('rejects naive datetimes', () => {
    assert.throws(
      () => normalizeTimestamp('completedAt', '2026-01-22T09:30:00'),
      CanonicalizationError,
    )
  })

  test('rejects impossible dates', () => {
    assert.throws(
      () => normalizeTimestamp('completedAt', '2019-02-30T00:00:00Z'),
      CanonicalizationError,
    )
  })

  test('is idempotent', () => {
    const once = normalizeTimestamp('completedAt', '2026-01-22T04:30:00-05:00')
    assert.equal(normalizeTimestamp('completedAt', once), once)
  })
})

describe('form canonicalization', () => {
  test('always produces every field', () => {
    const out = canonicalizeForm(validForm)
    assert.deepEqual(Object.keys(out).sort(), [...FIELD_ORDER].sort())
  })

  test('preserves commitment order', () => {
    assert.deepEqual(Object.keys(canonicalizeForm(validForm)), [...FIELD_ORDER])
  })

  test('null and absent are the same thing', () => {
    const withNull = canonicalizeForm({ ...validForm, findings: null })
    const { findings, ...withoutKey } = validForm
    const withAbsent = canonicalizeForm(withoutKey)
    assert.deepEqual(withNull, withAbsent)
  })

  test('empty string is not null', () => {
    const empty = canonicalizeForm({ ...validForm, remarks: '' })
    const nulled = canonicalizeForm({ ...validForm, remarks: null })
    assert.equal(empty.remarks, '')
    assert.equal(nulled.remarks, null)
    assert.notDeepEqual(empty, nulled)
  })

  test('rejects unknown fields rather than dropping them', () => {
    assert.throws(
      () => canonicalizeForm({ ...validForm, sneakyTotal: 999 }),
      CanonicalizationError,
    )
  })

  test('rejects floats in integer fields', () => {
    assert.throws(
      () => canonicalizeForm({ ...validForm, costCents: 1284.5 }),
      CanonicalizationError,
    )
  })

  test('rejects integers supplied as strings', () => {
    assert.throws(
      () => canonicalizeForm({ ...validForm, quantity: '1' }),
      CanonicalizationError,
    )
  })

  test('rejects a status outside the enum', () => {
    assert.throws(
      () => canonicalizeForm({ ...validForm, status: 'REFURBISHED' }),
      CanonicalizationError,
    )
  })

  test('accepts enum values case-insensitively', () => {
    assert.equal(canonicalizeForm({ ...validForm, status: 'overhauled' }).status, 'OVERHAULED')
  })

  test('is idempotent over the whole form', () => {
    const once = canonicalizeForm(validForm)
    const twice = canonicalizeForm(once as Record<string, unknown>)
    assert.deepEqual(twice, once)
  })

  test('every declared field has a spec', () => {
    assert.equal(FIELDS.length, 15)
    assert.equal(new Set(FIELD_ORDER).size, 15)
  })
})

export { validForm }
