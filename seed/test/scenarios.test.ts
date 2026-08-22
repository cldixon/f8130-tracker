import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { commitForm, type RawForm } from '@f8130/core'

import {
  brokerForms,
  birthForm,
  deepLineage,
  orphanForm,
  orgs,
  overhaulForm,
  routineLineages,
  vanishedLineage,
  visitForm,
  SYNTHETIC_ORG_MARKER,
  VANISHED_STATION_DID,
  type PartLineage,
} from '../src/scenarios.js'

const DOMAIN = 'f8130.example'
const cast = orgs(DOMAIN)
const byKey = new Map(cast.map((o) => [o.key, o]))

/**
 * Every generated form in the demonstration, with the scenario it came from.
 *
 * Built once and reused, because the expensive assertion — actually running
 * each form through canonicalization and the commitment tree — is the one most
 * worth applying to all of them.
 */
function allForms(): { label: string; form: RawForm }[] {
  const out: { label: string; form: RawForm }[] = [
    { label: 'birth', form: birthForm },
    { label: 'overhaul', form: overhaulForm },
    { label: 'orphan', form: orphanForm },
    ...brokerForms.map((form, i) => ({ label: `broker[${i}]`, form })),
  ]

  const lineages: { label: string; lineage: PartLineage; seq: number }[] = [
    { label: 'deep', lineage: deepLineage, seq: 200 },
    { label: 'vanished', lineage: vanishedLineage, seq: 300 },
  ]
  let routineSeq = 400
  for (const [i, lineage] of routineLineages.entries()) {
    lineages.push({ label: `routine[${i}]`, lineage, seq: routineSeq })
    routineSeq += lineage.visits.length
  }

  for (const { label, lineage, seq } of lineages) {
    for (const [i, visit] of lineage.visits.entries()) {
      const issuer = byKey.get(visit.issuer)!
      const customer = byKey.get(visit.customer)!
      out.push({
        label: `${label}[${i}]`,
        form: visitForm({
          lineage,
          visit,
          index: i,
          formSeq: seq + i,
          signerCert: issuer.certificate ?? 'SYNTHETIC-CERT-99999',
          signerName: 'A. Technician',
          customerName: customer.displayName,
        }),
      })
    }
  }
  return out
}

describe('the roster', () => {
  test('is about the size the feed needs', () => {
    assert.ok(cast.length >= 25, `only ${cast.length} organizations`)
  })

  test('has unique keys, slugs, handles, e-mails and CAGE codes', () => {
    for (const field of ['key', 'slug', 'handle', 'email', 'cage'] as const) {
      const seen = new Set<string>()
      for (const org of cast) {
        assert.ok(!seen.has(org[field]), `duplicate ${field}: ${org[field]}`)
        seen.add(org[field])
      }
    }
  })

  /**
   * The five original organizations were provisioned under these exact
   * handles, and their did:plc identities are permanent. Renaming one strands
   * a registration nobody can reclaim and orphans every record it ever signed.
   */
  test('preserves the handles the original cast was provisioned under', () => {
    const original = [
      'northwind-turbine',
      'cascadia-mro',
      'example-air',
      'southpoint-air',
      'meridian-aeroparts',
    ]
    const slugs = new Set(cast.map((o) => o.slug))
    for (const slug of original) {
      assert.ok(slugs.has(slug), `handle ${slug} disappeared from the roster`)
    }
  })

  /**
   * A real CAGE code is exactly five characters. Seven means these cannot
   * collide with a real one however the roster grows.
   */
  test('uses CAGE codes that cannot be mistaken for real ones', () => {
    for (const org of cast) {
      assert.equal(org.cage.length, 7, `${org.key}: CAGE ${org.cage}`)
      assert.ok(org.cage.startsWith('SYN'), `${org.key}: CAGE ${org.cage}`)
    }
  })

  test('has handles that are valid DNS labels', () => {
    for (const org of cast) {
      assert.match(org.slug, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, org.key)
      assert.ok(org.slug.length <= 63, org.key)
    }
  })

  test('covers every role the demonstration needs', () => {
    const kinds = new Set(cast.map((o) => o.kind))
    for (const kind of ['oem', 'mro', 'operator', 'broker', 'lessor']) {
      assert.ok(kinds.has(kind as never), `no organization of kind ${kind}`)
    }
  })

  test('gives every repair station and manufacturer a certificate', () => {
    for (const org of cast) {
      if (org.kind === 'mro' || org.kind === 'oem') {
        assert.ok(org.certificate, `${org.key} issues releases but holds no certificate`)
      }
    }
  })
})

describe('the lineages', () => {
  const lineages: [string, PartLineage][] = [
    ['deep', deepLineage],
    ['vanished', vanishedLineage],
    ...routineLineages.map((l, i) => [`routine[${i}]`, l] as [string, PartLineage]),
  ]

  test('reference only organizations that exist', () => {
    for (const [label, lineage] of lineages) {
      for (const visit of lineage.visits) {
        assert.ok(byKey.has(visit.issuer), `${label}: unknown issuer ${visit.issuer}`)
        assert.ok(byKey.has(visit.customer), `${label}: unknown customer ${visit.customer}`)
      }
    }
  })

  test('run forward in time', () => {
    for (const [label, lineage] of lineages) {
      for (let i = 1; i < lineage.visits.length; i++) {
        const prev = Date.parse(lineage.visits[i - 1]!.completedAt)
        const cur = Date.parse(lineage.visits[i]!.completedAt)
        assert.ok(cur > prev, `${label}: visit ${i} is not after visit ${i - 1}`)
      }
    }
  })

  test('are never accepted before they were completed', () => {
    for (const [label, lineage] of lineages) {
      for (const [i, visit] of lineage.visits.entries()) {
        if (!visit.receivedAt) continue
        assert.ok(
          Date.parse(visit.receivedAt) > Date.parse(visit.completedAt),
          `${label}[${i}]: received before completed`,
        )
      }
    }
  })

  test('never have a shop certify work for itself', () => {
    for (const [label, lineage] of lineages) {
      for (const [i, visit] of lineage.visits.entries()) {
        assert.notEqual(visit.issuer, visit.customer, `${label}[${i}]: issuer is its own customer`)
      }
    }
  })

  test('carry a note whenever the verdict is not a plain acceptance', () => {
    for (const [label, lineage] of lineages) {
      for (const [i, visit] of lineage.visits.entries()) {
        if (visit.outcome && visit.outcome !== 'accepted') {
          assert.ok(visit.note, `${label}[${i}]: ${visit.outcome} with no explanation`)
        }
      }
    }
  })
})

describe('the deep chain', () => {
  test('is deep enough to be worth tracing', () => {
    assert.ok(deepLineage.visits.length >= 6, `only ${deepLineage.visits.length} visits`)
  })

  test('starts at manufacture', () => {
    assert.equal(deepLineage.visits[0]!.status, 'NEW')
  })

  test('spans enough years to look like a real rotable', () => {
    const first = new Date(deepLineage.visits[0]!.completedAt).getUTCFullYear()
    const last = new Date(
      deepLineage.visits[deepLineage.visits.length - 1]!.completedAt,
    ).getUTCFullYear()
    assert.ok(last - first >= 15, `spans only ${last - first} years`)
  })

  test('crosses several organizations rather than one shop repeatedly', () => {
    const issuers = new Set(deepLineage.visits.map((v) => v.issuer))
    assert.ok(issuers.size >= 5, `only ${issuers.size} distinct issuers`)
  })

  /** Custody moving is what makes the customer field impossible to infer. */
  test('changes hands more than once', () => {
    const owners = new Set(deepLineage.visits.map((v) => v.customer))
    assert.ok(owners.size >= 3, `only ${owners.size} distinct owners`)
  })

  test('is accepted at every step, so a buyer sees an unbroken record', () => {
    for (const [i, visit] of deepLineage.visits.entries()) {
      assert.equal(visit.outcome ?? 'accepted', 'accepted', `visit ${i} is not accepted`)
      assert.ok(visit.receivedAt, `visit ${i} has no acceptance at all`)
    }
  })
})

describe('the vanished station', () => {
  /**
   * Resolution has to be genuinely attempted and genuinely fail. A malformed
   * identifier would be rejected earlier, by a different code path, and would
   * demonstrate the wrong thing.
   */
  test('is a syntactically valid did:plc', () => {
    assert.match(VANISHED_STATION_DID, /^did:plc:[a-z2-7]{24}$/)
  })

  test('is not the DID of anyone in the cast', () => {
    for (const org of cast) {
      assert.notEqual(org.handle, VANISHED_STATION_DID)
    }
  })

  test('leaves published visits behind it, so the break is mid-chain', () => {
    assert.ok(vanishedLineage.visits.length >= 2)
  })
})

describe('every form in the demonstration', () => {
  const forms = allForms()

  test('there are enough of them to populate a feed', () => {
    assert.ok(forms.length >= 25, `only ${forms.length} forms`)
  })

  /**
   * The real assertion. Running each form through the commitment tree
   * exercises canonicalization on every field — which is where an impossible
   * calendar date, a fractional cost, or a malformed timestamp surfaces. This
   * project has already shipped one date bug that V8 silently rolled forward.
   */
  test('canonicalizes and commits without error', () => {
    for (const { label, form } of forms) {
      assert.doesNotThrow(() => commitForm(form), `${label} failed to commit`)
    }
  })

  test('has a unique form number', () => {
    const seen = new Map<string, string>()
    for (const { label, form } of forms) {
      const n = form.formNumber
      assert.ok(!seen.has(n), `${label} reuses form number ${n} from ${seen.get(n)}`)
      seen.set(n, label)
    }
  })

  test('is marked synthetic in its form number', () => {
    for (const { label, form } of forms) {
      assert.match(form.formNumber, /^SYNTHETIC-8130-/, label)
    }
  })

  test('costs whole cents, never a fraction', () => {
    for (const { label, form } of forms) {
      assert.ok(Number.isInteger(form.costCents), `${label}: ${form.costCents}`)
      assert.ok(form.costCents > 0, `${label}: ${form.costCents}`)
    }
  })

  test('is dated in the past relative to the demonstration timeline', () => {
    for (const { label, form } of forms) {
      const year = new Date(form.completedAt).getUTCFullYear()
      assert.ok(year >= 2000 && year <= 2030, `${label}: ${form.completedAt}`)
    }
  })
})

/**
 * Conformance of the station records against their own lexicon.
 *
 * The alternative feedback loop for a roster entry that violates its schema is
 * a deploy, a seed run, and an XRPC error partway through writing twenty-nine
 * profiles — with the earlier ones already committed. Reading the lexicon here
 * keeps that failure local and cheap, and keeps this test honest if the schema
 * later changes.
 */
describe('station records against the lexicon', () => {
  const lexicon = JSON.parse(
    readFileSync(
      new URL('../../lexicons/dev/cldixon/f8130/station.json', import.meta.url),
      'utf8',
    ),
  ) as {
    defs: {
      main: {
        record: {
          required: string[]
          properties: Record<string, Record<string, unknown>>
        }
      }
    }
  }
  const schema = lexicon.defs.main.record

  /** The record the seed builds for one organization. */
  function stationRecord(org: (typeof cast)[number]): Record<string, unknown> {
    return {
      displayName: org.displayName,
      kind: org.kind,
      synthetic: SYNTHETIC_ORG_MARKER,
      cage: org.cage,
      ...(org.certificate ? { certificate: org.certificate } : {}),
    }
  }

  test('carry every required property', () => {
    for (const org of cast) {
      const rec = stationRecord(org)
      for (const key of schema.required) {
        assert.ok(key in rec, `${org.key}: missing required property ${key}`)
      }
    }
  })

  test('use no property the lexicon does not define', () => {
    for (const org of cast) {
      for (const key of Object.keys(stationRecord(org))) {
        assert.ok(key in schema.properties, `${org.key}: undeclared property ${key}`)
      }
    }
  })

  test('respect every declared maxLength', () => {
    for (const org of cast) {
      for (const [key, value] of Object.entries(stationRecord(org))) {
        const max = schema.properties[key]?.maxLength
        if (typeof max !== 'number' || typeof value !== 'string') continue
        assert.ok(
          value.length <= max,
          `${org.key}: ${key} is ${value.length} chars, max ${max} — ${JSON.stringify(value)}`,
        )
      }
    }
  })

  test('respect every declared integer bound', () => {
    for (const org of cast) {
      for (const [key, value] of Object.entries(stationRecord(org))) {
        const spec = schema.properties[key]
        if (spec?.type !== 'integer') continue
        assert.ok(Number.isInteger(value), `${org.key}: ${key} is not an integer`)
        const n = value as number
        if (typeof spec.minimum === 'number') {
          assert.ok(n >= spec.minimum, `${org.key}: ${key} below minimum`)
        }
        if (typeof spec.maximum === 'number') {
          assert.ok(n <= spec.maximum, `${org.key}: ${key} above maximum`)
        }
      }
    }
  })

  test('use only values the lexicon knows for enumerated fields', () => {
    for (const org of cast) {
      for (const [key, value] of Object.entries(stationRecord(org))) {
        const known = schema.properties[key]?.knownValues
        if (!Array.isArray(known)) continue
        assert.ok(known.includes(value), `${org.key}: ${key} = ${String(value)} is not a known value`)
      }
    }
  })

  test('are marked synthetic', () => {
    assert.match(SYNTHETIC_ORG_MARKER, /SYNTHETIC/)
  })
})
