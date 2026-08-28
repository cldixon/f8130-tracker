import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  commitForm,
  orgs,
  syntheticForm,
  validateApprovalBasis,
  FIELD_ORDER,
  FIELDS,
} from '@f8130/core'
import { fieldLabel } from '../src/views.js'

import {
  CASCADIA,
  parseBundle,
  standardNetwork,
  type Bundle,
} from '@f8130/core'

import { createApp } from '../src/app.js'
import type {
  ActorRow,
  AttestationRow,
  IssuerStat,
  ReadIndex,
  ReleaseRow,
} from '../src/index-port.js'

/**
 * The whole app is exercised against the in-memory network: real signatures,
 * real inclusion proofs, real forgery and tampering — no sockets, no database
 * required. The index is stubbed separately because browsing and verifying are
 * genuinely independent concerns here.
 */

async function appWithNetwork(index: ReadIndex | null = null) {
  const { net, birth, overhaul } = await standardNetwork()
  const app = createApp({ resolver: net, repo: net, index })
  return { app, net, birth, overhaul }
}

function tamper(bundle: Bundle, values: Record<string, unknown>): Bundle {
  return parseBundle({
    ...JSON.parse(JSON.stringify(bundle)),
    values: { ...bundle.values, ...values },
  })
}

const emptyIndex = (over: Partial<ReadIndex> = {}): ReadIndex => ({
  feed: async () => [],
  recentReleases: async () => [],
  releasesForPart: async () => [],
  chain: async () => [],
  attestationsForSubjects: async () => [],
  releaseByUri: async () => null,
  releasesByUris: async () => new Map(),
  issuerStats: async () => [],
  handleFor: async () => null,
  actorsFor: async () => new Map(),
  accountFor: async () => null,
  releasesByIssuer: async () => [],
  attestationsByVerifier: async () => [],
  accountStats: async () => ({ releases: 0, attested: 0, checks: 0 }),
  ...over,
})

/** An indexed profile, with the fields a test does not care about filled in. */
const actorRow = (over: Partial<ActorRow> & { did: string }): ActorRow => ({
  handle: over.did,
  displayName: null,
  kind: null,
  cage: null,
  certificate: null,
  firstSeen: null,
  ...over,
})

const releaseRow = (over: Partial<ReleaseRow> = {}): ReleaseRow => ({
  cid: 'bafyoverhaul',
  uri: 'at://did:plc:cs4gk2mp7yv6nbcdefghijkl/dev.cldixon.f8130.release/3a',
  issuerDid: 'did:plc:cs4gk2mp7yv6nbcdefghijkl',
  prevUri: null,
  prevCid: null,
  approvingAuthority: 'FAA/United States',
  formNumber: 'SYNTHETIC81300002',
  organizationName: 'Cascadia MRO',
  organizationAddress: '4400 Airport Way, Everett, WA 98204',
  description: 'Fuel control unit',
  partNumber: 'NT882104',
  serialNumber: 'SN000417',
  signerCert: 'SYNTHETICCERT12345',
  completedAt: new Date('2026-01-22T09:30:00Z'),
  observedAt: new Date('2026-01-22T10:00:00Z'),
  ...over,
})

describe('health and shape', () => {
  test('health reports the mode and whether an index is attached', async () => {
    const { app } = await appWithNetwork()
    const res = await app.request('/api/health')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, mode: 'live', index: false })
  })

  test('every page carries the synthetic-data warning', async () => {
    const { app } = await appWithNetwork()
    for (const path of ['/', '/verify']) {
      const body = await (await app.request(path)).text()
      assert.match(body, /prototype for demonstration purposes only/, `${path} is missing the marker`)
      assert.match(body, /synthetic data/, `${path} is missing the marker`)
    }
  })

  test('unknown pages 404 rather than erroring', async () => {
    const { app } = await appWithNetwork()
    assert.equal((await app.request('/nope')).status, 404)
  })
})

describe('verification without a database', () => {
  test('a genuine bundle verifies with no index attached at all', async () => {
    const { app, overhaul } = await appWithNetwork(null)
    const res = await app.request('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(overhaul.bundle),
    })
    assert.equal(res.status, 200)
    const report = (await res.json()) as any
    assert.equal(report.verified, true)
    assert.equal(report.reachedBirth, true)
    assert.equal(report.chain.length, 2)
  })

  test('the dashboard says browsing is down but verification is not', async () => {
    const { app } = await appWithNetwork(null)
    const body = await (await app.request('/parts')).text()
    assert.match(body, /verifying a document.*still works/is)
  })

  test('accepts either a bare bundle or a wrapped one', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bundle: overhaul.bundle,
        stampedSerial: 'sn 000417',
      }),
    })
    assert.equal(res.status, 200)
    const report = (await res.json()) as any
    const physical = report.stages.find((s: any) => s.name === 'physical')
    assert.equal(physical.status, 'pass')
  })

  test('a failed verification is 422, not 500', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tamper(overhaul.bundle, { remarks: 'No defects.' })),
    })
    assert.equal(res.status, 422)
    const report = (await res.json()) as any
    assert.equal(report.verified, false)
  })

  test('an unparseable bundle is 400 with a readable reason', async () => {
    const { app } = await appWithNetwork()
    const res = await app.request('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: 'not-an-at-uri' }),
    })
    assert.equal(res.status, 400)
    assert.match(((await res.json()) as any).error, /at:\/\//)
  })

  test('a non-JSON body is 400', async () => {
    const { app } = await appWithNetwork()
    const res = await app.request('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    })
    assert.equal(res.status, 400)
  })
})

describe('the verify page', () => {
  test('renders one row per stage', async () => {
    const { app, overhaul } = await appWithNetwork()
    const body = await (
      await app.request('/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
        body: new URLSearchParams({ bundle: JSON.stringify(overhaul.bundle) }),
      })
    ).text()

    assert.match(body, /Verified/)
    for (const title of [
      'Issuer identity',
      'Signed by the issuer',
      'Document matches the commitment',
      'Traceable to birth',
    ]) {
      assert.ok(body.includes(title), `missing stage row: ${title}`)
    }
  })

  test('a tampered document shows signature pass beside commitment fail', async () => {
    const { app, overhaul } = await appWithNetwork()
    const body = await (
      await app.request('/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
        body: new URLSearchParams({
          bundle: JSON.stringify(tamper(overhaul.bundle, { remarks: 'No defects found.' })),
        }),
      })
    ).text()

    assert.match(body, /Not verified/)
    // The callout that names the lesson explicitly, rather than leaving the
    // reader to infer it from two adjacent rows.
    assert.match(body, /Read these two together/)
    assert.match(body, /badge pass/)
    assert.match(body, /badge fail/)
  })

  test('a forged document reports a proof of absence', async () => {
    const { app, overhaul } = await appWithNetwork()
    const forged = parseBundle({
      ...JSON.parse(JSON.stringify(overhaul.bundle)),
      uri: `at://did:plc:cs4gk2mp7yv6nbcdefghijkl/dev.cldixon.f8130.release/3mzzzzzzzzz2z`,
    })
    const body = await (
      await app.request('/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
        body: new URLSearchParams({ bundle: JSON.stringify(forged) }),
      })
    ).text()

    assert.match(body, /never published this record/)
  })

  test('malformed JSON gets a readable message, not a stack trace', async () => {
    const { app } = await appWithNetwork()
    const res = await app.request('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: new URLSearchParams({ bundle: '{oh no' }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /not valid JSON/)
  })

  test('the bundle is not echoed into the page', async () => {
    const { app, overhaul } = await appWithNetwork()
    const body = await (
      await app.request('/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
        body: new URLSearchParams({ bundle: JSON.stringify(overhaul.bundle) }),
      })
    ).text()

    // Nonces are the secret that makes selective disclosure work. A page that
    // rendered them back would leak them into browser history and any proxy.
    for (const nonce of overhaul.bundle.nonces) {
      assert.ok(!body.includes(nonce), 'a nonce was rendered into the page')
    }
    assert.ok(!body.includes('Metering valve wear'), 'a private field leaked')
  })
})

describe('browsing with an index', () => {
  test('the issuers page names who is publishing, not what they published', async () => {
    const { app } = await appWithNetwork(
      emptyIndex({
        recentReleases: async () => [releaseRow()],
        issuerStats: async () => [
          { did: 'did:plc:cs4gk2mp7yv6nbcdefghijkl', releases: 1, attested: 0 },
        ],
        handleFor: async () => 'cascadia-mro.f8130.cldixon.dev',
      }),
    )
    const body = await (await app.request('/parts')).text()
    assert.match(body, /cascadia-mro/)

    // It used to open with a table of recent releases, which is the feed with
    // fewer columns. Two destinations answering one question is one too many,
    // so the release list went and the accountability column stayed — that
    // number has no other home in the application.
    assert.ok(!body.includes('NT882104'), 'the release table came back')
    assert.match(body, /Independently checked/)
  })

  /**
   * The one screen that is entirely about who is publishing named everybody by
   * handle and nobody by name, even where a station record had said what the
   * organization calls itself.
   */
  test('an issuer with a station record is named by it', async () => {
    const { app } = await appWithNetwork(
      emptyIndex({
        issuerStats: async () => [
          { did: 'did:plc:cs4gk2mp7yv6nbcdefghijkl', releases: 1, attested: 0 },
        ],
        handleFor: async () => 'cascadia-mro.f8130.cldixon.dev',
        actorsFor: async (dids) =>
          new Map(
            dids.map((did) => [
              did,
              actorRow({ did, displayName: 'Cascadia MRO', kind: 'mro' }),
            ]),
          ),
      }),
    )
    const body = await (await app.request('/parts')).text()
    assert.match(body, /Cascadia MRO/)
  })

  test('coverage is shown as a count against the total, not as a verdict', async () => {
    const { app } = await appWithNetwork(
      emptyIndex({
        issuerStats: async (): Promise<IssuerStat[]> => [
          { did: 'did:plc:mr5jq8tn3wz7pbcdefghijkm', releases: 8, attested: 1 },
        ],
      }),
    )
    const body = await (await app.request('/parts')).text()

    // Thin coverage can mean nobody got round to checking as easily as it can
    // mean something is wrong, so the page reports the two numbers and leaves
    // the weighing to a reader. It used to render a "flagged" class off a
    // rejection count, which was a judgement the data could not support.
    assert.match(body, /1 of 8/)
    assert.ok(!body.includes('class="flagged"'), 'the page passed a verdict')
  })

  test('the part page shows claimed and observed times side by side', async () => {
    const { app } = await appWithNetwork(
      emptyIndex({
        releasesForPart: async () => [releaseRow()],
        chain: async () => [releaseRow()],
      }),
    )
    const body = await (await app.request('/part/NT882104/SN000417')).text()
    assert.match(body, /Completed \(claimed\)/)
    assert.match(body, /First observed here/)
    assert.match(body, /2026-01-22 09:30:00Z/)
    assert.match(body, /2026-01-22 10:00:00Z/)
  })

  test('a chain that stops short is called out as a gap', async () => {
    const { app } = await appWithNetwork(
      emptyIndex({
        releasesForPart: async () => [
          releaseRow({ prevUri: 'at://did:plc:x/dev.cldixon.f8130.release/missing', prevCid: 'bafymissing' }),
        ],
        chain: async () => [
          releaseRow({ prevUri: 'at://did:plc:x/dev.cldixon.f8130.release/missing', prevCid: 'bafymissing' }),
        ],
      }),
    )
    const body = await (await app.request('/part/NT882104/SN000417')).text()
    assert.match(body, /stops before the part's original manufacture/)
  })

  test('an unseen part says so without claiming it does not exist', async () => {
    const { app } = await appWithNetwork(emptyIndex())
    const res = await app.request('/part/NT999999/SN000001')
    assert.equal(res.status, 404)
    const body = await res.text()
    assert.match(body, /not proof none exists/)
  })

  test('public checks appear against the release they cover', async () => {
    const check: AttestationRow = {
      cid: 'bafyatt',
      uri: 'at://did:plc:exa/dev.cldixon.f8130.attestation/1',
      subjectUri: releaseRow().uri,
      subjectCid: 'bafyoverhaul',
      verifierDid: 'did:plc:exa1r2t3u4v5wbcdefghijkn',
      issuerDid: 'did:plc:cs4gk2mp7yv6nbcdefghijkl',
      verifiedAt: new Date('2026-02-01T12:00:00Z'),
      observedAt: new Date('2026-02-01T12:05:00Z'),
    }
    const { app } = await appWithNetwork(
      emptyIndex({
        releasesForPart: async () => [releaseRow()],
        chain: async () => [releaseRow()],
        attestationsForSubjects: async () => [check],
      }),
    )
    const body = await (await app.request('/part/NT882104/SN000417')).text()
    assert.match(body, /Independently checked by/)
  })

  test('the chain API reports whether birth was reached', async () => {
    const { app } = await appWithNetwork(
      emptyIndex({ chain: async () => [releaseRow()] }),
    )
    const res = await app.request('/api/chain/bafyoverhaul')
    assert.equal(res.status, 200)
    const body = (await res.json()) as any
    assert.equal(body.reachedBirth, true)
    assert.equal(body.chain.length, 1)
  })

  test('the chain API 404s for an unknown record', async () => {
    const { app } = await appWithNetwork(emptyIndex())
    assert.equal((await app.request('/api/chain/bafynope')).status, 404)
  })
})

describe('zero-configuration deployment', () => {
  test('an empty environment resolves to demo mode', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig({} as NodeJS.ProcessEnv)
    assert.equal(c.mode, 'demo')
    assert.equal(c.modeInferred, true)
    assert.equal(c.databaseUrl, null)
    assert.equal(c.hostname, '::')
  })

  test('a database implies a real deployment', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv)
    assert.equal(c.mode, 'live')
    assert.equal(c.modeInferred, true)
  })

  test('an explicit mode always wins', async () => {
    const { loadConfig } = await import('../src/config.js')
    assert.equal(
      loadConfig({ F8130_MODE: 'demo', DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv).mode,
      'demo',
    )
    assert.equal(
      loadConfig({ F8130_MODE: 'live' } as NodeJS.ProcessEnv).mode,
      'live',
    )
  })

  test('the previous variable still works, so a live service does not break', async () => {
    const { loadConfig } = await import('../src/config.js')
    const c = loadConfig({ F8130_DEMO_MODE: '1' } as NodeJS.ProcessEnv)
    assert.equal(c.mode, 'demo')
    assert.equal(c.modeInferred, false)
  })

  test('a demo instance says so on every page', async () => {
    const { net } = await standardNetwork()
    const { createApp } = await import('../src/app.js')
    const app = createApp({ resolver: net, repo: net, mode: 'demo' })
    for (const path of ['/', '/verify']) {
      const body = await (await app.request(path)).text()
      assert.match(body, /Demo instance/, `${path} does not disclose demo mode`)
    }
  })

  test('a live instance does not claim to be a demo', async () => {
    const { net } = await standardNetwork()
    const { createApp } = await import('../src/app.js')
    const app = createApp({ resolver: net, repo: net, mode: 'live' })
    const body = await (await app.request('/verify')).text()
    assert.ok(!body.includes('Demo instance'))
  })

  test('health reports the mode', async () => {
    const { net } = await standardNetwork()
    const { createApp } = await import('../src/app.js')
    const app = createApp({ resolver: net, repo: net, mode: 'demo' })
    assert.deepEqual(await (await app.request('/api/health')).json(), {
      ok: true,
      mode: 'demo',
      index: false,
    })
  })
})

describe('selective disclosure', () => {
  test('proves a private field without revealing the others', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request('/disclose', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: new URLSearchParams([
        ['bundle', JSON.stringify(overhaul.bundle)],
        ['field', 'remarks'],
      ]),
    })
    assert.equal(res.status, 200)
    const body = await res.text()

    assert.match(body, /Disclosure verifies/)
    assert.match(body, /proven/)
    // The whole point: the rest of the form is not in the page.
    assert.ok(!body.includes('A. Technician'), 'signerName leaked')
    assert.ok(!body.includes('WO20260042'), 'workOrder leaked')
  })

  test('the disclosure document carries one nonce, not seventeen', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request('/api/disclose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: overhaul.bundle, fields: ['remarks'] }),
    })
    const doc = JSON.stringify(await res.json())
    const leaked = overhaul.bundle.nonces.filter((n) => doc.includes(n))
    assert.equal(leaked.length, 1)
  })

  test('a disclosure verifies against the published record', async () => {
    const { app, overhaul } = await appWithNetwork()
    const disclosure = await (
      await app.request('/api/disclose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bundle: overhaul.bundle, fields: ['status', 'remarks'] }),
      })
    ).json()

    const res = await app.request('/api/disclose/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disclosure }),
    })
    assert.equal(res.status, 200)
    const result = (await res.json()) as any
    assert.equal(result.verified, true)
    assert.equal(result.withheld.length, 15)
  })

  test('an overstated field is caught', async () => {
    const { app, overhaul } = await appWithNetwork()
    const disclosure: any = await (
      await app.request('/api/disclose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bundle: overhaul.bundle, fields: ['remarks'] }),
      })
    ).json()
    disclosure.fields[0].value = 99

    const res = await app.request('/api/disclose/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disclosure }),
    })
    assert.equal(res.status, 422)
    assert.equal(((await res.json()) as any).verified, false)
  })

  test('a disclosure for a record that was never published 404s', async () => {
    const { app, overhaul } = await appWithNetwork()
    const disclosure: any = await (
      await app.request('/api/disclose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bundle: overhaul.bundle, fields: ['remarks'] }),
      })
    ).json()
    disclosure.uri = `at://${CASCADIA.did}/dev.cldixon.f8130.release/3mzzzzzzzzz2z`

    const res = await app.request('/api/disclose/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disclosure }),
    })
    assert.equal(res.status, 404)
  })

  test('choosing no fields is refused', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request('/disclose', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: new URLSearchParams({ bundle: JSON.stringify(overhaul.bundle) }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /at least one field/)
  })
})

/* --------------------------------------------------------------- writing */

import type { Actor, RecordWriter, StrongRef } from '../src/writer.js'

/** Records what was asked for, so the tests can assert on intent. */
function fakeWriter(over: Partial<RecordWriter> = {}) {
  const calls: any[] = []
  const actors: Actor[] = [
    { handle: 'cascadia-mro.f8130.cldixon.dev', displayName: 'Cascadia MRO', kind: 'mro' },
    { handle: 'example-air.f8130.cldixon.dev', displayName: 'Example Air', kind: 'operator' },
  ]
  const writer: RecordWriter = {
    actors: () => actors,
    createRelease: async (p) => {
      calls.push({ kind: 'release', ...p })
      return {
        uri: 'at://did:plc:x/dev.cldixon.f8130.release/3new',
        cid: 'bafynew',
        bundle: { synthetic: 'S', version: 1, uri: 'at://x', issuerHandle: p.handle, values: {}, nonces: [] } as any,
      }
    },
    createAttestation: async (p) => {
      calls.push({ kind: 'attestation', ...p })
      return { uri: 'at://did:plc:y/dev.cldixon.f8130.attestation/3att', cid: 'bafyatt' }
    },
    ...over,
  }
  return { writer, calls }
}

/**
 * The cookie the viewpoint control sets.
 *
 * Write requests carry it because the public viewpoint deliberately cannot
 * sign: the app no longer falls back to whoever happens to be first in the
 * roster, which is the bug that made the generate-example button issue as the
 * wrong organization.
 */
const ACTING = 'f8130_actor=cascadia-mro.f8130.cldixon.dev'

async function appWithWriter(over: Partial<RecordWriter> = {}) {
  const { net, overhaul } = await standardNetwork()
  const { writer, calls } = fakeWriter(over)
  const app = createApp({ resolver: net, repo: net, writer, mode: 'live' })
  return { app, calls, overhaul, net }
}

describe('issuance', () => {
  test('the write pages are absent when no writer is configured', async () => {
    const { app } = await appWithNetwork()
    assert.equal((await app.request('/issue')).status, 404)
    assert.equal((await app.request('/accept')).status, 404)
  })

  test('issuing returns a bundle and says to keep it', async () => {
    const { app, calls } = await appWithWriter()
    const res = await app.request('/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: new URLSearchParams({
        approvingAuthority: 'FAA/United States',
        formNumber: 'SYNTHETIC-8130-9001',
        organizationName: 'Cascadia MRO',
        organizationAddress: '4400 Airport Way, Everett, WA 98204',
        description: 'Fuel control unit',
        partNumber: 'NT-1234-56',
        serialNumber: 'SN-999001',
        status: 'REPAIRED',
        certifyingBlock: 'RETURN_TO_SERVICE',
        approvalBasis: 'PART_43_RETURN_TO_SERVICE',
        signerCert: 'SYNTHETIC-CERT-1',
        completedAt: '2026-04-01T12:00:00Z',
        quantity: '2',
        remarks: 'Nothing of note.',
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /Released/)
    assert.match(body, /cannot be reconstructed/)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].form.partNumber, 'NT-1234-56')
    assert.equal(calls[0].form.quantity, 2, 'numbers must arrive as numbers')
  })

  test('empty optional fields are omitted rather than sent as empty strings', async () => {
    const { app, calls } = await appWithWriter()
    await app.request('/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: new URLSearchParams({
        approvingAuthority: 'FAA/United States',
        formNumber: 'F', partNumber: 'P', serialNumber: 'S', status: 'NEW',
        organizationName: 'O', organizationAddress: 'A', description: 'D',
        certifyingBlock: 'CONFORMITY', approvalBasis: 'APPROVED_DESIGN_DATA',
        signerCert: 'C', completedAt: '2026-04-01T12:00:00Z',
        remarks: '', quantity: '',
      }),
    })
    // An empty string is a committed value meaning "blank"; absent means "no
    // such field". Sending the wrong one silently changes the commitment.
    assert.ok(!('quantity' in calls[0].form))
    assert.ok(!('remarks' in calls[0].form))
  })

  test('a malformed form surfaces the canonicalization error', async () => {
    const { app } = await appWithWriter({
      createRelease: async () => {
        throw new Error('completedAt: expected RFC 3339 with a UTC offset')
      },
    })
    const res = await app.request('/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: new URLSearchParams({ completedAt: 'yesterday' }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /RFC 3339/)
  })

  test('the persona picker only accepts known accounts', async () => {
    const { app } = await appWithWriter()
    const res = await app.request('/act-as', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: new URLSearchParams({ handle: 'attacker.example.com' }),
    })
    assert.equal(res.headers.get('set-cookie'), null)
  })
})

describe('verdicts', () => {
})

describe('field labels', () => {
  /**
   * A field with no label renders as a camelCase identifier, which looks like
   * a bug to nobody and reads as one to everybody. Growing the field set
   * without growing the label table is the way that happens.
   */
  test('every committed field has a human label naming its block', () => {
    for (const name of FIELD_ORDER) {
      const label = fieldLabel(name)
      assert.notEqual(label, name, `${name} has no label`)
      assert.match(label, /^Block \S+ · /, `${name}: ${label}`)
    }
  })
})

describe('the form view', () => {
  const post = (app: any, body: Record<string, string>) =>
    app.request('/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: new URLSearchParams(body),
    })

  test('renders the certificate from the public record alone', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request(`/form?uri=${encodeURIComponent(overhaul.bundle.uri)}`)
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /AUTHORIZED RELEASE CERTIFICATE/)
    assert.match(body, /FAA Form 8130-3/)
  })

  /**
   * The load-bearing test. A passer-by holds no bundle, so the eight withheld
   * blocks must not be recoverable from the page — not in a block, not in the
   * record pane, not in an attribute. A form view that quietly rendered the
   * whole document would undo the entire design.
   */
  test('never leaks a withheld block to a viewer with no bundle', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request(`/form?uri=${encodeURIComponent(overhaul.bundle.uri)}`)
    const body = await res.text()

    // Structural first: each non-public block that the sheet draws must say
    // withheld inside its own markup. Checked per block rather than by
    // searching the page, so a value appearing anywhere else still fails.
    for (const field of FIELDS.filter((f) => !f.public)) {
      const start = body.indexOf(`name="field" value="${field.name}"`)
      if (start < 0) continue // rendered as the certifying statement, not a block
      const end = body.indexOf('</button>', start)
      const rendered = body.slice(start, end)
      assert.match(
        rendered,
        />withheld</,
        `${field.name} (Block ${field.block}) rendered a value`,
      )
    }

    // Then a page-wide sweep, for values distinctive enough that a match means
    // something. Short values like a quantity of 1 collide with hash digits and
    // block numbers, so they are covered by the structural check alone.
    for (const field of FIELDS.filter((f) => !f.public)) {
      const value = overhaul.bundle.values[field.name]
      if (typeof value !== 'string' || value.length < 6) continue
      assert.ok(
        !body.includes(value),
        `${field.name} (Block ${field.block}) leaked its value: ${value}`,
      )
    }
  })

  test('no nonce ever reaches a page', async () => {
    const { app, overhaul } = await appWithNetwork()
    const raw = JSON.stringify(overhaul.bundle)
    for (const res of [
      await app.request(`/form?uri=${encodeURIComponent(overhaul.bundle.uri)}`),
      await post(app, { uri: overhaul.bundle.uri, bundle: raw, field: 'remarks' }),
    ]) {
      const body = await res.text()
      // The echoed hidden field legitimately carries the nonces back to the
      // browser that just sent them; nothing before it may.
      const beforeEcho = body.split('name="bundle"')[0]!
      for (const nonce of overhaul.bundle.nonces) {
        assert.ok(
          !beforeEcho.includes(nonce),
          'a nonce appeared on the page outside the echoed bundle',
        )
      }
    }
  })

  test('says the commitment cannot be opened without a bundle', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request(`/form?uri=${encodeURIComponent(overhaul.bundle.uri)}`)
    const body = await res.text()
    assert.match(body, /cannot open a leaf from the commitment/)
    assert.ok(!body.includes('Folding'), 'offered a fold with no leaves to fold')
  })

  test('a bundle fills every block and opens the commitment', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await post(app, {
      uri: overhaul.bundle.uri,
      bundle: JSON.stringify(overhaul.bundle),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /opens the published commitment/)
    assert.ok(!body.includes('>withheld<'), 'a block stayed withheld despite the bundle')
    assert.match(body, /Metering valve wear/)
  })

  test('folds a chosen leaf all the way to the published root', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await post(app, {
      uri: overhaul.bundle.uri,
      bundle: JSON.stringify(overhaul.bundle),
      field: 'remarks',
    })
    const body = await res.text()
    assert.match(body, /Folding/)
    assert.match(body, /identical to the published root/)
  })

  /** The fold has to be arithmetic, not decoration. */
  test('a tampered value stops reaching the root', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await post(app, {
      uri: overhaul.bundle.uri,
      bundle: JSON.stringify({
        ...overhaul.bundle,
        values: { ...overhaul.bundle.values, remarks: 'No defects.' },
      }),
      field: 'remarks',
    })
    const body = await res.text()
    assert.match(body, /does not open the published commitment/)
    assert.match(body, /does not reach the published root/)
  })

  test('clicking a block with nothing pasted is not an error', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await post(app, { uri: overhaul.bundle.uri, bundle: '', field: 'status' })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /cannot open a leaf from the commitment/)
  })

  test('an unreadable bundle says so without losing the page', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await post(app, { uri: overhaul.bundle.uri, bundle: 'not json' })
    assert.equal(res.status, 422)
    const body = await res.text()
    assert.match(body, /bundle could not be read/)
    assert.match(body, /AUTHORIZED RELEASE CERTIFICATE/)
  })

  /**
   * A convincing 8130-3 is the one artifact here that must never travel
   * without saying what it is, and a screenshot crops corners.
   */
  test('carries the synthetic mark across the sheet itself', async () => {
    const { app, overhaul } = await appWithNetwork()
    for (const res of [
      await app.request(`/form?uri=${encodeURIComponent(overhaul.bundle.uri)}`),
      await post(app, {
        uri: overhaul.bundle.uri,
        bundle: JSON.stringify(overhaul.bundle),
      }),
    ]) {
      assert.match(await res.text(), /NOT AN AIRWORTHINESS RECORD/)
    }
  })

  test('a missing uri is a 400, not a crash', async () => {
    const { app } = await appWithNetwork()
    assert.equal((await app.request('/form')).status, 400)
  })
})

describe('issuing from a generated example', () => {
  /**
   * The regression this exists for.
   *
   * The issue form was a hand-written field list and the field set moved out
   * from under it: for a while it asked for cost and customer, which are not
   * blocks on an 8130-3, and never asked for Block 1, Block 4 or the certifying
   * column, all of which a record requires. It rendered perfectly and could not
   * produce a valid record. Only a test that goes through the rendered inputs
   * catches that — one that POSTs field names directly does not.
   */
  test('the rendered form offers an input for every committed field', async () => {
    const { app } = await appWithWriter()
    const body = await (
      await app.request('/issue', { headers: { cookie: ACTING } })
    ).text()
    for (const spec of FIELDS) {
      assert.ok(
        body.includes(`name="${spec.name}"`),
        `no input for ${spec.name} (Block ${spec.block})`,
      )
    }
  })

  test('offers nothing that is not a committed field', async () => {
    const { app } = await appWithWriter()
    const body = await (
      await app.request('/issue', { headers: { cookie: ACTING } })
    ).text()
    for (const gone of ['findings', 'workscope', 'costCents', 'customer']) {
      assert.ok(!body.includes(`name="${gone}"`), `${gone} is not a field any more`)
    }
  })

  test('generates an example filled into every input', async () => {
    const { app } = await appWithWriter()
    const body = await (
      await app.request('/issue', { headers: { cookie: ACTING } })
    ).text()
    const empties = FIELDS.filter((f) =>
      f.name === 'remarks'
        ? /name="remarks"[^>]*><\/textarea>/.test(body)
        : body.includes(`name="${f.name}" value=""`),
    )
    assert.deepEqual(empties.map((f) => f.name), [], 'a generated example left blanks')
  })

  /**
   * End to end through the rendered markup: pull the generated values back out
   * of the inputs and post exactly those. If the form and the field set ever
   * disagree again, this fails at the commitment rather than looking fine.
   */
  test('a generated example issues without being edited', async () => {
    const { app, calls } = await appWithWriter()
    const page = await (
      await app.request('/issue', { headers: { cookie: ACTING } })
    ).text()

    const submitted = new URLSearchParams()
    for (const spec of FIELDS) {
      if (spec.kind === 'enum') {
        const m = new RegExp(`<option value="([^"]+)" selected>`).exec(
          page.slice(page.indexOf(`name="${spec.name}"`)),
        )
        assert.ok(m, `${spec.name} had no selected option`)
        submitted.set(spec.name, m![1]!)
      } else if (spec.name === 'remarks') {
        const m = /name="remarks"[^>]*>([^<]*)<\/textarea>/.exec(page)
        assert.ok(m, 'remarks had no value')
        submitted.set(spec.name, m![1]!)
      } else {
        const m = new RegExp(`name="${spec.name}" value="([^"]*)"`).exec(page)
        assert.ok(m, `${spec.name} had no value`)
        submitted.set(spec.name, m![1]!)
      }
    }

    const res = await app.request('/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTING },
      body: submitted,
    })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Released/)
    assert.equal(calls.length, 1)

    // Every block reached the writer, and the pair that has to agree does.
    for (const spec of FIELDS) {
      assert.ok(spec.name in calls[0].form, `${spec.name} never reached the writer`)
    }
    assert.ok(
      validateApprovalBasis(
        String(calls[0].form.certifyingBlock),
        String(calls[0].form.approvalBasis),
      ),
      'the generated example paired an illegal approval basis',
    )
  })

  test('the example is the acting organization issuing, so Block 4 is its own', async () => {
    const { app } = await appWithWriter()
    const body = await (
      await app.request('/issue', { headers: { cookie: ACTING } })
    ).text()
    const org = orgs('f8130.cldixon.dev').find(
      (o) => o.handle === 'cascadia-mro.f8130.cldixon.dev',
    )!
    assert.ok(
      body.includes(`name="organizationName" value="${org.displayName}"`),
      'Block 4 did not name the acting organization',
    )
    assert.ok(
      body.includes(`name="organizationAddress" value="${org.address}"`),
      'Block 4 did not carry that organization\'s address',
    )
  })
})

describe('the shared form builder', () => {
  test('is deterministic in its seed', () => {
    const org = orgs('f8130.example')[0]!
    const now = new Date('2026-06-01T00:00:00Z')
    assert.deepEqual(
      syntheticForm({ org, seed: 42, now }),
      syntheticForm({ org, seed: 42, now }),
    )
  })

  test('different seeds give different parts', () => {
    const org = orgs('f8130.example').find((o) => o.kind === 'mro')!
    const now = new Date('2026-06-01T00:00:00Z')
    const seen = new Set(
      [...Array(40)].map((_, i) => String(syntheticForm({ org, seed: i, now }).partNumber)),
    )
    assert.ok(seen.size > 3, `only ${seen.size} distinct parts across 40 seeds`)
  })

  /** Every generated form must canonicalize and commit, whatever the seed. */
  test('every seed produces a committable form with a legal basis', () => {
    const now = new Date('2026-06-01T00:00:00Z')
    for (const org of orgs('f8130.example')) {
      for (let seed = 0; seed < 12; seed++) {
        const form = syntheticForm({ org, seed, now })
        assert.doesNotThrow(() => commitForm(form), `${org.key} seed ${seed}`)
        assert.ok(
          validateApprovalBasis(String(form.certifyingBlock), String(form.approvalBasis)),
          `${org.key} seed ${seed}: ${form.certifyingBlock} with ${form.approvalBasis}`,
        )
      }
    }
  })

  /** A manufacturer certifies conformity; everyone else returns to service. */
  test('a manufacturer issues under Block 13 and a repair station under 14', () => {
    const now = new Date('2026-06-01T00:00:00Z')
    const oem = orgs('f8130.example').find((o) => o.kind === 'oem')!
    const mro = orgs('f8130.example').find((o) => o.kind === 'mro')!
    for (let seed = 0; seed < 8; seed++) {
      assert.equal(syntheticForm({ org: oem, seed, now }).certifyingBlock, 'CONFORMITY')
      assert.equal(
        syntheticForm({ org: mro, seed, now }).certifyingBlock,
        'RETURN_TO_SERVICE',
      )
    }
  })
})
