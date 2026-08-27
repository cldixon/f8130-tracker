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

import {
  demoNetwork,
  orgs,
  FIELDS,
  type Narrator,
} from '@f8130/core'

import { ActivityGenerator } from '../src/activity.js'
import { createApp } from '../src/app.js'
import { Dock, type Arrival } from '../src/dock.js'
import { MemoryIndex, releaseRow } from '../src/memory-index.js'
import { MemoryRecordWriter, demoActors, type RecordWriter } from '../src/writer.js'
import type { AttestationRow, ReleaseRow } from '../src/index-port.js'
import { postPath } from '../src/views.js'

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

const attestation = (over: Partial<AttestationRow> = {}): AttestationRow => ({
  cid: 'bafyatt',
  uri: 'at://did:plc:operator/dev.cldixon.f8130.attestation/3b',
  subjectUri: 'at://did:plc:issuer/dev.cldixon.f8130.release/3a',
  subjectCid: 'bafyrel',
  verifierDid: 'did:plc:operator',
  issuerDid: 'did:plc:issuer',
  verifiedAt: new Date('2026-01-23T08:00:00Z'),
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
  test('interleaves releases and checks, newest observation first', async () => {
    const index = new MemoryIndex()
    index.addRelease(release({ cid: 'a', observedAt: new Date('2026-02-01T00:00:00Z') }))
    index.addAttestation(attestation({ cid: 'b', observedAt: new Date('2026-02-03T00:00:00Z') }))
    index.addRelease(release({ cid: 'c', observedAt: new Date('2026-02-02T00:00:00Z') }))

    const events = await index.feed({ limit: 10 })
    assert.deepEqual(
      events.map((e) => (e.kind === 'release' ? e.release.cid : e.attestation.cid)),
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
      fresh.map((e) => (e.kind === 'release' ? e.release.cid : e.attestation.cid)),
      ['after'],
    )

    // Exclusive, so re-polling with the newest timestamp cannot replay it.
    const again = await index.feed({ limit: 10, since: new Date('2026-02-05T00:00:00Z') })
    assert.equal(again.length, 0)
  })
})

describe('the feed page', () => {
  test('shows releases and the checks on them as one stream', async () => {
    const { app } = await feedApp((i) => {
      i.addRelease(release())
      i.addAttestation(attestation())
      // Profiles, the way a station record would have supplied them.
      i.setActor({ did: 'did:plc:operator', displayName: 'Example Air', kind: 'operator' })
      i.setActor({ did: 'did:plc:issuer', displayName: 'Cascadia MRO', kind: 'mro' })
    })
    const body = await (await app.request('/')).text()
    assert.match(body, /issued a release certificate/)
    assert.match(body, /accepted this certificate/)
    // This used to also assert /rejected/, which passed for six releases
    // after rejections were removed — it was matching a dead CSS rule in the
    // inlined stylesheet, not anything on the page. Nothing on the network
    // says a document failed, so there is no such card to look for.
    assert.ok(!body.includes('rejected'), 'the network carries no rejections')
    // An attestation carries no name for either party, so this reads properly
    // only if the observer indexed the station profile they published.
    assert.match(body, /Example Air/)
  })

  /**
   * Names are what people read. The DID is what is cryptographically
   * meaningful and also nine characters of base32 nobody reads, so it stays
   * available on hover and on the record's own page, and out of the sentence.
   */
  test('a byline is a name, with the DID only in reach', async () => {
    const { app } = await feedApp((i) => {
      i.addRelease(release())
      i.addAttestation(attestation())
      i.setActor({ did: 'did:plc:operator', displayName: 'Example Air', kind: 'operator' })
      i.setActor({ did: 'did:plc:issuer', displayName: 'Cascadia MRO', kind: 'mro' })
    })
    const body = await (await app.request('/')).text()

    assert.match(body, /title="did:plc:issuer">Cascadia MRO/)
    assert.match(body, /title="did:plc:operator">Example Air/)
    // Not rendered into the line itself any more.
    assert.ok(!body.includes('class="did"'), 'a DID is back in the content')
  })

  /**
   * An organization that has never published a profile has no name to show,
   * and inventing one would be worse than the identifier. This is the operator
   * that has only ever judged things.
   */
  test('an organization with no published profile renders as its DID', async () => {
    const { app } = await feedApp((i) => {
      i.addAttestation(attestation())
      i.setActor({ did: 'did:plc:issuer', displayName: 'Cascadia MRO', kind: 'mro' })
    })
    const body = await (await app.request('/')).text()
    assert.match(body, /Cascadia MRO/)
    assert.match(body, /did%3Aplc%3Aissuer|did:plc:operator/)
  })

  /**
   * A verdict is a record about another record, which is a quote rather than
   * a reply. It used to say "replying to X's release" above the card and "a
   * part from X" inside it — naming the same organization twice and still not
   * telling the reader what the part was.
   */
  test('a check quotes the release it covers instead of restating it', async () => {
    const { app } = await feedApp((i) => {
      i.addRelease(release())
      i.addAttestation(attestation())
      i.setActor({ did: 'did:plc:operator', displayName: 'Example Air', kind: 'operator' })
      i.setActor({ did: 'did:plc:issuer', displayName: 'Cascadia MRO', kind: 'mro' })
    })
    const body = await (await app.request('/')).text()

    // The quoted release carries what the verdict cannot: what the part is.
    assert.match(body, /class="quoted"/)
    assert.match(body, /Fuel control unit/)
    assert.match(body, /href="\/post\/did%3Aplc%3Aissuer\/3a"/)

    assert.ok(!body.includes('replying to'), 'the old reply line is still there')
    assert.ok(!/a part from/.test(body), 'the issuer is still named twice')

    // Scoped to the check's own card: the release has a card of its own and
    // naming the issuer there is not redundancy. Within one check, the issuer
    // should appear once, inside the quote.
    const card = body.slice(
      body.indexOf('data-cid="bafyatt"'),
      body.indexOf('</article>', body.indexOf('data-cid="bafyatt"')),
    )
    assert.ok(card.length > 0, 'no check card was rendered')
    assert.equal((card.match(/Cascadia MRO/g) ?? []).length, 1)
    assert.match(card, /class="quoted"/)
  })

  /**
   * An observer can see a verdict on a release it never saw. That is a fact
   * about this observer rather than an error, and the card says so instead of
   * rendering an empty quote.
   */
  test('a check on an unseen release says the release is unseen', async () => {
    const { app } = await feedApp((i) => {
      i.addAttestation(attestation())
      i.setActor({ did: 'did:plc:operator', displayName: 'Example Air', kind: 'operator' })
    })
    const body = await (await app.request('/')).text()
    assert.match(body, /has not seen the release itself/)
    // It still knows the part, because the verdict record carries it.
    assert.match(body, /has not seen the release itself/)
  })

  test('the withheld count is stated on the record, not on every card', async () => {
    const r = release()
    const { app } = await feedApp((i) => i.addRelease(r))

    // The claim still has to be made — the interesting thing is that the index
    // never held those blocks, not that it declined to render them. But it is
    // one fact about the design, not news about this particular part, and
    // repeating it under every card in an infinite feed turned it into
    // wallpaper. It belongs on the record it describes.
    const feed = await (await app.request('/')).text()
    assert.ok(!/blocks committed and withheld/.test(feed), 'boilerplate is back on the cards')

    const post = await (await app.request(postPath(r.uri))).text()
    assert.match(post, /8 of 17 blocks are withheld/)
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
  const threaded = () =>
    feedApp((i) => {
      i.addRelease(release())
      i.addAttestation(attestation())
      i.setActor({ did: 'did:plc:issuer', displayName: 'Cascadia MRO', kind: 'mro' })
      i.setActor({ did: 'did:plc:operator', displayName: 'Example Air', kind: 'operator' })
    })

  const PERMALINK = '/post/did:plc:issuer/3a'

  test('a release and everyone who has publicly checked it', async () => {
    const { app } = await threaded()
    const body = await (await app.request(PERMALINK)).text()

    assert.match(body, /Fuel control unit/)
    assert.match(body, /accepted this certificate/)

    // The order is the argument: the check sits under the release it covers,
    // in a repository the issuer does not control.
    assert.ok(
      body.indexOf('Fuel control unit') < body.indexOf('accepted this certificate'),
      'the check must come after the release it covers',
    )
  })

  /**
   * The whole reason the thread shape is worth borrowing. An issuer cannot
   * remove a verdict published against them, because it is a record in
   * somebody else's repository, and the page has to say so where the verdict
   * is rather than in a paragraph elsewhere.
   */
  test('says the check lives in its author\'s own repository', async () => {
    const { app } = await threaded()
    const body = await (await app.request(PERMALINK)).text()
    assert.match(body, /own\s+repository/)
    // Whitespace-insensitive: the sentence wraps in the markup.
    assert.match(body, /own\s+repository/)
  })

  /**
   * A checkmark would say this service vouches for the document. It does not
   * and cannot: it holds no bundle, so it cannot recompute the commitment. It
   * offers to run the checks and show them.
   */
  test('offers to run the checks rather than stamping a mark', async () => {
    const { app } = await threaded()
    const body = await (await app.request(PERMALINK)).text()
    assert.match(body, /Check a document you hold/)
    assert.ok(!/verified.{0,20}✓|✓.{0,20}verified/i.test(body), 'a badge crept in')
  })

  test('a release nobody has checked says so without implying a fault', async () => {
    const { app } = await feedApp((i) => i.addRelease(release()))
    const body = await (await app.request(PERMALINK)).text()
    assert.match(body, /Nobody has published a check on this release/)
  })

  test('the withheld blocks stay withheld in a thread', async () => {
    const { app } = await threaded()
    const body = await (await app.request(PERMALINK)).text()
    for (const secret of ['REPAIRED', 'Metering valve wear', 'R. Inspector']) {
      assert.ok(!body.includes(secret), `${secret} leaked into the thread`)
    }
    assert.match(body, /8 of 17 blocks are withheld/)
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
    assert.match(body, /holds no repository and signs nothing/)
    assert.match(body, /assembled from\s+records published independently/)
    // Scoped to the page's own content. Asserted over the whole document it
    // also reads the inlined stylesheet, where an unrelated comment using the
    // word would fail this for no reason — the same trap that let an earlier
    // test pass for six releases by matching a dead CSS rule.
    const main = body.slice(body.indexOf('<main>'), body.indexOf('</main>'))
    assert.ok(!/follow/i.test(main), 'a part is not something you follow')
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

/**
 * The values a draft arrived carrying, read back out of the rendered sheet.
 *
 * Scraped rather than fetched as data, deliberately. There is no data
 * endpoint behind the composer any more — it asks for the same markup the
 * page draws and drops it in — so a test that reads JSON from somewhere else
 * would be checking a generator nothing renders. Reading the sheet is what
 * the browser does, and it is the only thing that catches the form and the
 * field set drifting apart.
 */
const unentity = (v: string) =>
  v
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

async function draftValues(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<Record<string, string>> {
  const draft = await (
    await app.request('/issue?fragment', { headers: { cookie } })
  ).text()
  const values: Record<string, string> = {}
  for (const spec of FIELDS) {
    if (spec.kind === 'enum') {
      const m = /<option value="([^"]+)" selected>/.exec(
        draft.slice(draft.indexOf(`name="${spec.name}"`)),
      )
      assert.ok(m, `${spec.name} had no selected option`)
      values[spec.name] = unentity(m[1]!)
    } else if (spec.name === 'remarks') {
      const m = /name="remarks"[^>]*>([^<]*)<\/textarea>/.exec(draft)
      assert.ok(m, 'remarks had no value')
      values[spec.name] = unentity(m[1]!)
    } else {
      const m = new RegExp(`name="${spec.name}" value="([^"]*)"`).exec(draft)
      assert.ok(m, `${spec.name} had no value`)
      values[spec.name] = unentity(m[1]!)
    }
  }
  return values
}

/**
 * The composer, which is a dialog that fetches the same markup the page draws.
 *
 * Worth its own tests because nothing about the modal is visible to the
 * server: it asks for `/issue?fragment`, drops the answer in, and the only
 * thing keeping the two paths honest is that they call one function. If the
 * fragment ever comes back wrapped in a layout, or comes back without the
 * form, the dialog shows a page inside a page or an empty box — and neither
 * fails anywhere a page test would look.
 */
/**
 * The stream deals in two identities, and they are not interchangeable.
 *
 * A card is marked as yours by DID, because that is what a record carries. The
 * dock and the generator are keyed by handle, because that is what the roster
 * and the viewpoint cookie deal in. One variable served all three after the
 * DID change, and the two handle-shaped uses spent two releases answering
 * about an organization that does not exist — silently, because a dock asked
 * about an unknown key returns zero rather than failing.
 */
describe('who the stream says is watching', () => {
  test('the generator is told a handle, not a DID', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const seen: (string | undefined)[] = []
    const app = createApp({
      resolver: net, repo: net, index, writer, mode: 'live',
      activity: {
        viewerJoined: (h?: string) => seen.push(h),
        viewerLeft: () => {},
      } as any,
    })

    const ac = new AbortController()
    const res = await app.request('/api/feed/stream', {
      headers: { cookie: `f8130_actor=example-air.${DOMAIN}` },
      signal: ac.signal,
    })
    await res.body!.getReader().read()
    ac.abort()

    assert.equal(seen.length, 1, 'the generator was not told anybody arrived')
    assert.equal(
      seen[0], `example-air.${DOMAIN}`,
      'the generator was handed something that is not a handle',
    )
    assert.ok(!String(seen[0]).startsWith('did:'), 'a DID reached a handle-keyed API')
  })
})

describe('the composer fragment', () => {
  const ACTS = `f8130_actor=cascadia-mro.${DOMAIN}`

  const writerFor = async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })
    return { app, index }
  }

  test('is a body and not a page', async () => {
    const { app } = await writerFor()
    const body = await (
      await app.request('/issue?fragment', { headers: { cookie: ACTS } })
    ).text()
    assert.ok(!body.includes('<!doctype'), 'the fragment carried a whole document')
    assert.ok(!body.includes('<dialog id="composer">'), 'the dialog fetched itself')
    assert.match(body, /class="draftform"/)
  })

  /**
   * The dialog holds no template of its own, so a draft it cannot fill is a
   * draft nobody can submit. Every block has to arrive filled from the server.
   */
  test('arrives generated, with every block filled', async () => {
    const { app } = await writerFor()
    const body = await (
      await app.request('/issue?fragment', { headers: { cookie: ACTS } })
    ).text()
    for (const spec of FIELDS) {
      assert.ok(body.includes(`name="${spec.name}"`), `no ${spec.name} (Block ${spec.block})`)
      if (spec.kind === 'enum' || spec.name === 'remarks') continue
      assert.ok(
        !body.includes(`name="${spec.name}" value=""`),
        `${spec.name} arrived blank`,
      )
    }
  })

  test('signing through the fragment publishes and confirms in place', async () => {
    const { app, index } = await writerFor()
    const submitted = new URLSearchParams(await draftValues(app, ACTS))

    const res = await app.request('/issue?fragment', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTS },
      body: submitted,
    })
    assert.equal(res.status, 200)
    const done = await res.text()
    assert.ok(!done.includes('<!doctype'), 'the confirmation carried a whole document')
    assert.match(done, /Released/)
    assert.equal(index.size.releases, 1, 'the fragment path did not actually publish')

    // The bundle has to reach the browser here or nowhere: the dialog is the
    // only place it is ever handed over, and it cannot be reissued.
    assert.match(done, /id="out"/)
    assert.match(done, /cannot be reconstructed/)
  })

  /**
   * The confirmation is the argument, not a receipt. A visitor has just typed
   * seventeen blocks and this is where eight of them stop being readable by
   * anybody who was not handed the paper.
   */
  test('the confirmation shows which blocks the network kept', async () => {
    const { app } = await writerFor()
    const values = await draftValues(app, ACTS)
    const remarks = values.remarks!
    const submitted = new URLSearchParams(values)

    const done = await (
      await app.request('/issue?fragment', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTS },
        body: submitted,
      })
    ).text()

    const reveal = done.slice(done.indexOf('class="reveal"'), done.indexOf('class="seam"'))
    const rows = reveal.split('<div class="rev ').slice(1)
    assert.equal(rows.length, FIELDS.length, 'the reveal did not cover every block')
    for (const spec of FIELDS) {
      const row = rows.find((r) => r.includes(`Block ${spec.block} · `))
      assert.ok(row, `Block ${spec.block} (${spec.name}) is not in the reveal`)
      assert.equal(
        row.includes('withheld'),
        !spec.public,
        `Block ${spec.block} (${spec.name}) is on the wrong side of the reveal`,
      )
    }
    // And the withheld prose is genuinely absent, not merely labelled.
    assert.ok(remarks.length > 0)
    assert.ok(!reveal.includes(remarks), 'Block 12 was printed on the public side')
  })

  test('a rejected edit comes back as the draft with the reason on it', async () => {
    const { app, index } = await writerFor()
    const res = await app.request('/issue?fragment', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ACTS },
      body: new URLSearchParams({ partNumber: 'PN-EDITED', completedAt: 'yesterday' }),
    })
    assert.equal(res.status, 400)
    const body = await res.text()
    assert.ok(!body.includes('<!doctype'))
    assert.match(body, /Could not release/)
    // Starting over would throw away sixteen blocks to fix one.
    assert.match(body, /name="partNumber" value="PN-EDITED"/)
    assert.equal(index.size.releases, 0)
  })

  test('the public gets no fragment to fill either', async () => {
    const { app } = await writerFor()
    const body = await (
      await app.request('/issue?fragment', { headers: { cookie: 'f8130_actor=~public' } })
    ).text()
    assert.ok(!body.includes('class="draftform"'))
    assert.match(body, /The public cannot sign/)
  })
})

describe('the viewpoint control', () => {
  const writerFor = async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })
    return { app, index, writer, net }
  }

  test('appears on every page, not only the feed', async () => {
    const { app } = await writerFor()
    for (const path of ['/', '/parts', '/verify', '/disclose', '/issue']) {
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
    assert.match(body, /The public cannot sign/)

    const res = await app.request('/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: PUBLIC },
      body: new URLSearchParams({ partNumber: 'P', serialNumber: 'S' }),
    })
    assert.equal(res.status, 400)
    assert.match(await res.text(), /Choose an organization/)
  })

  /**
   * Disabling the buttons is not the guard any more, and a disabled button
   * never was one. A draft is generated for the acting organization, so with
   * nobody acting there is no draft and therefore nothing to submit — the
   * public is offered the picker instead of a form it cannot use.
   */
  test('the public viewpoint is offered no form at all', async () => {
    const { app } = await writerFor()
    const body = await (
      await app.request('/issue', { headers: { cookie: PUBLIC } })
    ).text()
    assert.ok(!body.includes('class="draftform"'), 'the public was handed a draft')
    assert.ok(!body.includes('name="partNumber"'), 'the public was handed blocks to fill')
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
    assert.match(body, /The public cannot sign/)
    assert.ok(!body.includes('attacker.example.com'))
  })

  test('the composer hangs off every page except the one that is the form', async () => {
    const { app } = await writerFor()
    const feed = await (await app.request('/')).text()
    assert.match(feed, /<dialog id="composer">/)

    // Except on /issue, where the page already is what the dialog fetches.
    const issue = await (await app.request('/issue')).text()
    assert.ok(!issue.includes('<dialog id="composer">'))
  })

  /**
   * The reported bug, exactly: pick an organization, open the composer, and
   * the generated form must belong to that organization rather than to
   * whoever the cookie happens to name.
   */
  test('the composer issues as the organization it can see', async () => {
    const { app } = await writerFor()
    const vantage = orgs(DOMAIN).find((o) => o.key === 'vantage')!
    const res = await app.request(
      `/issue?handle=${encodeURIComponent(vantage.handle)}`,
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

  /**
   * The viewpoint mark, against the organization's real DID.
   *
   * It used to plant a handle in the index and let the check compare handles.
   * That passed for months while the same code marked nothing whatsoever in
   * production, because the live index stores a DID in its handle column and a
   * handle never equals a DID. The check resolves the visitor's handle to a
   * DID now, so this names a release the resolver agrees belongs to them.
   */
  test('marks the events the viewing organization is party to', async () => {
    const cascadia = `cascadia-mro.${DOMAIN}`

    const mine = await writerFor()
    const did = await mine.net.resolveHandle(cascadia)
    assert.ok(did, 'the demo network could not resolve the acting organization')
    mine.index.addRelease(release({ issuerDid: did!, uri: `at://${did}/r/1` }))

    const asIssuer = await (
      await mine.app.request('/', { headers: { cookie: `f8130_actor=${cascadia}` } })
    ).text()
    assert.match(asIssuer, /class="mine"/)

    const asPublic = await (
      await mine.app.request('/', { headers: { cookie: PUBLIC } })
    ).text()
    assert.ok(!asPublic.includes('class="mine"'), 'the public is party to nothing')

    // The other half. A check that always returned true would pass everything
    // above and still be wrong.
    const theirs = await writerFor()
    theirs.index.addRelease(release({ issuerDid: 'did:plc:someoneelse' }))
    const asStranger = await (
      await theirs.app.request('/', { headers: { cookie: `f8130_actor=${cascadia}` } })
    ).text()
    assert.ok(!asStranger.includes('class="mine"'), "somebody else's release was marked")
  })
})

/**
 * The feed over an index shaped the way the live one actually is.
 *
 * Two bugs shipped and sat in production behind a green suite, and both had
 * the same cause: MemoryIndex is a more capable object than PostgresIndex.
 * The tests handed it real handles through setHandle and real display names
 * through setActor, so every lookup succeeded. The Go ingest writes neither —
 * it wrote the DID into the handle column and left org_name null until a
 * station record turned up — so in production the same code compared a handle
 * against a DID and rendered base32 where a name belonged.
 *
 * These build the index the way ingest does and assert on what a visitor sees.
 * A suite that only ever runs against the generous double cannot catch this
 * class of bug, and it has now missed it twice — the other time being the
 * timestamps that arrived as strings from one query and Dates from every
 * other.
 */
describe('the feed over a production-shaped index', () => {
  const DID = 'did:plc:cascadiamro00000000000'
  const OPERATOR = 'did:plc:exampleair000000000000'

  /**
   * What the Go ingest leaves behind for a repository it has seen publish,
   * before any station record has arrived: a row keyed by DID, carrying a
   * handle and nothing else.
   */
  async function liveShaped(opts: { handle?: string; name?: string } = {}) {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })

    // ensureActor's row. Without a resolved handle the column holds the DID,
    // which is exactly what shipped.
    index.setHandle(OPERATOR, opts.handle ?? OPERATOR)
    if (opts.name) index.setActor({ did: OPERATOR, displayName: opts.name, kind: 'operator' })

    index.addRelease(release({ issuerDid: DID, uri: `at://${DID}/r/1`, cid: 'bafyr1' }))
    index.addAttestation({
      cid: 'bafya1',
      uri: `at://${OPERATOR}/dev.cldixon.f8130.attestation/1`,
      subjectUri: `at://${DID}/r/1`,
      subjectCid: 'bafyr1',
      verifierDid: OPERATOR,
      issuerDid: DID,
      verifiedAt: new Date(),
      observedAt: new Date(),
    })
    return { app, index }
  }

  /**
   * Just the attestation card.
   *
   * Assertions have to be scoped to it. The account switcher lists every
   * organization on the roster, so a bare `body.includes(handle)` is true on
   * every page whatever the card says — which is how the first draft of these
   * tests passed against the very bug they were written for.
   */
  const card = (body: string) => {
    const at = body.indexOf('data-cid="bafya1"')
    assert.notEqual(at, -1, 'the attestation card did not render')
    const end = body.indexOf('</article>', at)
    return body.slice(at, end)
  }

  test('a station record still gives the receiver its display name', async () => {
    const { app } = await liveShaped({ handle: `example-air.${DOMAIN}`, name: 'Example Air' })
    const who = card(await (await app.request('/')).text())
    assert.match(who, /Example Air<\/strong> accepted this certificate/)
  })

  /**
   * The reported regression. A receiver whose station record this observer has
   * not indexed rendered as raw base32 in the middle of a sentence.
   *
   * A handle is the right thing to show instead: a domain its owner proved
   * control of, which is a name, unlike an identifier nobody reads.
   */
  test('without a station record the receiver falls back to its handle', async () => {
    const { app } = await liveShaped({ handle: `example-air.${DOMAIN}` })
    const who = card(await (await app.request('/')).text())
    assert.ok(
      who.includes(`example-air.${DOMAIN}`),
      `the receiver was not named by its handle: ${who.slice(0, 220)}`,
    )
  })

  /**
   * And the guard on the fallback. The index stores the DID in the handle
   * column when resolution failed, so a fallback that trusted it blindly
   * would swap a short DID for a long one and look identical to the bug.
   */
  test('a handle column holding a DID is not mistaken for a name', async () => {
    const { app } = await liveShaped()
    const who = card(await (await app.request('/')).text())
    assert.ok(!who.includes(`>${OPERATOR}<`), 'the full DID was rendered as a name')
    assert.match(who, /accepted this certificate/, 'the card did not render at all')
  })

  /**
   * The viewpoint mark, over the shape that broke it. The visitor's handle is
   * resolved to a DID and compared against the DID on the record, so nothing
   * here depends on the index knowing a handle.
   */
  test('a card is marked as yours even though the index knows no handles', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })

    const cascadia = `cascadia-mro.${DOMAIN}`
    const did = (await net.resolveHandle(cascadia))!
    assert.ok(did)
    // Every handle the index holds is a DID, as in production.
    index.setHandle(did, did)
    index.addRelease(release({ issuerDid: did, uri: `at://${did}/r/1` }))

    const body = await (
      await app.request('/', { headers: { cookie: `f8130_actor=${cascadia}` } })
    ).text()
    assert.match(body, /class="mine"/, 'the visitor\'s own release was not marked')
  })
})

describe('goods in', () => {
  async function dockApp() {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const dock = new Dock()
    const app = createApp({ resolver: net, repo: net, index, writer, dock, mode: 'live' })
    return { app, dock, writer, index, net }
  }

  const arrival = (over: Partial<Arrival> = {}): Arrival => ({
    subject: { uri: 'at://did:plc:issuer/dev.cldixon.f8130.release/3a', cid: 'bafyrel' },
    issuerDid: 'did:plc:issuer',
    issuerName: 'Cascadia MRO',
    partNumber: 'NT882104',
    serialNumber: 'SN000417',
    description: 'Fuel control unit',
    at: new Date('2026-02-01T00:00:00Z'),
    bundle: null,
    ...over,
  })

  const AS_OPERATOR = `f8130_actor=example-air.${DOMAIN}`

  test('shows only what was handed to the acting organization', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    dock.handOver(`southpoint-air.${DOMAIN}`, arrival({
      subject: { uri: 'at://did:plc:other/dev.cldixon.f8130.release/3z', cid: 'bafyz' },
      partNumber: 'ZZ-0001',
    }))

    const mine = await (
      await app.request('/inbox', { headers: { cookie: AS_OPERATOR } })
    ).text()
    assert.match(mine, /NT882104/)
    assert.ok(!mine.includes('ZZ-0001'), 'another operator\'s crate showed up')
  })

  test('the public receives nothing', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    const body = await (
      await app.request('/inbox', { headers: { cookie: PUBLIC } })
    ).text()
    assert.match(body, /watching as the public, which receives nothing/)
    assert.ok(!body.includes('NT882104'))
  })

  /**
   * The whole point of the page, end to end.
   *
   * A crate arrives with its paperwork, the recipient checks it without being
   * asked for a file, the check is the real pipeline, and a document that
   * holds up can be vouched for in public.
   */
  test('a real release can be checked from the inbox and attested', async () => {
    const { app, dock, writer, index } = await dockApp()

    // Issue a genuine release so there is something real to verify: the
    // pipeline resolves the issuer, fetches the repository and recomputes the
    // commitment, none of which a hand-written fixture would survive.
    // The integers arrive from the markup as strings, the same as they do
    // from a browser; /issue coerces them and this stands in for that.
    const drafted = await draftValues(app, `f8130_actor=cascadia-mro.${DOMAIN}`)
    const form: Record<string, unknown> = { ...drafted }
    for (const spec of FIELDS) {
      if (spec.kind === 'integer' && form[spec.name] !== undefined) {
        form[spec.name] = Number(form[spec.name])
      }
    }
    const issued = await writer.createRelease({
      handle: `cascadia-mro.${DOMAIN}`,
      form,
    })
    const values = issued.bundle.values as Record<string, string>

    dock.handOver(`example-air.${DOMAIN}`, {
      subject: { uri: issued.uri, cid: issued.cid },
      issuerDid: issued.uri.split('/')[2]!,
      issuerName: 'Cascadia MRO',
      partNumber: String(values.partNumber),
      serialNumber: String(values.serialNumber),
      description: String(values.description),
      at: new Date(),
      bundle: issued.bundle,
    })

    // No bundle in the request. The document is looked up from the dock.
    const checked = await app.request('/inbox/check', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: AS_OPERATOR },
      body: new URLSearchParams({ subjectUri: issued.uri }),
    })
    assert.equal(checked.status, 200)
    const report = await checked.text()
    assert.match(report, /Certificate verified/)
    assert.match(report, /Publish attestation/)

    const published = await app.request('/attest', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: AS_OPERATOR },
      body: new URLSearchParams({ subjectUri: issued.uri, subjectCid: issued.cid }),
    })
    assert.equal(published.status, 200)
    assert.match(await published.text(), /Published/)

    const [written] = await index.attestationsForSubjects([issued.cid])
    assert.ok(written, 'the attestation never reached the network')
    assert.equal(written.subjectUri, issued.uri)

    // And the crate stops waiting, rather than being attestable forever.
    assert.equal(dock.count(`example-air.${DOMAIN}`), 0)
  })

  /**
   * The rule this page sits closest to.
   *
   * A bundle opens every withheld block on its record. The service holds one
   * here on the recipient's behalf — their paper, their crate — and that is
   * only defensible while it reaches nobody else. These assert the two ways it
   * could get out: rendered to another organization, or answered to one.
   */
  test('a document is never rendered to an organization it was not sent to', async () => {
    const { app, dock } = await dockApp()
    // Markers rather than realistic values. What is asserted is that these
    // strings do not appear, so their content is irrelevant — and a literal
    // that looked like a real nonce would be sixty-four hex characters in a
    // variable called something like "secret", which is a private key to every
    // scanner that ever reads this repository. It would be flagged, correctly,
    // and the next person would have to prove it was nothing.
    const NONCE = 'NONCE-THAT-MUST-NEVER-LEAVE-THE-RECIPIENT'
    const WITHHELD = 'WITHHELD-BLOCK-12-PROSE'

    dock.handOver(`example-air.${DOMAIN}`, arrival({
      bundle: { synthetic: 'S', version: 1, uri: 'at://x', issuerHandle: 'x',
                values: { remarks: WITHHELD }, nonces: [NONCE] },
    }))

    for (const cookie of [`f8130_actor=southpoint-air.${DOMAIN}`, PUBLIC, AS_OPERATOR]) {
      const body = await (await app.request('/inbox', { headers: { cookie } })).text()
      assert.ok(!body.includes(NONCE), `a nonce was rendered for ${cookie}`)
      assert.ok(!body.includes(WITHHELD), `withheld prose rendered for ${cookie}`)
    }

    // Nor onto the public feed, which is the other page that lists releases.
    const feed = await (await app.request('/')).text()
    assert.ok(!feed.includes(NONCE), 'a nonce reached the feed')
  })

  test('another organization cannot check a document it was not sent', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())

    const res = await app.request('/inbox/check', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `f8130_actor=southpoint-air.${DOMAIN}`,
      },
      // The URI is not a secret — it is on the public feed. Holding it must
      // still not be enough to have the service open somebody else's document.
      body: new URLSearchParams({ subjectUri: arrival().subject.uri }),
    })
    assert.equal(res.status, 404)
  })

  test('the public cannot check anything', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    const res = await app.request('/inbox/check', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: PUBLIC },
      body: new URLSearchParams({ subjectUri: arrival().subject.uri }),
    })
    assert.equal(res.status, 403)
  })

  /**
   * A document that does not match, and what the screen may say about it.
   *
   * The corruption is applied to the bundle handed over, exactly as the
   * generator does it, so this exercises the real pipeline reaching a real
   * failure rather than a fixture asserting a rendered string.
   */
  test('a public block that disagrees is named, with both values', async () => {
    const { app, dock, writer } = await dockApp()
    const drafted = await draftValues(app, `f8130_actor=cascadia-mro.${DOMAIN}`)
    const form: Record<string, unknown> = { ...drafted }
    for (const spec of FIELDS) {
      if (spec.kind === 'integer' && form[spec.name] !== undefined) {
        form[spec.name] = Number(form[spec.name])
      }
    }
    const issued = await writer.createRelease({ handle: `cascadia-mro.${DOMAIN}`, form })
    const values = issued.bundle.values as Record<string, string>

    // Block 7 is public, so the record carries it in the clear.
    const wrong = {
      ...issued.bundle,
      values: { ...values, description: 'Something else entirely' },
    }
    dock.handOver(`example-air.${DOMAIN}`, {
      subject: { uri: issued.uri, cid: issued.cid },
      issuerDid: issued.uri.split('/')[2]!,
      issuerName: 'Cascadia MRO',
      partNumber: String(values.partNumber),
      serialNumber: String(values.serialNumber),
      description: String(values.description),
      at: new Date(),
      bundle: wrong,
    })

    const body = await (
      await app.request('/inbox/check', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: AS_OPERATOR },
        body: new URLSearchParams({ subjectUri: issued.uri }),
      })
    ).text()

    assert.match(body, /Form does not match/)
    assert.match(body, /can be shown/)
    assert.match(body, /Something else entirely/, 'the crate value was not shown')
    assert.match(body, new RegExp(values.description!), 'the published value was not shown')
    assert.ok(!body.includes('Publish attestation'), 'a failure offered to vouch')
  })

  /**
   * The case people find surprising, and the reason the wording matters.
   *
   * A withheld block is on the record only underneath the commitment, which is
   * one hash over all seventeen. It establishes that the document is not the
   * one published and does not decompose into which line changed.
   */
  test('a withheld block that disagrees cannot be named', async () => {
    const { app, dock, writer } = await dockApp()
    const drafted = await draftValues(app, `f8130_actor=cascadia-mro.${DOMAIN}`)
    const form: Record<string, unknown> = { ...drafted }
    for (const spec of FIELDS) {
      if (spec.kind === 'integer' && form[spec.name] !== undefined) {
        form[spec.name] = Number(form[spec.name])
      }
    }
    const issued = await writer.createRelease({ handle: `cascadia-mro.${DOMAIN}`, form })
    const values = issued.bundle.values as Record<string, string>

    const secretBefore = values.remarks!
    const wrong = {
      ...issued.bundle,
      values: { ...values, remarks: 'ALTERED FINDINGS' },
    }
    dock.handOver(`example-air.${DOMAIN}`, {
      subject: { uri: issued.uri, cid: issued.cid },
      issuerDid: issued.uri.split('/')[2]!,
      issuerName: 'Cascadia MRO',
      partNumber: String(values.partNumber),
      serialNumber: String(values.serialNumber),
      description: String(values.description),
      at: new Date(),
      bundle: wrong,
    })

    const body = await (
      await app.request('/inbox/check', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: AS_OPERATOR },
        body: new URLSearchParams({ subjectUri: issued.uri }),
      })
    ).text()

    assert.match(body, /Form does not match/)
    assert.match(body, /cannot say which line/)
    assert.ok(!body.includes('can be shown'), 'it claimed to be able to name the block')
    // And the observer genuinely does not have the published prose to compare
    // against: the record never carried it.
    assert.ok(!body.includes(secretBefore), 'withheld prose from the record leaked')
    assert.ok(!body.includes('Publish attestation'))
  })

  /**
   * An attestation says the author checked this and it held. Publishing one
   * without having just established that would be signing a statement on
   * trust — and nothing stopped a caller reaching this route without ever
   * running a check.
   */
  test('a document that does not verify cannot be attested to', async () => {
    const { app, dock, writer, index } = await dockApp()
    const drafted = await draftValues(app, `f8130_actor=cascadia-mro.${DOMAIN}`)
    const form: Record<string, unknown> = { ...drafted }
    for (const spec of FIELDS) {
      if (spec.kind === 'integer' && form[spec.name] !== undefined) {
        form[spec.name] = Number(form[spec.name])
      }
    }
    const issued = await writer.createRelease({ handle: `cascadia-mro.${DOMAIN}`, form })
    const values = issued.bundle.values as Record<string, string>

    dock.handOver(`example-air.${DOMAIN}`, {
      subject: { uri: issued.uri, cid: issued.cid },
      issuerDid: issued.uri.split('/')[2]!,
      issuerName: 'Cascadia MRO',
      partNumber: String(values.partNumber),
      serialNumber: String(values.serialNumber),
      description: String(values.description),
      at: new Date(),
      bundle: { ...issued.bundle, values: { ...values, remarks: 'ALTERED' } },
    })

    // Straight to publishing, without ever asking for a check.
    const res = await app.request('/attest', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: AS_OPERATOR },
      body: new URLSearchParams({ subjectUri: issued.uri, subjectCid: issued.cid }),
    })
    assert.equal(res.status, 409)
    assert.equal(index.size.attestations, 0, 'an unverified document was vouched for')
    assert.equal(dock.count(`example-air.${DOMAIN}`), 1, 'the crate was cleared anyway')
  })

  /** And the checks stay on the receipt, so the claim can be inspected. */
  test('the receipt keeps the verification that justified it', async () => {
    const { app, dock, writer } = await dockApp()
    const drafted = await draftValues(app, `f8130_actor=cascadia-mro.${DOMAIN}`)
    const form: Record<string, unknown> = { ...drafted }
    for (const spec of FIELDS) {
      if (spec.kind === 'integer' && form[spec.name] !== undefined) {
        form[spec.name] = Number(form[spec.name])
      }
    }
    const issued = await writer.createRelease({ handle: `cascadia-mro.${DOMAIN}`, form })
    const values = issued.bundle.values as Record<string, string>
    dock.handOver(`example-air.${DOMAIN}`, {
      subject: { uri: issued.uri, cid: issued.cid },
      issuerDid: issued.uri.split('/')[2]!,
      issuerName: 'Cascadia MRO',
      partNumber: String(values.partNumber),
      serialNumber: String(values.serialNumber),
      description: String(values.description),
      at: new Date(),
      bundle: issued.bundle,
    })

    const body = await (
      await app.request('/attest', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: AS_OPERATOR },
        body: new URLSearchParams({ subjectUri: issued.uri, subjectCid: issued.cid }),
      })
    ).text()

    assert.match(body, /Attestation published/)
    assert.match(body, /<summary>Verification<\/summary>/, 'the checks are not on the receipt')
    assert.equal((body.match(/class="stage/g) ?? []).length, 7, 'not every stage survived')
  })

  test('clearing takes the part off the list and publishes nothing', async () => {
    const { app, dock, index } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())

    const res = await app.request('/inbox/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: AS_OPERATOR },
      body: new URLSearchParams({ subjectUri: arrival().subject.uri }),
    })
    assert.equal(res.status, 303)
    assert.equal(dock.count(`example-air.${DOMAIN}`), 0)
    assert.equal(index.size.attestations, 0, 'declining wrote something to the network')
  })

  test('one organization cannot clear another\'s crate', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    await app.request('/inbox/clear', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `f8130_actor=southpoint-air.${DOMAIN}`,
      },
      body: new URLSearchParams({ subjectUri: arrival().subject.uri }),
    })
    assert.equal(dock.count(`example-air.${DOMAIN}`), 1, 'somebody else cleared it')
  })

  /**
   * The dialog and the page render the same markup.
   *
   * Kept honest the way the composer is: the fragment is the page's own body,
   * so a check cannot look like one thing in the modal and another on the
   * screen it degrades to when scripting is off.
   */
  test('the scan step is a body, not a page, when asked for a fragment', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival({
      bundle: { synthetic: 'S', version: 1, uri: 'at://x', issuerHandle: 'x',
                values: { description: 'Fuel control unit', remarks: 'Bench tested.' },
                nonces: [] },
    }))
    const uri = encodeURIComponent(arrival().subject.uri)

    const frag = await (
      await app.request(`/inbox/scan?uri=${uri}&fragment`, { headers: { cookie: AS_OPERATOR } })
    ).text()
    assert.ok(!frag.includes('<!doctype'), 'the fragment carried a whole document')
    assert.match(frag, /Received 8130 Certificate/)
    assert.match(frag, /Verify this document/)

    const page = await (
      await app.request(`/inbox/scan?uri=${uri}`, { headers: { cookie: AS_OPERATOR } })
    ).text()
    assert.match(page, /<!doctype/)
    assert.match(page, /Received 8130 Certificate/)
  })

  /**
   * The whole document, because it is the recipient's own.
   *
   * A withheld block is withheld from the network, not from the party the
   * crate was sent to — the paper in the box has all seventeen printed on it.
   * Showing less here would be modelling a restriction that does not exist.
   */
  test('the scan shows every block, including the withheld ones', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival({
      bundle: { synthetic: 'S', version: 1, uri: 'at://x', issuerHandle: 'x',
                values: { remarks: 'Bladder replaced per CMM 29-11-08.' }, nonces: [] },
    }))
    const body = await (
      await app.request(
        `/inbox/scan?uri=${encodeURIComponent(arrival().subject.uri)}&fragment`,
        { headers: { cookie: AS_OPERATOR } },
      )
    ).text()
    assert.match(body, /Bladder replaced per CMM 29-11-08/, 'Block 12 was hidden from its holder')
    assert.ok(!body.includes('>withheld<'), 'a block was marked withheld to its own recipient')
  })

  test('another organization cannot open a document it was not sent', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    const res = await app.request(
      `/inbox/scan?uri=${encodeURIComponent(arrival().subject.uri)}`,
      { headers: { cookie: `f8130_actor=southpoint-air.${DOMAIN}` } },
    )
    assert.equal(res.status, 404)
  })

  test('the public cannot open one at all', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    const res = await app.request(
      `/inbox/scan?uri=${encodeURIComponent(arrival().subject.uri)}`,
      { headers: { cookie: PUBLIC } },
    )
    assert.equal(res.status, 403)
  })

  /** The dead form this page carried for six releases. */
  test('offers no verdict form, which is a route that no longer exists', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    const body = await (
      await app.request('/inbox', { headers: { cookie: AS_OPERATOR } })
    ).text()

    assert.ok(!body.includes('action="/accept"'), 'still posts to a deleted route')
    for (const gone of ['Publish verdict', 'discrepancy', 'name="outcome"']) {
      assert.ok(!body.includes(gone), `${gone} outlived verdicts`)
    }
    assert.match(body, /Review the paperwork/)
  })

  test('the rail carries the count for the acting organization', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    dock.handOver(`example-air.${DOMAIN}`, arrival({
      subject: { uri: 'at://did:plc:issuer/dev.cldixon.f8130.release/3b', cid: 'bafy2' },
    }))
    const body = await (await app.request('/', { headers: { cookie: AS_OPERATOR } })).text()
    assert.match(body, /id="waiting"[^>]*>2</)
    assert.ok(!/id="waiting"[^>]*\shidden/.test(body), 'a real count was hidden')
  })

  /**
   * The badge is always in the markup, hidden at zero.
   *
   * The live stream writes into it, and a node that only exists once something
   * is waiting is a node the stream would have to create in the right place in
   * the rail — which is how a count ends up appended to the wrong nav item.
   */
  test('the badge is present but hidden when nothing is waiting', async () => {
    const { app } = await dockApp()
    const body = await (await app.request('/', { headers: { cookie: AS_OPERATOR } })).text()
    assert.match(body, /id="waiting"/)
    assert.match(body, /id="waiting"[^>]*\shidden/)
  })

  test('an answered part comes off the dock', async () => {
    const { dock } = await dockApp()
    const handle = `example-air.${DOMAIN}`
    dock.handOver(handle, arrival())
    assert.equal(dock.count(handle), 1)
    dock.settle('at://did:plc:issuer/dev.cldixon.f8130.release/3a')
    assert.equal(dock.count(handle), 0)
  })

  test('the same part handed over twice is one crate', async () => {
    const { dock } = await dockApp()
    const handle = `example-air.${DOMAIN}`
    dock.handOver(handle, arrival())
    dock.handOver(handle, arrival())
    assert.equal(dock.count(handle), 1)
  })

  test('the generator records who it handed each part to', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const dock = new Dock()
    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      dock,
      now: () => 1_700_000_000_000,
      random: () => 0.9,
    })
    await g.tick()

    // Exactly one organization is holding exactly one crate, and it is not
    // the factory. Asserted by what the roles mean rather than by listing the
    // kinds that may receive: that list has changed once and would have
    // silently pinned this test to the old model again.
    const holders = orgs(DOMAIN).filter((o) => dock.count(o.handle) > 0)
    assert.equal(holders.length, 1)
    assert.notEqual(holders[0]!.kind, 'oem', 'a manufacturer was sent a used part')
    assert.equal(dock.count(holders[0]!.handle), 1)
  })
})

describe('narrated forms reaching the wire', () => {
  const NARRATION = {
    description: 'Hydraulic reservoir assembly',
    remarks: 'Bladder degradation beyond limits. Bladder replaced per CMM 29-11-08.',
    signerName: 'T. Almeida',
  }
  const stub: Narrator = { narrate: async () => NARRATION }
  const MRO = `f8130_actor=cascadia-mro.${DOMAIN}`

  async function narratedApp(narrator: Narrator | null) {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, narrator, mode: 'live' })
    return { app, index, writer, net }
  }

  test('the composer offers a narrated draft', async () => {
    const { app } = await narratedApp(stub)
    const form = await draftValues(app, MRO)

    assert.equal(form.description, NARRATION.description)
    assert.equal(form.remarks, NARRATION.remarks)
    // Every block is still present — narration replaces prose, not structure.
    for (const spec of FIELDS) {
      assert.ok(spec.name in form, `no ${spec.name} (Block ${spec.block})`)
    }
  })

  /**
   * The identifiers a model is never allowed to author. Block 4 is the acting
   * organization's own and the part number is composed, so a narrator that
   * tried to supply either could not.
   */
  test('the identifiers still come from code, not from the narration', async () => {
    const { app } = await narratedApp(stub)
    const form = await draftValues(app, MRO)
    const org = orgs(DOMAIN).find((o) => o.kind === 'mro')!

    assert.equal(form.organizationName, org.displayName)
    assert.equal(form.organizationAddress, org.address)
    assert.match(String(form.partNumber), /^[A-Z]{2}-\d{4}-\d{2}$/)
    assert.match(String(form.formNumber), /^SYNTHETIC-8130-/)
  })

  test('a narrated form commits and publishes like any other', async () => {
    const { app, index } = await narratedApp(stub)
    const body = new URLSearchParams(await draftValues(app, MRO))

    const res = await app.request('/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: MRO },
      body,
    })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Released/)
    assert.equal(index.size.releases, 1)
  })

  /**
   * Block 12 is private, so narrated prose is committed and withheld exactly
   * like catalogue prose. A richer generator must not widen what the public
   * record discloses.
   */
  test('narrated remarks stay off the public record', async () => {
    const { app, index } = await narratedApp(stub)
    await app.request('/issue', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: MRO },
      body: new URLSearchParams(await draftValues(app, MRO)),
    })

    const feed = await (await app.request('/')).text()
    assert.ok(!feed.includes(NARRATION.remarks), 'narrated Block 12 leaked')
    assert.ok(!feed.includes(NARRATION.signerName), 'narrated Block 13d leaked')
    // Block 7 is public, so it does show.
    assert.match(feed, /Hydraulic reservoir assembly/)
  })

  test('no narrator means the catalogue, and a draft still arrives', async () => {
    const { app } = await narratedApp(null)
    const form = await draftValues(app, MRO)
    for (const spec of FIELDS) assert.ok(spec.name in form)
  })

  /**
   * A model that is down, slow or refusing must not be able to stop somebody
   * releasing a certificate. The catalogue answers instead and the visitor
   * cannot tell — which is the point, because both are a valid form.
   */
  test('a narrator that fails is invisible to the visitor', async () => {
    const { app } = await narratedApp({ narrate: async () => null })
    const form = await draftValues(app, MRO)
    for (const spec of FIELDS) assert.ok(spec.name in form)
  })
})

describe('the filing cabinet', () => {
  /**
   * The rule this page exists to respect: a bundle carries every nonce, so a
   * service that stored one could be compelled to hand over every withheld
   * block on the record. It must never hold one, not even helpfully.
   */
  test('is the browser, and the page says the server holds nothing', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const app = createApp({ resolver: net, repo: net, mode: 'live' })
    const body = await (await app.request('/cabinet')).text()

    assert.match(body, /not stored on this server/)
    assert.match(body, /not stored on this server/)
    // The list is empty markup; only a browser can fill it in.
    assert.match(body, /id="cabinet"/)
    assert.match(body, /Reading this browser/)
  })

  test('a record page offers to open itself with a bundle the browser holds', async () => {
    const { net, overhaul } = await demoNetwork(DOMAIN)
    const app = createApp({ resolver: net, repo: net, mode: 'live' })
    const body = await (
      await app.request(`/form?uri=${encodeURIComponent(overhaul.uri)}`)
    ).text()

    assert.match(body, /id="opener"/)
    assert.match(body, /id="openWith"/)
    // Nothing is pre-filled: the server has no bundle to pre-fill it with.
    assert.match(body, /<input type="hidden" name="bundle" value="">/)
  })
})

describe('the shape on a phone', () => {
  /**
   * Five nav links in a row measured 527px against a 390px viewport, so the
   * page scrolled sideways and every link wrapped its own text onto two
   * lines — which is also why the banner stopped short of the right edge.
   *
   * A rail is a desktop idea. These assert the markup a phone layout needs is
   * present; the widths themselves are checked by rendering, which a unit
   * test cannot do.
   */
  test('every nav entry carries a short label as well as a long one', async () => {
    const { app } = await feedApp((i) => i.addRelease(release()))
    const body = await (await app.request('/')).text()

    // A rail has room for a word a tab bar under a thumb does not.
    assert.match(body, /<span class="full">Documents<\/span><span class="tab">Docs<\/span>/)
    assert.match(body, /<span class="full">Issuers<\/span><span class="tab">Issuers<\/span>/)

    // Both are in the markup rather than one being derived, so a screen
    // reader gets a real label at either breakpoint.
    const full = (body.match(/class="full"/g) ?? []).length
    const tab = (body.match(/class="tab"/g) ?? []).length
    assert.equal(full, tab, 'every long label needs a short one')
  })

  test('checking a document is not offered as a thing that gets used up', async () => {
    const r = release()
    const { app } = await feedApp((i) => {
      i.addRelease(r)
      i.addAttestation(attestation({ subjectUri: r.uri, subjectCid: r.cid }))
    })
    const body = await (await app.request(postPath(r.uri))).text()

    // A release with a verdict on it still offers the check, and has to. The
    // two answer different questions: a verdict is a party's account of the
    // part they received, while checking asks whether a copy in someone's
    // hands still matches what was signed. A part accepted by one operator can
    // travel on with a forged certificate, so the check is never spent — and
    // the page says which is which, because sitting next to a list of verdicts
    // it reads as "add another one".
    assert.match(body, /Check a document you hold/)
    assert.match(body, /Checking compares a\s+copy you hold against this record/i)
  })

  test('a part is written the way the trade writes it', async () => {
    const { app } = await feedApp((i) => i.addRelease(release()))
    const body = await (await app.request('/')).text()

    // P/N and S/N, labelled. It used to be name · number · s/n number, which
    // is three strings and a punctuation mark rather than the plate every
    // form, purchase order and receiving inspection in the industry repeats.
    assert.match(body, /<dt>P\/N<\/dt>/)
    assert.match(body, /<dt>S\/N<\/dt>/)
    assert.ok(!/· s\/n <span class="mono">/.test(body), 'the run-on line is back')
  })

  test('the account switcher can be dismissed without choosing anything', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const app = createApp({
      resolver: net,
      repo: net,
      index,
      writer: new MemoryRecordWriter(net, index, demoActors(DOMAIN)),
    })
    const body = await (await app.request('/')).text()

    // `details` is the right markup and does not close on an outside click,
    // because nothing in its contract says it should. Every menu a visitor has
    // used does, so the gap reads as a bug rather than as a difference.
    assert.match(body, /details class="me"/)
    assert.match(body, /!me\.contains\(e\.target\)/)
    assert.match(body, /e\.key === 'Escape'/)
  })

  test('the compose button degrades to a symbol without losing its name', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })
    const body = await (await app.request('/')).text()

    // A circle has room for a plus and not for two words, but the control
    // still has to announce itself.
    assert.match(body, /aria-label="New release"/)
    assert.match(body, /<span class="tab">\+<\/span>/)
  })

  test('the phone layout is a breakpoint, not a second page', async () => {
    const { app } = await feedApp((i) => i.addRelease(release()))
    const body = await (await app.request('/')).text()
    // One nav, restyled — not a duplicate set of links for a screen size,
    // which would be two things to keep in step.
    assert.equal((body.match(/<nav>/g) ?? []).length, 1)
    assert.match(body, /@media \(max-width: 60rem\)/)
    assert.match(body, /position: fixed; left: 0; right: 0; bottom: 0/)
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

  /**
   * An open tab is a poor proxy for a watcher. The generator writes a real
   * record per event, so a page left in a background window overnight would
   * publish to a real repository with nobody reading a line of it.
   */
  test('the page closes the stream when hidden or idle', async () => {
    const { app } = await feedApp((i) => i.addRelease(release()))
    const body = await (await app.request('/')).text()

    assert.match(body, /visibilitychange/)
    assert.match(body, /IDLE_MS/)
    assert.match(body, /es\.close\(\)/)
    // And says which state it is in, because a still feed with no explanation
    // reads as broken rather than as paused.
    assert.match(body, /'paused'/)
    assert.match(body, /'idle'/)
  })

  test('a resumed stream picks up where the page left off', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    // Observed before the resume point: a fresh stream must not replay it.
    index.addRelease(release({ cid: 'old', observedAt: new Date('2026-01-01T00:00:00Z') }))
    const app = createApp({ resolver: net, repo: net, index, mode: 'live' })

    // Aborted rather than merely cancelled: the route's poll interval is
    // cleared on abort, and an interval left running holds the test process
    // open forever.
    const controller = new AbortController()
    const res = await app.request(
      `/api/feed/stream?since=${encodeURIComponent('2026-06-01T00:00:00Z')}`,
      { signal: controller.signal },
    )
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    await res.body!.cancel()
    controller.abort()
  })

  test('a malformed since is ignored rather than fatal', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const app = createApp({ resolver: net, repo: net, index: new MemoryIndex(), mode: 'live' })
    const controller = new AbortController()
    const res = await app.request('/api/feed/stream?since=not-a-date', {
      signal: controller.signal,
    })
    assert.equal(res.status, 200)
    await res.body!.cancel()
    controller.abort()
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
      createAttestation: async (p) => {
        n++
        const out = {
          uri: `at://did:plc:op${n}/dev.cldixon.f8130.attestation/3a${n}`,
          cid: `bafyatt${n}`,
        }
        calls.push({ kind: 'attestation', ...p, ...out })
        return out
      },
    }
    return { writer, calls }
  }

  /**
   * Something has to arrive for the person who is actually looking.
   *
   * With a dozen operators on the roster, a uniform pick means a visitor
   * sitting on the feed as one of them waits through eleven crates going
   * elsewhere before anything reaches their own goods-in. That reads as the
   * page being broken rather than as a supply chain being wide.
   */
  test('parts go to an organization somebody is watching as, more often than chance', async () => {
    const { writer } = recorder()
    const dock = new Dock(200)
    const watcher = demoActors(DOMAIN).find((a) => a.kind === 'operator')!

    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock,
      narrator: null,
      // Between ATTEST_ROLL (0.42) and WATCHED_SHARE (0.55): high enough that
      // every tick issues rather than attesting, low enough that the watched
      // organization is the one preferred.
      random: () => 0.5,
    })
    g.viewerJoined(watcher.handle)
    for (let i = 0; i < 8; i++) await g.tick()
    g.viewerLeft(watcher.handle)

    assert.ok(
      dock.count(watcher.handle) > 0,
      'nothing ever arrived for the organization being watched',
    )
  })

  /** And it stops being preferred the moment nobody is looking as them. */
  test('a viewpoint nobody holds any more is not favoured', async () => {
    const { writer } = recorder()
    const dock = new Dock(200)
    const watcher = demoActors(DOMAIN).find((a) => a.kind === 'operator')!

    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null, random: () => 0.5,
    })
    g.viewerJoined(watcher.handle)
    g.viewerLeft(watcher.handle)
    // Two joins and two leaves must not leave a phantom watcher behind.
    g.viewerJoined(watcher.handle)
    g.viewerJoined(watcher.handle)
    g.viewerLeft(watcher.handle)
    g.viewerLeft(watcher.handle)
    g.viewerJoined()

    const before = dock.count(watcher.handle)
    for (let i = 0; i < 6; i++) await g.tick()
    // Chance may still send one their way; what must not happen is the
    // generator still treating them as present.
    assert.ok(dock.count(watcher.handle) >= before)
  })

  /**
   * The crate and the paperwork travel together.
   *
   * Without this the recipient has something to inspect and no way to check
   * it, and the only way back is asking a visitor for a file nobody gave them.
   */
  test('a part is handed over with the document that came in the crate', async () => {
    const { writer } = recorder()
    const dock = new Dock(200)
    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null, random: () => 0.5,
    })
    g.viewerJoined()
    await g.tick()

    const landed = demoActors(DOMAIN)
      .flatMap((a) => dock.awaiting(a.handle))
    assert.ok(landed.length > 0, 'nothing was handed over at all')
    for (const a of landed) {
      assert.notEqual(a.bundle, undefined, `${a.partNumber} arrived with no paperwork`)
    }
  })

  /**
   * The bug that made the front door lead to an empty page.
   *
   * Recipients used to be operators and lessors only, so a repair station —
   * which is what a fresh visit arrives as — could never be sent anything. No
   * amount of waiting would have produced a notification, because there was no
   * arrangement under which one could arrive.
   */
  test('a repair station can be sent a part', async () => {
    const { writer } = recorder()
    const dock = new Dock(500)
    const shop = demoActors(DOMAIN).find((a) => a.kind === 'mro')!

    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null, random: () => 0.5,
    })
    g.viewerJoined(shop.handle)
    for (let i = 0; i < 8; i++) await g.tick()

    assert.ok(
      dock.count(shop.handle) > 0,
      'a repair station watching the feed was never sent anything',
    )
  })

  /**
   * A manufacturer is the exception, and stays one.
   *
   * An OEM certifies new manufacture under Block 13; a used part arriving at
   * the factory is a different story than this one tells.
   */
  test('a manufacturer is never sent a part', async () => {
    const { writer, calls } = recorder()
    const dock = new Dock(500)
    const oems = demoActors(DOMAIN).filter((a) => a.kind === 'oem')
    assert.ok(oems.length > 0, 'the roster has no manufacturers to check')

    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null, random: () => 0.5,
    })
    g.viewerJoined(oems[0]!.handle)
    for (let i = 0; i < 12; i++) await g.tick()

    for (const oem of oems) {
      assert.equal(dock.count(oem.handle), 0, `${oem.displayName} was sent a part`)
    }
    assert.ok(calls.length > 0, 'nothing was issued at all, so this proved nothing')
  })

  /**
   * A release is a handover. A document saying a station released a part to
   * itself describes nothing, and with shops now in the recipient pool it is
   * a thing the picker could otherwise produce.
   */
  test('a station is never handed the part it just signed', async () => {
    const { writer, calls } = recorder()
    const dock = new Dock(500)
    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null, random: () => 0.5,
    })
    g.viewerJoined()
    for (let i = 0; i < 12; i++) await g.tick()

    const issuedBy = new Map<string, string>()
    for (const c of calls) {
      if (c.kind === 'release') issuedBy.set(c.uri, c.handle)
    }
    let checked = 0
    for (const a of demoActors(DOMAIN)) {
      for (const arrival of dock.awaiting(a.handle)) {
        const signer = issuedBy.get(arrival.subject.uri)
        if (!signer) continue
        checked++
        assert.notEqual(signer, a.handle, `${a.handle} was handed its own release`)
      }
    }
    assert.ok(checked > 0, 'no handover was actually inspected')
  })

  /**
   * The wait this exists to remove.
   *
   * Left to the ordinary cadence, a release lands every twelve to forty-five
   * seconds, some ticks publish a check instead, and most crates go to one of
   * the other two dozen organizations. The expected wait before anything
   * reaches a particular inbox is about a minute and a half with a long tail —
   * long enough that a visitor concludes the page is broken rather than quiet.
   */
  test('somebody who arrives to an empty list gets the very next release', async () => {
    const { writer } = recorder()
    const dock = new Dock(200)
    const shop = demoActors(DOMAIN).find((a) => a.kind === 'mro')!

    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null,
      // Above WATCHED_SHARE and above ATTEST_ROLL, so neither the watcher bias
      // nor the release-rather-than-check roll can be what makes this pass.
      random: () => 0.99,
    })
    g.viewerJoined(shop.handle)
    await g.tick()

    assert.equal(
      dock.count(shop.handle), 1,
      'the first release after arriving went somewhere else',
    )
  })

  /** And only the first: after that the ordinary rate is the honest one. */
  test('the promise is kept once, not on every release', async () => {
    const { writer } = recorder()
    const dock = new Dock(200)
    const shop = demoActors(DOMAIN).find((a) => a.kind === 'mro')!

    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null, random: () => 0.99,
    })
    g.viewerJoined(shop.handle)
    for (let i = 0; i < 6; i++) await g.tick()

    assert.equal(
      dock.count(shop.handle), 1,
      'every release was steered to the visitor, which is not a network',
    )
  })

  /** Somebody who already has something waiting is owed nothing. */
  test('an arrival with a crate already waiting is not given another', async () => {
    const { writer } = recorder()
    const dock = new Dock(200)
    const shop = demoActors(DOMAIN).find((a) => a.kind === 'mro')!

    dock.handOver(shop.handle, {
      subject: { uri: 'at://did:plc:x/dev.cldixon.f8130.release/3z', cid: 'bafyz' },
      issuerDid: 'did:plc:x', issuerName: 'Somebody', partNumber: 'P', serialNumber: 'S',
      description: 'D', at: new Date(), bundle: null,
    })

    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null, random: () => 0.99,
    })
    g.viewerJoined(shop.handle)
    await g.tick()

    assert.equal(dock.count(shop.handle), 1, 'a second crate was forced on them')
  })

  /**
   * The promise cannot be kept by handing somebody their own release, so being
   * owed one takes a station out of the running to sign it.
   */
  test('a station owed a crate does not sign it itself', async () => {
    const { writer, calls } = recorder()
    const dock = new Dock(200)
    const shop = demoActors(DOMAIN).find((a) => a.kind === 'mro')!

    const g = new ActivityGenerator({
      writer, domain: DOMAIN, dock, narrator: null, random: () => 0.99,
    })
    g.viewerJoined(shop.handle)
    await g.tick()

    const [arrival] = dock.awaiting(shop.handle)
    assert.ok(arrival, 'nothing arrived')
    const release = calls.find((c) => c.kind === 'release' && c.uri === arrival.subject.uri)
    assert.ok(release, 'the arrival matches no release')
    assert.notEqual(release.handle, shop.handle, 'it signed its own crate')
  })

  /**
   * A constant die, which is position-independent.
   *
   * Scripted roll arrays pinned the exact order the generator consumes
   * randomness in, so adding one roll anywhere broke six tests that cared
   * about none of it. A constant picks the same branch however many times it
   * is asked:
   *
   *   0.9   never below any band  -> every tick issues
   *   0.05  below every band      -> issue, then verdict (rejected), then
   *                                 dispute, because each branch only opens
   *                                 once its queue is non-empty
   */
  const ALWAYS_ISSUE = () => 0.9
  const WALK_THE_THREAD = () => 0.05

  const gen = (rolls: number[], over: Partial<ConstructorParameters<typeof ActivityGenerator>[0]> = {}) => {
    const { writer, calls } = recorder()
    let i = 0
    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      now: () => 1_700_000_000_000,
      // Off unless a test asks for it. The backlog is history, and a test
      // about one tick should not have thirty-four writes in front of it.
      backlogSize: 0,
      // Scripted, then an unremarkable 0.5 once the script runs out — a test
      // should have to spell out only the rolls it actually cares about.
      random: () => (i < rolls.length ? rolls[i++]! : 0.5),
      ...over,
    })
    return { g, calls, writer }
  }

  test('a public check is dated from the release, not from the clock', async () => {
    const NOW = 1_700_000_000_000
    const { writer, calls } = recorder()
    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      now: () => NOW,
      random: WALK_THE_THREAD,
      backlogSize: 4,
      backlogDays: 20,
    })

    g.viewerJoined()
    await new Promise((r) => setTimeout(r, 50))
    g.viewerLeft()

    const releases = calls.filter((c) => c.kind === 'release')
    const checks = calls.filter((c) => c.kind === 'attestation')
    assert.ok(releases.length >= 4, 'the backlog was not written')
    assert.ok(checks.length >= 1, 'nothing was checked')

    // The part shipped. A verdict published now describes an arrival that
    // happened a transit time after the certificate was signed — which is the
    // gap that was missing when both records were simply dated "now" and the
    // feed showed a release and its verdict as the same moment.
    for (const v of checks) {
      const subject = releases.find((r) => r.uri === v.subject.uri)
      assert.ok(subject, 'a verdict on a release nobody issued')
      const signed = new Date(String(subject.form.completedAt)).getTime()
      const checked = v.verifiedAt.getTime()
      assert.ok(checked > signed, 'checked before it was signed')
      assert.ok(checked <= NOW, 'checked in the future')
      const days = (checked - signed) / 86_400_000
      assert.ok(days >= 2, `transit of ${days.toFixed(1)}d is not a shipment`)
    }
  })

  test('the backlog is written oldest first, so the column stays monotonic', async () => {
    const { writer, calls } = recorder()
    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      now: () => 1_700_000_000_000,
      random: ALWAYS_ISSUE,
      backlogSize: 8,
      backlogDays: 20,
    })

    g.viewerJoined()
    await new Promise((r) => setTimeout(r, 50))
    g.viewerLeft()

    // The feed orders on the observer's clock and these all arrive within a
    // second of each other, so write order is display order. Writing oldest
    // first is what makes that order agree with the dates on the paper.
    const dates = calls
      .filter((c) => c.kind === 'release')
      .map((c) => new Date(String(c.form.completedAt)).getTime())
    assert.ok(dates.length >= 8)
    for (let i = 1; i < dates.length; i++) {
      assert.ok(dates[i]! >= dates[i - 1]!, `entry ${i} is older than the one before it`)
    }
  })

  test('a check is about a part that has actually been in transit', async () => {
    const NOW = 1_700_000_000_000
    const { writer, calls } = recorder()
    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      now: () => NOW,
      random: WALK_THE_THREAD,
      backlogSize: 8,
      backlogDays: 20,
    })

    g.viewerJoined()
    await new Promise((r) => setTimeout(r, 60))
    g.viewerLeft()

    // The queue is a queue: the oldest waiting part is checked first, so while
    // aged stock is there a check is never about the release from the tick
    // before. The guarantee is only as deep as the stock — a session long
    // enough to work through it starts checking parts released earlier in that
    // same session, where the gap is minutes. That limit is real and is why
    // this pins the seeded window rather than an unbounded run.
    const byUri = new Map(calls.filter((c) => c.kind === 'release').map((c) => [c.uri, c]))
    const checks = calls.filter((c) => c.kind === 'attestation')
    assert.ok(checks.length >= 2, 'nothing was checked')

    for (const v of checks) {
      const subject = byUri.get(v.subject.uri)!
      const signed = new Date(String(subject.form.completedAt)).getTime()
      const ageDays = (NOW - signed) / 86_400_000
      assert.ok(ageDays >= 2, `checked a part signed ${ageDays.toFixed(2)}d ago`)
    }
  })

  test('writes nothing until somebody is watching', () => {
    const { g } = gen([], { random: ALWAYS_ISSUE })
    assert.equal(g.running, false)
    g.viewerJoined()
    assert.equal(g.running, true)
    g.viewerLeft()
    assert.equal(g.running, false, 'an unwatched demo must not accumulate history')
  })

  test('keeps running while any viewer remains', () => {
    const { g } = gen([], { random: ALWAYS_ISSUE })
    g.viewerJoined()
    g.viewerJoined()
    g.viewerLeft()
    assert.equal(g.running, true)
    g.viewerLeft()
    assert.equal(g.running, false)
  })

  test('the first event is a release from a shop to an operator', async () => {
    const { g, calls } = gen([], { random: ALWAYS_ISSUE })
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

  test('a release is later checked by whoever received it, never by its issuer', async () => {
    const { g, calls } = gen([], { random: WALK_THE_THREAD })
    await g.tick()
    await g.tick()

    assert.equal(calls.length, 2)
    const [rel, att] = calls
    assert.equal(att.kind, 'attestation')
    assert.equal(att.subject.uri, rel.uri, 'the check must name the release it covers')

    // The property that matters, stated as itself: a receipt the issuer could
    // write is not a receipt. It used to be checked by asserting the verifier's
    // kind, which tested the roster's shape rather than the claim — and broke
    // the moment repair stations could receive parts, without the claim having
    // changed at all.
    assert.notEqual(att.handle, rel.handle, 'the issuer vouched for itself')
    assert.ok(
      orgs(DOMAIN).some((o) => o.handle === att.handle),
      'the check came from somebody not on the roster',
    )
    assert.notEqual(att.handle, rel.handle)
  })

  /**
   * Every generated release used to be a birth, so a part page built from
   * live activity always showed one shop visit and the back-to-birth view had
   * nothing to trace.
   */
  /**
   * Driven by a seeded generator over many ticks rather than a scripted roll
   * array, because what matters is the property and not the arithmetic. A
   * scripted array pins the exact order randomness is consumed in, which is
   * implementation detail and broke every time a roll was added.
   */
  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  test('a part comes back in for more work, and the chain says so', async () => {
    const { writer, calls } = recorder()
    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      now: () => 1_700_000_000_000,
      random: mulberry(7),
    })
    for (let n = 0; n < 40; n++) await g.tick()

    const releases = calls.filter((c: any) => c.kind === 'release')
    const continued = releases.filter((c: any) => c.prev)
    assert.ok(continued.length > 0, 'no release ever continued a part')

    // A component does not change its name or its number between visits.
    for (const c of continued) {
      const parent = releases.find((r: any) => r.uri === c.prev.uri)
      assert.ok(parent, 'a continuation points at a release that was never made')
      assert.equal(c.form.partNumber, parent.form.partNumber)
      assert.equal(c.form.serialNumber, parent.form.serialNumber)
      assert.equal(c.form.description, parent.form.description)
      // But it is a new record, not the old one restated. Form numbers are a
      // hash of the seed modulo a thousand, so two visits colliding on one is
      // expected rather than a fault — asserting they differ was a test that
      // happened to pass.
      assert.notEqual(c.uri, parent.uri)
    }
  })

  test('a manufacturer never continues somebody else\'s part', async () => {
    const { writer, calls } = recorder()
    const g = new ActivityGenerator({
      writer,
      domain: DOMAIN,
      now: () => 1_700_000_000_000,
      // Always continue, if the issuer is eligible.
      random: () => 0.01,
    })
    for (let n = 0; n < 6; n++) await g.tick()

    // New manufacture is certified under Block 13, and a part already
    // released is not new. So no OEM release may carry a prev.
    for (const c of calls.filter((x) => x.kind === 'release')) {
      const org = orgs(DOMAIN).find((o) => o.handle === c.handle)!
      if (org.kind === 'oem') assert.ok(!c.prev, 'an OEM continued a part')
    }
  })

  test('a write that fails is counted rather than thrown', async () => {
    const errors: unknown[] = []
    const { g } = gen([], {
      random: ALWAYS_ISSUE,
      writer: {
        actors: () => demoActors(DOMAIN),
        createRelease: async () => {
          throw new Error('the PDS said no')
        },
        createAttestation: async () => ({ uri: '', cid: '' }),
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
    assert.match(body, /synthetic data/)
  })
})

describe('publishing a check', () => {
  const attestApp = async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })
    return { app, index, writer }
  }

  test('only an organization can publish one', async () => {
    const { app } = await attestApp()
    const res = await app.request('/attest', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: PUBLIC },
      body: new URLSearchParams({ subjectUri: 'at://x/y/z', subjectCid: 'bafy' }),
    })
    assert.equal(res.status, 403)
  })

  test('an attestation with no subject is refused', async () => {
    const { app } = await attestApp()
    const res = await app.request('/attest', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'f8130_actor=example-air.f8130.cldixon.dev',
      },
      body: new URLSearchParams({ subjectUri: '', subjectCid: '' }),
    })
    assert.equal(res.status, 400)
  })

  test('it lands in the acting organization repo, not the issuer\'s', async () => {
    const { app, index, writer } = await attestApp()
    const cast = orgs(DOMAIN)
    const mro = cast.find((o) => o.kind === 'mro')!
    const op = cast.find((o) => o.kind === 'operator')!
    const { syntheticForm } = await import('@f8130/core')
    const rel = await writer.createRelease({
      handle: mro.handle,
      form: syntheticForm({ org: mro, seed: 3 }),
    })

    const res = await app.request('/attest', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `f8130_actor=${op.handle}`,
      },
      body: new URLSearchParams({ subjectUri: rel.uri, subjectCid: rel.cid }),
    })
    assert.equal(res.status, 200)

    // Who vouched comes from the session, never from the request, so a caller
    // cannot attest as somebody else.
    const [written] = await index.attestationsForSubjects([rel.cid])
    assert.ok(written, 'nothing was indexed')
    const issuerDid = rel.uri.split('/')[2]
    assert.notEqual(written.verifierDid, issuerDid, 'the issuer vouched for itself')
    assert.equal(written.subjectUri, rel.uri)
  })
})

describe('a certificate signed by hand', () => {
  test('claims today, so the feed shows it as just happened', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })
    const mro = orgs(DOMAIN).find((o) => o.kind === 'mro')!

    const form = await draftValues(app, `f8130_actor=${mro.handle}`)

    // A feed card shows the date on the certificate rather than the moment
    // the record arrived, so a form generated for somebody to sign now has to
    // claim now. Left to the catalogue's default it lands anywhere in the last
    // ninety days, and a release published by hand appeared in the feed
    // seventeen days old.
    //
    // There used to be two prefill paths and the same omission in both; the
    // scripted one now fetches this very markup, so there is one thing to get
    // right and one test standing over it.
    const claimed = new Date(String(form.completedAt)).getTime()
    const ageDays = (Date.now() - claimed) / 86_400_000
    assert.ok(ageDays < 1, `a form to be signed now claims ${ageDays.toFixed(1)}d ago`)
    assert.ok(claimed <= Date.now(), 'a certificate cannot be signed in the future')
  })
})
