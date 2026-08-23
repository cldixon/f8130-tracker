/**
 * The activity feed, the live stream, and the synthetic generator behind them.
 *
 * These are the three parts of the front page, and each has a claim that only
 * a test can hold honest:
 *
 *   - the feed is ordered on the observer's clock, not on anything an issuer
 *     wrote down, so a backdated certificate cannot choose where it appears;
 *   - the stream renders the same card the page does, so a streamed event and
 *     a reloaded one cannot drift apart;
 *   - the generator writes nothing while nobody is watching, because every
 *     event it produces is a permanent write to a real repository.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { demoNetwork, orgs, FIELDS } from '@f8130/core'

import { ActivityGenerator } from '../src/activity.js'
import { createApp } from '../src/app.js'
import { MemoryIndex, releaseRow } from '../src/memory-index.js'
import { MemoryRecordWriter, demoActors, type RecordWriter } from '../src/writer.js'
import type { AcceptanceRow, DisputeRow, ReleaseRow } from '../src/index-port.js'

const DOMAIN = 'f8130.cldixon.dev'

/** The stored choice to watch as a stranger. */
const PUBLIC = 'f8130_actor=~public'

const release = (over: Partial<ReleaseRow> = {}): ReleaseRow => ({
  cid: 'bafyrel',
  uri: 'at://did:plc:issuer/dev.cldixon.f8130.release/3a',
  issuerDid: 'did:plc:issuer',
  prevUri: null,
  prevCid: null,
  approvingAuthority: 'FAA/United States',
  formNumber: 'SYNTHETIC-8130-0001',
  organizationName: 'Cascadia MRO',
  organizationAddress: '4400 Airport Way, Everett, WA 98204',
  description: 'Fuel control unit',
  partNumber: 'NT882104',
  serialNumber: 'SN000417',
  signerCert: 'SYNTHETIC-CERT-1',
  completedAt: new Date('2026-01-22T09:30:00Z'),
  observedAt: new Date('2026-01-22T10:00:00Z'),
  ...over,
})

const verdict = (over: Partial<AcceptanceRow> = {}): AcceptanceRow => ({
  cid: 'bafyacc',
  uri: 'at://did:plc:operator/dev.cldixon.f8130.acceptance/3b',
  subjectUri: 'at://did:plc:issuer/dev.cldixon.f8130.release/3a',
  subjectCid: 'bafyrel',
  issuerDid: 'did:plc:issuer',
  verifierDid: 'did:plc:operator',
  partNumber: 'NT882104',
  serialNumber: 'SN000417',
  outcome: 'accepted',
  note: null,
  receivedAt: new Date('2026-01-23T08:00:00Z'),
  observedAt: new Date('2026-01-23T08:05:00Z'),
  ...over,
})

async function feedApp(seed: (index: MemoryIndex) => void = () => {}) {
  const { net } = await demoNetwork(DOMAIN)
  const index = new MemoryIndex()
  seed(index)
  const app = createApp({ resolver: net, repo: net, index, mode: 'live' })
  return { app, index, net }
}

describe('the read model', () => {
  test('interleaves releases and verdicts, newest observation first', async () => {
    const index = new MemoryIndex()
    index.addRelease(release({ cid: 'a', observedAt: new Date('2026-02-01T00:00:00Z') }))
    index.addVerdict(verdict({ cid: 'b', observedAt: new Date('2026-02-03T00:00:00Z') }))
    index.addRelease(release({ cid: 'c', observedAt: new Date('2026-02-02T00:00:00Z') }))

    const events = await index.feed({ limit: 10 })
    assert.deepEqual(
      events.map((e) => (e.kind === 'release' ? e.release.cid : e.verdict.cid)),
      ['b', 'c', 'a'],
    )
  })

  /**
   * The property the whole ordering choice exists for: an issuer who backdates
   * Block 14b still lands wherever the observer saw them, not at the top.
   */
  test('a backdated certificate cannot choose where it appears', async () => {
    const index = new MemoryIndex()
    index.addRelease(
      release({
        cid: 'old',
        completedAt: new Date('2020-01-01T00:00:00Z'),
        observedAt: new Date('2026-02-02T00:00:00Z'),
      }),
    )
    index.addRelease(
      release({
        cid: 'backdated',
        // Claims to predate the other one by a decade.
        completedAt: new Date('2010-01-01T00:00:00Z'),
        observedAt: new Date('2026-02-03T00:00:00Z'),
      }),
    )
    const events = await index.feed({ limit: 10 })
    assert.equal(events[0]!.kind === 'release' && events[0]!.release.cid, 'backdated')
  })

  test('since returns only what arrived after that moment', async () => {
    const index = new MemoryIndex()
    index.addRelease(release({ cid: 'before', observedAt: new Date('2026-02-01T00:00:00Z') }))
    index.addRelease(release({ cid: 'after', observedAt: new Date('2026-02-05T00:00:00Z') }))

    const fresh = await index.feed({ limit: 10, since: new Date('2026-02-02T00:00:00Z') })
    assert.deepEqual(
      fresh.map((e) => (e.kind === 'release' ? e.release.cid : e.verdict.cid)),
      ['after'],
    )

    // Exclusive, so re-polling with the newest timestamp cannot replay it.
    const again = await index.feed({ limit: 10, since: new Date('2026-02-05T00:00:00Z') })
    assert.equal(again.length, 0)
  })
})

describe('the feed page', () => {
  test('shows releases and verdicts as one stream', async () => {
    const { app } = await feedApp((i) => {
      i.addRelease(release())
      i.addVerdict(verdict({ outcome: 'rejected', note: 'Serial number does not match.' }))
      i.setHandle('did:plc:operator', 'example-air.f8130.cldixon.dev')
      i.setHandle('did:plc:issuer', 'cascadia-mro.f8130.cldixon.dev')
    })
    const body = await (await app.request('/')).text()
    assert.match(body, /issued a release certificate/)
    assert.match(body, /rejected/)
    assert.match(body, /Serial number does not match\./)
    // The verdict names the operator by display name. A verdict record carries
    // no name — the recipient is not a block on an 8130-3 — so this only reads
    // properly if the handle the index resolved was matched to the roster.
    assert.match(body, /Example Air/)
  })

  test('a verdict card says which release it answers', async () => {
    const { app } = await feedApp((i) => {
      i.addVerdict(verdict())
      i.setHandle('did:plc:operator', `example-air.${DOMAIN}`)
      i.setHandle('did:plc:issuer', `cascadia-mro.${DOMAIN}`)
    })
    const body = await (await app.request('/')).text()
    assert.match(body, /replying to/)
    // Points at the release's permalink, not the verdict's own.
    assert.match(body, /href="\/post\/did%3Aplc%3Aissuer\/3a"/)
  })

  test('says how many blocks are committed but withheld', async () => {
    const { app } = await feedApp((i) => i.addRelease(release()))
    const body = await (await app.request('/')).text()
    // Eight of seventeen, and the page has to say so: the interesting claim is
    // that the index never held them, not that it chose not to render them.
    assert.match(body, /8 of 17 blocks committed and withheld/)
  })

  test('a private block never reaches the page', async () => {
    const { app } = await feedApp((i) => i.addRelease(release()))
    const body = await (await app.request('/')).text()
    for (const secret of ['REPAIRED', 'Metering valve wear', 'R. Inspector']) {
      assert.ok(!body.includes(secret), `${secret} leaked into the feed`)
    }
  })

  test('with no index it says browsing is down and verification is not', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const app = createApp({ resolver: net, repo: net, index: null, mode: 'live' })
    const body = await (await app.request('/')).text()
    assert.match(body, /No index is attached/)
    assert.match(body, /Check a document/)
  })
})

describe('threads', () => {
  const dispute = (over: Partial<DisputeRow> = {}): DisputeRow => ({
    cid: 'bafydis',
    uri: 'at://did:plc:issuer/dev.cldixon.f8130.dispute/3c',
    subjectUri: 'at://did:plc:operator/dev.cldixon.f8130.acceptance/3b',
    subjectCid: 'bafyacc',
    authorDid: 'did:plc:issuer',
    response: 'Back-to-birth records were supplied at time of sale.',
    disputedAt: new Date('2026-01-24T10:00:00Z'),
    observedAt: new Date('2026-01-24T10:01:00Z'),
    ...over,
  })

  const threaded = () =>
    feedApp((i) => {
      i.addRelease(release())
      i.addVerdict(verdict({ outcome: 'rejected', note: 'Serial does not match.' }))
      i.addDispute(dispute())
      i.setHandle('did:plc:issuer', `cascadia-mro.${DOMAIN}`)
      i.setHandle('did:plc:operator', `example-air.${DOMAIN}`)
    })

  const PERMALINK = '/post/did:plc:issuer/3a'

  test('a release, the verdict against it, and the answer to that', async () => {
    const { app } = await threaded()
    const body = await (await app.request(PERMALINK)).text()

    assert.match(body, /Fuel control unit/)
    assert.match(body, /rejected the part/)
    assert.match(body, /Serial does not match\./)
    assert.match(body, /Back-to-birth records were supplied/)

    // The order is the argument: the answer is nested under the verdict, and
    // the verdict under the release.
    assert.ok(
      body.indexOf('rejected the part') < body.indexOf('Back-to-birth records'),
      'the reply must come after the verdict it answers',
    )
  })

  /**
   * The whole reason the thread shape is worth borrowing. An issuer cannot
   * remove a verdict published against them, because it is a record in
   * somebody else's repository, and the page has to say so where the verdict
   * is rather than in a paragraph elsewhere.
   */
  test('says the verdict is not the issuer\'s to remove', async () => {
    const { app } = await threaded()
    const body = await (await app.request(PERMALINK)).text()
    assert.match(body, /own\s+repository/)
    // Whitespace-insensitive: the sentence wraps in the markup.
    assert.match(body, /not\s+theirs\s+to\s+remove/)
  })

  /**
   * A checkmark would say this service vouches for the document. It does not
   * and cannot: it holds no bundle, so it cannot recompute the commitment. It
   * offers to run the checks and show them.
   */
  test('offers to run the checks rather than stamping a mark', async () => {
    const { app } = await threaded()
    const body = await (await app.request(PERMALINK)).text()
    assert.match(body, /Check a document against it/)
    assert.ok(!/verified.{0,20}✓|✓.{0,20}verified/i.test(body), 'a badge crept in')
  })

  test('a release with no verdict says so rather than looking finished', async () => {
    const { app } = await feedApp((i) => i.addRelease(release()))
    const body = await (await app.request(PERMALINK)).text()
    assert.match(body, /No verdict has been published/)
  })

  test('the withheld blocks stay withheld in a thread', async () => {
    const { app } = await threaded()
    const body = await (await app.request(PERMALINK)).text()
    for (const secret of ['REPAIRED', 'Metering valve wear', 'R. Inspector']) {
      assert.ok(!body.includes(secret), `${secret} leaked into the thread`)
    }
    assert.match(body, /8 of 17 blocks are committed but not published/)
  })

  test('a release this observer has never seen is a 404, not an error', async () => {
    const { app } = await feedApp()
    const res = await app.request('/post/did:plc:nobody/3zz')
    assert.equal(res.status, 404)
    assert.match(await res.text(), /has not seen that release/)
  })

  test('the permalink is repo plus record key, so a reindex cannot break it', async () => {
    const { app } = await threaded()
    // Same release, a CID this index no longer stores under.
    const body = await (await app.request(PERMALINK)).text()
    assert.match(body, /Fuel control unit/)
    assert.ok(!body.includes('bafyrel'), 'the URL should not depend on the CID')
  })
})

describe('a part as a topic', () => {
  /**
   * The demonstration network really has a two-visit chain, so the page can be
   * asked to walk it live rather than being handed a stub.
   */
  async function partApp(seed?: (i: MemoryIndex) => void) {
    const { net, birth, overhaul } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const seen = new Date('2026-02-01T00:00:00Z')
    for (const [handle, issued, prev] of [
      [`northwind-turbine.${DOMAIN}`, birth, undefined],
      [
        `cascadia-mro.${DOMAIN}`,
        overhaul,
        { uri: birth.uri, cid: String(birth.cid) },
      ],
    ] as const) {
      index.setHandle(issued.uri.split('/')[2]!, handle)
      index.addRelease(
        releaseRow({
          uri: issued.uri,
          cid: String(issued.cid),
          bundle: issued.bundle,
          prev,
          observedAt: seen,
        }),
      )
    }
    seed?.(index)
    const app = createApp({ resolver: net, repo: net, index, mode: 'live' })
    const part = issued0(overhaul)
    return { app, index, net, part }
  }

  const issued0 = (o: { bundle: { values: Record<string, unknown> } }) => ({
    pn: String(o.bundle.values.partNumber),
    sn: String(o.bundle.values.serialNumber),
  })

  test('is a topic, not a profile', async () => {
    const { app, part } = await partApp()
    const body = await (
      await app.request(`/part/${encodeURIComponent(part.pn)}/${encodeURIComponent(part.sn)}`)
    ).text()

    // A part holds no repository and signs nothing; the page has to say so
    // rather than dressing it up as a participant on the network.
    assert.match(body, /Not an account/)
    assert.match(body, /assembled by this observer/)
    assert.ok(!/follow/i.test(body), 'a part is not something you follow')
  })

  test('walks the history live and says the two agree', async () => {
    const { app, part } = await partApp()
    const body = await (
      await app.request(`/part/${encodeURIComponent(part.pn)}/${encodeURIComponent(part.sn)}`)
    ).text()

    assert.match(body, /This observer indexed/)
    assert.match(body, /The issuers&rsquo; servers say, just now/)
    assert.match(body, /The two agree/)
    assert.match(body, /consulted no database/)
    assert.ok(!body.includes('class="compare differ"'))
  })

  /**
   * The case the whole two-column arrangement exists for. A stale index is not
   * a hypothetical — it is the ordinary state of an AppView that missed a
   * firehose window — and a buyer has to be told which of the two answers is
   * evidence.
   */
  test('when the index disagrees with the network, it says the network wins', async () => {
    // An index that never saw the birth record: one visit stored, two live.
    const { net, birth, overhaul } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    index.setHandle(overhaul.uri.split('/')[2]!, `cascadia-mro.${DOMAIN}`)
    index.addRelease(
      releaseRow({
        uri: overhaul.uri,
        cid: String(overhaul.cid),
        bundle: overhaul.bundle,
        // The predecessor is referenced but was never indexed, which is what a
        // missed firehose window actually looks like — not a row that forgot
        // it had a parent.
        prev: { uri: birth.uri, cid: String(birth.cid) },
        observedAt: new Date('2026-02-01T00:00:00Z'),
      }),
    )
    const app = createApp({ resolver: net, repo: net, index, mode: 'live' })
    const pn = String(overhaul.bundle.values.partNumber)
    const sn = String(overhaul.bundle.values.serialNumber)

    const body = await (
      await app.request(`/part/${encodeURIComponent(pn)}/${encodeURIComponent(sn)}`)
    ).text()

    assert.match(body, /class="compare differ"/)
    assert.match(body, /They disagree/)
    // The stale side knows it is short: it holds a prev_cid whose row it never
    // saw, which is what a missed firehose window looks like.
    assert.match(body, /1 shop visit<\/b>,\s*stopping short of birth/)
    assert.match(body, /2 shop visits<\/b>,\s*reaching birth/)
    assert.match(body, /Nothing below is evidence;\s+the\s+live walk is/)
  })

  test('a part nobody has published is a 404 that does not overclaim', async () => {
    const { app } = await partApp()
    const res = await app.request('/part/NOSUCH/NOSUCH')
    assert.equal(res.status, 404)
    const body = await res.text()
    assert.match(body, /never seen a release certificate for this part/)
    // Absence from one observer is not absence from the network.
    assert.match(body, /not proof none exists/)
  })

  test('the work performed stays withheld on a part page', async () => {
    const { app, part } = await partApp()
    const body = await (
      await app.request(`/part/${encodeURIComponent(part.pn)}/${encodeURIComponent(part.sn)}`)
    ).text()
    for (const secret of ['Metering valve wear', 'R. Inspector']) {
      assert.ok(!body.includes(secret), `${secret} leaked onto the part page`)
    }
  })
})

describe('the viewpoint control', () => {
  const writerFor = async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })
    return { app, index, writer }
  }

  test('appears on every page, not only the feed', async () => {
    const { app } = await writerFor()
    for (const path of ['/', '/parts', '/verify', '/disclose', '/issue', '/accept']) {
      const body = await (await app.request(path)).text()
      assert.match(body, /action="\/act-as"/, `${path} has no account control`)
      assert.match(body, /The public/, `${path} cannot return to the public view`)
    }
  })

  /**
   * An application whose first screen has no identity and no composer is a
   * worse demonstration than one that starts somewhere. The public viewpoint
   * is the one that shows what the record actually discloses, so it stays one
   * click away rather than being the front door.
   */
  test('a first arrival lands signed in as a repair station', async () => {
    const { app } = await writerFor()
    const body = await (await app.request('/')).text()
    const mro = orgs(DOMAIN).find((o) => o.kind === 'mro')!
    assert.match(body, new RegExp(mro.displayName))
    assert.match(body, /class="newpost" data-compose/, 'no way to compose')
  })

  /**
   * There used to be two of these — one in the header and one on the page —
   * and only the header one took effect. Changing the page's dropdown and
   * pressing "generate" produced a form belonging to whoever was first in the
   * roster, which is how the bug was found.
   */
  test('there is exactly one of it per page', async () => {
    const { app } = await writerFor()
    const body = await (await app.request('/issue')).text()
    assert.equal(body.split('action="/act-as"').length - 1, 1)
  })

  test('watching as the public cannot sign', async () => {
    const { app } = await writerFor()
    const body = await (
      await app.request('/issue', { headers: { cookie: PUBLIC } })
    ).text()
    assert.match(body, /viewing as the public/)

    const res = await app.request('/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: PUBLIC },
      body: new URLSearchParams({ partNumber: 'P', serialNumber: 'S' }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /Choose an organization/)
  })

  /**
   * The composer fills its inputs by field name, and one of the seventeen is
   * called "item". Anything reaching for it through a form's element
   * collection gets that collection's own item() method instead, so the field
   * has to be in the payload for the browser-side fix to have something to
   * find.
   */
  test('the generated example carries every field, Block 6 included', async () => {
    const { app } = await writerFor()
    const form = (await (await app.request('/api/example')).json()) as Record<string, unknown>
    for (const spec of FIELDS) {
      assert.ok(spec.name in form, `no ${spec.name} (Block ${spec.block})`)
    }
  })

  test('the public is offered no example to generate either', async () => {
    const { app } = await writerFor()
    const res = await app.request('/api/example', { headers: { cookie: PUBLIC } })
    assert.equal(res.status, 403)
  })

  test('the public viewpoint cannot press the buttons that sign', async () => {
    const { app } = await writerFor()
    const body = await (
      await app.request('/issue', { headers: { cookie: PUBLIC } })
    ).text()
    assert.match(body, /name="example" value="1"\s*disabled/)
    assert.match(body, /<button type="submit" disabled>Sign and publish/)
  })

  /**
   * The date hint used to be interpolated as a fragment of markup, so its
   * quotes were escaped and the browser rendered an attribute whose name
   * contained the entities — the field displayed its own placeholder in
   * quotation marks.
   */
  test('the date hint is a placeholder rather than escaped markup', async () => {
    const { app } = await writerFor()
    const body = await (
      await app.request('/issue', { headers: { cookie: `f8130_actor=cascadia-mro.${DOMAIN}` } })
    ).text()
    assert.ok(!body.includes('&quot;2026'), 'the placeholder was escaped into the attribute name')
    assert.match(body, /placeholder="2026-04-01T12:00:00Z"/)
  })

  test('choosing an organization sets the cookie; the public is also a choice', async () => {
    const { app } = await writerFor()
    const pick = await app.request('/act-as', {
      method: 'post',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle: `cascadia-mro.${DOMAIN}` }),
    })
    assert.equal(pick.status, 303)
    assert.match(pick.headers.get('set-cookie') ?? '', /f8130_actor=cascadia-mro/)

    // Stored rather than cleared: with no cookie at all the next request
    // would sign straight back in as the default repair station.
    const out = await app.request('/act-as', {
      method: 'post',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle: '~public' }),
    })
    assert.match(out.headers.get('set-cookie') ?? '', /f8130_actor=~public/)
  })

  test('a cookie naming an unknown organization selects nothing', async () => {
    const { app } = await writerFor()
    const body = await (
      await app.request('/issue', { headers: { cookie: 'f8130_actor=attacker.example.com' } })
    ).text()
    assert.match(body, /viewing as the public/)
    assert.ok(!body.includes('attacker.example.com'))
  })

  test('the composer hangs off every page except the one that is the form', async () => {
    const { app } = await writerFor()
    const feed = await (await app.request('/')).text()
    assert.match(feed, /<dialog id="composer">/)

    // Two seventeen-block forms in one document would mean duplicate ids.
    const issue = await (await app.request('/issue')).text()
    assert.ok(!issue.includes('<dialog id="composer">'))
  })

  /**
   * The reported bug, exactly: pick an organization, press generate, and the
   * generated form must belong to that organization rather than to whoever
   * the cookie happens to name.
   */
  test('the generate button issues as the organization it can see', async () => {
    const { app } = await writerFor()
    const vantage = orgs(DOMAIN).find((o) => o.key === 'vantage')!
    const res = await app.request(
      `/issue?example=1&handle=${encodeURIComponent(vantage.handle)}`,
      // A cookie still naming someone else, which is the state the bug needed.
      { headers: { cookie: `f8130_actor=cascadia-mro.${DOMAIN}` } },
    )
    const body = await res.text()
    assert.ok(
      body.includes(`name="organizationName" value="${vantage.displayName}"`),
      'Block 4 did not name the organization the visitor chose',
    )
    assert.match(
      res.headers.get('set-cookie') ?? '',
      /f8130_actor=vantage-propulsion/,
      'the viewpoint control did not follow the choice',
    )
  })

  test('marks the events the viewing organization is party to', async () => {
    const { app, index } = await writerFor()
    index.setHandle('did:plc:issuer', `cascadia-mro.${DOMAIN}`)
    index.addRelease(release())

    const asIssuer = await (
      await app.request('/', { headers: { cookie: `f8130_actor=cascadia-mro.${DOMAIN}` } })
    ).text()
    assert.match(asIssuer, /class="mine"/)

    const asPublic = await (await app.request('/', { headers: { cookie: PUBLIC } })).text()
    assert.ok(!asPublic.includes('class="mine"'), 'the public is party to nothing')
  })
})

describe('the standing admonition', () => {
  test('appears once per page rather than three or four times', async () => {
    const { app } = await feedApp()
    for (const path of ['/', '/parts', '/verify', '/disclose']) {
      const body = await (await app.request(path)).text()
      assert.equal(
        body.split('class="marker"').length - 1,
        1,
        `${path} does not carry exactly one marker`,
      )
      assert.ok(!body.includes('class="banner"'), `${path} still stacks banners`)
    }
  })
})

describe('the live stream', () => {
  test('is an event stream, and tells the generator a viewer arrived', async () => {
    let joined = 0
    let left = 0
    const { net } = await demoNetwork(DOMAIN)
    const app = createApp({
      resolver: net,
      repo: net,
      index: new MemoryIndex(),
      mode: 'live',
      activity: { viewerJoined: () => joined++, viewerLeft: () => left++ },
    })

    const controller = new AbortController()
    const res = await app.request('/api/feed/stream', { signal: controller.signal })
    assert.equal(res.headers.get('content-type'), 'text/event-stream')

    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    assert.match(first, /: connected/)
    assert.equal(joined, 1)

    await reader.cancel()
    controller.abort()
    await new Promise((r) => setImmediate(r))
    assert.equal(left, 1, 'closing the tab must stop the generator')
  })

  test('is refused when there is no index to stream from', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const app = createApp({ resolver: net, repo: net, index: null, mode: 'live' })
    assert.equal((await app.request('/api/feed/stream')).status, 503)
  })
})

describe('the synthetic generator', () => {
  /** Records every write, and hands back plausible references. */
  function recorder() {
    const calls: any[] = []
    let n = 0
    const actors = demoActors(DOMAIN)
    const writer: RecordWriter = {
      actors: () => actors,
      createRelease: async (p) => {
        n++
        const out = {
          uri: `at://did:plc:iss${n}/dev.cldixon.f8130.release/3r${n}`,
          cid: `bafyrel${n}`,
          bundle: {} as any,
        }
        calls.push({ kind: 'release', ...p, ...out })
        return out
      },
      createAcceptance: async (p) => {
        n++
        const out = {
          uri: `at://did:plc:op${n}/dev.cldixon.f8130.acceptance/3a${n}`,
          cid: `bafyacc${n}`,
        }
        calls.push({ kind: 'acceptance', ...p, ...out })
        return out
      },
      createDispute: async (p) => {
        n++
        const out = {
          uri: `at://did:plc:iss${n}/dev.cldixon.f8130.dispute/3d${n}`,
          cid: `bafydis${n}`,
        }
        calls.push({ kind: 'dispute', ...p, ...out })
        return out
      },
    }
    return { writer, calls }
  }

  const gen = (rolls: number[], over: Partial<ConstructorParameters<typeof ActivityGenerator>[0]> = {}) => {
    const { writer, calls } = recorder()
    let i = 0
    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      now: () => 1_700_000_000_000,
      // Scripted, then an unremarkable 0.5 once the script runs out — a test
      // should have to spell out only the rolls it actually cares about.
      random: () => (i < rolls.length ? rolls[i++]! : 0.5),
      ...over,
    })
    return { g, calls, writer }
  }

  test('writes nothing until somebody is watching', () => {
    const { g } = gen([0.9])
    assert.equal(g.running, false)
    g.viewerJoined()
    assert.equal(g.running, true)
    g.viewerLeft()
    assert.equal(g.running, false, 'an unwatched demo must not accumulate history')
  })

  test('keeps running while any viewer remains', () => {
    const { g } = gen([0.9])
    g.viewerJoined()
    g.viewerJoined()
    g.viewerLeft()
    assert.equal(g.running, true)
    g.viewerLeft()
    assert.equal(g.running, false)
  })

  test('the first event is a release from a shop to an operator', async () => {
    const { g, calls } = gen([0.9])
    await g.tick()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].kind, 'release')

    const issuer = orgs(DOMAIN).find((o) => o.handle === calls[0].handle)!
    assert.ok(['mro', 'oem'].includes(issuer.kind), 'only shops and makers issue')
    // Block 4 is the issuer's own, which is the one thing on a form a shop
    // cannot plausibly get wrong about itself.
    assert.equal(calls[0].form.organizationName, issuer.displayName)
    assert.equal(calls[0].form.organizationAddress, issuer.address)
  })

  test('a release is later answered by the operator who received it', async () => {
    // Tick one: 0.9 issues, and the three rolls after it pick the parties and
    // the part. Tick two: 0.3 falls in the close-out band and 0.9 accepts.
    const { g, calls } = gen([0.9, 0.5, 0.5, 0.5, 0.3, 0.9])
    await g.tick()
    await g.tick()

    assert.equal(calls.length, 2)
    const [rel, acc] = calls
    assert.equal(acc.kind, 'acceptance')
    assert.equal(acc.subject.uri, rel.uri, 'the verdict must name the release it judges')
    assert.equal(acc.partNumber, rel.form.partNumber)

    // The verdict is published by the operator, not by the issuer: a receipt
    // the issuer could write is not a receipt.
    const verifier = orgs(DOMAIN).find((o) => o.handle === acc.handle)!
    assert.ok(['operator', 'lessor'].includes(verifier.kind))
    assert.notEqual(acc.handle, rel.handle)
  })

  test('a rejection carries a stated reason and can be answered', async () => {
    // Same shape as above, but 0.05 is under the rejection rate. The roll
    // after it picks the stated reason, and tick three then opens with 0.1 —
    // inside the band where an issuer may answer.
    const { g, calls } = gen([0.9, 0.5, 0.5, 0.5, 0.3, 0.05, 0.5, 0.1])
    await g.tick()
    await g.tick()
    const rejection = calls[1]
    assert.equal(rejection.outcome, 'rejected')
    assert.ok(rejection.note, 'a rejection with no stated reason is an accusation')

    await g.tick()
    const reply = calls[2]
    assert.equal(reply.kind, 'dispute')
    assert.equal(reply.subject.uri, rejection.uri)
    assert.equal(reply.handle, calls[0].handle, 'only the issuer may answer')
  })

  test('a write that fails is counted rather than thrown', async () => {
    const errors: unknown[] = []
    const { g } = gen([0.9], {
      writer: {
        actors: () => demoActors(DOMAIN),
        createRelease: async () => {
          throw new Error('the PDS said no')
        },
        createAcceptance: async () => ({ uri: '', cid: '' }),
        createDispute: async () => ({ uri: '', cid: '' }),
      },
      onError: (e) => errors.push(e),
    })
    await g.tick()
    assert.equal(g.stats.errors, 1)
    assert.equal(errors.length, 1)
  })

  test('what it writes reaches the feed through the ordinary path', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })

    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      now: () => 1_700_000_000_000,
      random: () => 0.9,
    })
    await g.tick()

    assert.equal(index.size.releases, 1)
    const body = await (await app.request('/')).text()
    assert.match(body, /issued a release certificate/)
    assert.match(body, /SYNTHETIC/)
  })
})
