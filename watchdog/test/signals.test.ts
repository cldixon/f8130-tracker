/**
 * The watchdog's signals, against a real database with the real schema.
 *
 * These are SQL, and SQL is the one thing a type checker cannot hold honest —
 * a query can be perfectly well-typed and still count the wrong rows. They run
 * against Postgres or they do not run at all.
 *
 * Skipping when no DSN is set is deliberate and so is failing loudly in CI:
 * the Go suite carries the same arrangement for the same reason, because a
 * suite that quietly skips its only real coverage lets the build go green
 * having tested nothing.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Pool } from 'pg'

import { WatchdogIndex } from '../src/db.js'

const DSN = process.env.F8130_TEST_DSN ?? process.env.F8130_TEST_DATABASE_URL
const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA = join(here, '..', '..', 'ingest', 'schema.sql')

const CASCADIA = 'did:plc:cascadia'
const MERIDIAN = 'did:plc:meridian'
const OPERATOR = 'did:plc:op1'

describe('watchdog signals', { skip: DSN ? false : 'no F8130_TEST_DSN' }, () => {
  let pool: Pool
  let index: WatchdogIndex

  before(async () => {
    pool = new Pool({ connectionString: DSN })
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    await pool.query(readFileSync(SCHEMA, 'utf8'))

    await pool.query(
      `INSERT INTO actor (did, handle, first_seen) VALUES ($1,$1,now()),($2,$2,now()),($3,$3,now())`,
      [CASCADIA, MERIDIAN, OPERATOR],
    )

    const rel = async (
      cid: string,
      issuer: string,
      part: string,
      serial: string,
      prevCid: string | null,
      ageDays: number,
    ) =>
      pool.query(
        `INSERT INTO release
           (cid,uri,issuer_did,prev_uri,prev_cid,approving_authority,form_number,
            organization_name,organization_address,description,part_number,
            serial_number,signer_cert,commitment,completed_at,observed_at,seq,raw_record)
         VALUES ($1,$2,$3,$4,$5,'FAA/United States','SYNTHETIC-F','Org','addr',
                 'Hydraulic pump',$6,$7,'SYNTHETIC-C','\\x00',
                 now() - ($8 || ' days')::interval, now(), 1, '{}')`,
        [
          cid,
          `at://${issuer}/dev.cldixon.f8130.release/${cid}`,
          issuer,
          prevCid ? `at://${issuer}/dev.cldixon.f8130.release/${prevCid}` : null,
          prevCid,
          part,
          serial,
          String(ageDays),
        ],
      )

    // A legitimate history: one birth, then a shop visit pointing back at it.
    await rel('b1', CASCADIA, 'PN-1', 'SN-1', null, 30)
    await rel('b2', CASCADIA, 'PN-1', 'SN-1', 'b1', 10)
    // A second, independent origin claim for the same part and serial.
    await rel('b3', MERIDIAN, 'PN-1', 'SN-1', null, 5)
    // A release naming a predecessor nobody published.
    await rel('b4', MERIDIAN, 'PN-2', 'SN-2', 'bGHOST', 2)
    // A clean, unremarkable part with a single origin.
    await rel('b5', CASCADIA, 'PN-3', 'SN-3', null, 20)

    await pool.query(
      `INSERT INTO attestation
         (cid,uri,subject_uri,subject_cid,verifier_did,verified_at,observed_at,seq,raw_record)
       VALUES ('a1','at://${OPERATOR}/a/1','at://${CASCADIA}/r/b2','b2',$1,now(),now(),2,'{}')`,
      [OPERATOR],
    )

    index = new WatchdogIndex(pool)
  })

  after(async () => {
    await pool?.end()
  })

  test('a serial with two origin claims is surfaced', async () => {
    const rows = await index.clonedSerials()
    assert.equal(rows.length, 1, 'exactly one contradiction was planted')
    const [r] = rows
    assert.equal(r!.partNumber, 'PN-1')
    assert.equal(r!.serialNumber, 'SN-1')
    assert.equal(r!.births, 2, 'two records each claim the part began with them')
    assert.equal(r!.releases, 3)
    assert.equal(r!.stations, 2)
  })

  test('an ordinary service history is not a contradiction', async () => {
    const rows = await index.clonedSerials()
    // The whole design has parts passing through many shops, so several
    // releases naming one serial is the normal case. If that tripped the
    // signal the page would be nothing but false positives.
    assert.ok(!rows.some((r) => r.serialNumber === 'SN-3'), 'a single-origin part was flagged')
    const cloned = rows.find((r) => r.serialNumber === 'SN-1')!
    assert.ok(cloned.releases > cloned.births, 'the legitimate visit still counts as a release')
  })

  test('a history pointing at an unpublished record is surfaced', async () => {
    const rows = await index.danglingLinks()
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.serialNumber, 'SN-2')
    assert.equal(rows[0]!.prevCid, 'bGHOST')
  })

  test('a resolvable predecessor is not surfaced', async () => {
    const rows = await index.danglingLinks()
    assert.ok(!rows.some((r) => r.cid === 'b2'), 'a chain that resolves was flagged')
  })

  test('coverage counts who vouched, per issuing station', async () => {
    const rows = await index.issuers()
    const byDid = new Map(rows.map((r) => [r.did, r]))

    assert.equal(byDid.get(CASCADIA)?.releases, 3)
    assert.equal(byDid.get(CASCADIA)?.attested, 1)
    assert.equal(byDid.get(MERIDIAN)?.releases, 2)
    assert.equal(byDid.get(MERIDIAN)?.attested, 0)

    // The operator published a check but issued nothing, so it is not a
    // station and does not belong in a table about output.
    assert.ok(!byDid.has(OPERATOR), 'an operator appeared as an issuer')
  })

  test('an attestation is credited to the issuer of the release, not its author', async () => {
    const rows = await index.issuers()
    const op = rows.find((r) => r.did === OPERATOR)
    assert.equal(op, undefined)
    // Cascadia issued the release that was checked, so the credit lands there
    // — never on a claim the checking party made about who they dealt with.
    assert.equal(rows.find((r) => r.did === CASCADIA)?.attested, 1)
  })
})
