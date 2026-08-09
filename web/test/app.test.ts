import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  CASCADIA,
  parseBundle,
  standardNetwork,
  type Bundle,
} from '@f8130/core'

import { createApp } from '../src/app.js'
import type {
  AcceptanceRow,
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
  recentReleases: async () => [],
  releasesForPart: async () => [],
  chain: async () => [],
  acceptancesForSubjects: async () => [],
  issuerStats: async () => [],
  handleFor: async () => null,
  ...over,
})

const releaseRow = (over: Partial<ReleaseRow> = {}): ReleaseRow => ({
  cid: 'bafyoverhaul',
  uri: 'at://did:plc:cs4gk2mp7yv6nbcdefghijkl/dev.cldixon.f8130.release/3a',
  issuerDid: 'did:plc:cs4gk2mp7yv6nbcdefghijkl',
  prevUri: null,
  prevCid: null,
  partNumber: 'NT882104',
  serialNumber: 'SN000417',
  status: 'OVERHAULED',
  signerCert: 'SYNTHETICCERT12345',
  formNumber: 'SYNTHETIC81300002',
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
      assert.match(body, /SYNTHETIC DATA/, `${path} is missing the marker`)
      assert.match(body, /Synthetic demonstration data/)
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
    const body = await (await app.request('/')).text()
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
      body: JSON.stringify(tamper(overhaul.bundle, { findings: 'No defects' })),
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
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          bundle: JSON.stringify(tamper(overhaul.bundle, { findings: 'No defects found' })),
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
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ bundle: JSON.stringify(forged) }),
      })
    ).text()

    assert.match(body, /never published this record/)
  })

  test('malformed JSON gets a readable message, not a stack trace', async () => {
    const { app } = await appWithNetwork()
    const res = await app.request('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
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
  test('the dashboard lists observed releases', async () => {
    const { app } = await appWithNetwork(
      emptyIndex({
        recentReleases: async () => [releaseRow()],
        issuerStats: async () => [
          { did: 'did:plc:cs4gk2mp7yv6nbcdefghijkl', releases: 1, distinctRejectors: 0 },
        ],
        handleFor: async () => 'cascadia-mro.f8130.cldixon.dev',
      }),
    )
    const body = await (await app.request('/')).text()
    assert.match(body, /NT882104/)
    assert.match(body, /cascadia-mro/)
  })

  test('an issuer with two independent rejections is flagged', async () => {
    const { app } = await appWithNetwork(
      emptyIndex({
        issuerStats: async (): Promise<IssuerStat[]> => [
          { did: 'did:plc:mr5jq8tn3wz7pbcdefghijkm', releases: 3, distinctRejectors: 2 },
        ],
      }),
    )
    const body = await (await app.request('/')).text()
    assert.match(body, /class="flagged"/)
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

  test('operator verdicts appear against the release they judge', async () => {
    const verdict: AcceptanceRow = {
      cid: 'bafyacc',
      uri: 'at://did:plc:exa/dev.cldixon.f8130.acceptance/1',
      subjectUri: releaseRow().uri,
      subjectCid: 'bafyoverhaul',
      issuerDid: 'did:plc:cs4gk2mp7yv6nbcdefghijkl',
      verifierDid: 'did:plc:exa1r2t3u4v5wbcdefghijkn',
      partNumber: 'NT882104',
      serialNumber: 'SN000417',
      outcome: 'rejected',
      note: 'Chain does not reach birth',
      receivedAt: new Date('2026-02-01T12:00:00Z'),
      observedAt: new Date('2026-02-01T12:05:00Z'),
    }
    const { app } = await appWithNetwork(
      emptyIndex({
        releasesForPart: async () => [releaseRow()],
        chain: async () => [releaseRow()],
        acceptancesForSubjects: async () => [verdict],
      }),
    )
    const body = await (await app.request('/part/NT882104/SN000417')).text()
    assert.match(body, /rejected by/)
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
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['bundle', JSON.stringify(overhaul.bundle)],
        ['field', 'costCents'],
      ]),
    })
    assert.equal(res.status, 200)
    const body = await res.text()

    assert.match(body, /Disclosure verifies/)
    assert.match(body, /proven/)
    // The whole point: the rest of the form is not in the page.
    assert.ok(!body.includes('Metering valve wear'), 'findings leaked')
    assert.ok(!body.includes('Full overhaul per CMM'), 'workscope leaked')
  })

  test('the disclosure document carries one nonce, not fifteen', async () => {
    const { app, overhaul } = await appWithNetwork()
    const res = await app.request('/api/disclose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: overhaul.bundle, fields: ['costCents'] }),
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
        body: JSON.stringify({ bundle: overhaul.bundle, fields: ['status', 'costCents'] }),
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
    assert.equal(result.withheld.length, 13)
  })

  test('an overstated field is caught', async () => {
    const { app, overhaul } = await appWithNetwork()
    const disclosure: any = await (
      await app.request('/api/disclose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bundle: overhaul.bundle, fields: ['costCents'] }),
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
        body: JSON.stringify({ bundle: overhaul.bundle, fields: ['costCents'] }),
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
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ bundle: JSON.stringify(overhaul.bundle) }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /at least one field/)
  })
})
