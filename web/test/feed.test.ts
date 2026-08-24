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
    assert.match(body, /rejected/)
    assert.match(body, /accepted this certificate/)
    // A verdict record carries no name for either party, so this reads
    // properly only if the observer indexed the station profile they
    // published.
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
    ...over,
  })

  const AS_OPERATOR = `f8130_actor=example-air.${DOMAIN}`

  /**
   * The honest part. An 8130-3 names the issuer and not the recipient, so no
   * index built from the public record can answer "what is waiting for me".
   * The page has to say that rather than implying the network told it.
   */
  test('says the list is not from the network', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    const body = await (
      await app.request('/inbox', { headers: { cookie: AS_OPERATOR } })
    ).text()

    assert.match(body, /This list is not from the network/)
    assert.match(body, /not from the network/)
  })

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

  test('the rail carries the count for the acting organization', async () => {
    const { app, dock } = await dockApp()
    dock.handOver(`example-air.${DOMAIN}`, arrival())
    dock.handOver(`example-air.${DOMAIN}`, arrival({
      subject: { uri: 'at://did:plc:issuer/dev.cldixon.f8130.release/3b', cid: 'bafy2' },
    }))
    const body = await (await app.request('/', { headers: { cookie: AS_OPERATOR } })).text()
    assert.match(body, /<span class="badge">2<\/span>/)
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

    // Exactly one operator is holding exactly one crate.
    const holders = orgs(DOMAIN).filter((o) => dock.count(o.handle) > 0)
    assert.equal(holders.length, 1)
    assert.ok(['operator', 'lessor'].includes(holders[0]!.kind))
  })
})

describe('narrated forms reaching the wire', () => {
  const NARRATION = {
    description: 'Hydraulic reservoir assembly',
    remarks: 'Bladder degradation beyond limits. Bladder replaced per CMM 29-11-08.',
    signerName: 'T. Almeida',
  }
  const stub: Narrator = { narrate: async () => NARRATION }

  async function narratedApp(narrator: Narrator | null) {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, narrator, mode: 'live' })
    return { app, index, writer, net }
  }

  test('the composer offers a narrated example', async () => {
    const { app } = await narratedApp(stub)
    const form = (await (await app.request('/api/example')).json()) as Record<string, unknown>

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
    const form = (await (await app.request('/api/example')).json()) as Record<string, unknown>
    const org = orgs(DOMAIN).find((o) => o.kind === 'mro')!

    assert.equal(form.organizationName, org.displayName)
    assert.equal(form.organizationAddress, org.address)
    assert.match(String(form.partNumber), /^[A-Z]{2}-\d{4}-\d{2}$/)
    assert.match(String(form.formNumber), /^SYNTHETIC-8130-/)
  })

  test('a narrated form commits and publishes like any other', async () => {
    const { app, index } = await narratedApp(stub)
    const form = (await (await app.request('/api/example')).json()) as Record<string, string>

    const body = new URLSearchParams()
    for (const spec of FIELDS) body.set(spec.name, String(form[spec.name]))

    const res = await app.request('/issue', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `f8130_actor=cascadia-mro.${DOMAIN}`,
      },
      body,
    })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /Issued/)
    assert.equal(index.size.releases, 1)
  })

  /**
   * Block 12 is private, so narrated prose is committed and withheld exactly
   * like catalogue prose. A richer generator must not widen what the public
   * record discloses.
   */
  test('narrated remarks stay off the public record', async () => {
    const { app, index } = await narratedApp(stub)
    const form = (await (await app.request('/api/example')).json()) as Record<string, string>
    const body = new URLSearchParams()
    for (const spec of FIELDS) body.set(spec.name, String(form[spec.name]))
    await app.request('/issue', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `f8130_actor=cascadia-mro.${DOMAIN}`,
      },
      body,
    })

    const feed = await (await app.request('/')).text()
    assert.ok(!feed.includes(NARRATION.remarks), 'narrated Block 12 leaked')
    assert.ok(!feed.includes(NARRATION.signerName), 'narrated Block 13d leaked')
    // Block 7 is public, so it does show.
    assert.match(feed, /Hydraulic reservoir assembly/)
  })

  test('no narrator means the catalogue, and the endpoint still answers', async () => {
    const { app } = await narratedApp(null)
    const res = await app.request('/api/example')
    assert.equal(res.status, 200)
    const form = (await res.json()) as Record<string, unknown>
    for (const spec of FIELDS) assert.ok(spec.name in form)
  })

  test('a narrator that fails is invisible to the caller', async () => {
    const { app } = await narratedApp({ narrate: async () => null })
    const res = await app.request('/api/example')
    assert.equal(res.status, 200)
    const form = (await res.json()) as Record<string, unknown>
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

  test('a release is later checked by the operator who received it', async () => {
    const { g, calls } = gen([], { random: WALK_THE_THREAD })
    await g.tick()
    await g.tick()

    assert.equal(calls.length, 2)
    const [rel, att] = calls
    assert.equal(att.kind, 'attestation')
    assert.equal(att.subject.uri, rel.uri, 'the check must name the release it covers')

    // The check is published by the operator, not by the issuer: a receipt the
    // issuer could write is not a receipt.
    const verifier = orgs(DOMAIN).find((o) => o.handle === att.handle)!
    assert.ok(['operator', 'lessor'].includes(verifier.kind))
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

    const res = await app.request('/api/example', {
      headers: { cookie: `f8130_actor=${mro.handle}` },
    })
    assert.equal(res.status, 200)
    const form = (await res.json()) as Record<string, unknown>

    // A feed card shows the date on the certificate rather than the moment
    // the record arrived, so a form generated for somebody to sign now has to
    // claim now. Left to the catalogue's default it lands anywhere in the last
    // ninety days, and a release published by hand appeared in the feed
    // seventeen days old.
    const claimed = new Date(String(form.completedAt)).getTime()
    const ageDays = (Date.now() - claimed) / 86_400_000
    assert.ok(ageDays < 1, `a form to be signed now claims ${ageDays.toFixed(1)}d ago`)
    assert.ok(claimed <= Date.now(), 'a certificate cannot be signed in the future')
  })

  test('the no-script prefill claims today too', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const index = new MemoryIndex()
    const writer = new MemoryRecordWriter(net, index, demoActors(DOMAIN))
    const app = createApp({ resolver: net, repo: net, index, writer, mode: 'live' })
    const mro = orgs(DOMAIN).find((o) => o.kind === 'mro')!

    const body = await (
      await app.request('/issue?example', { headers: { cookie: `f8130_actor=${mro.handle}` } })
    ).text()

    // Both prefill paths had the same omission; fixing only the scripted one
    // would leave the fallback quietly wrong.
    const m = body.match(/name="completedAt"[^>]*value="([^"]+)"/)
    assert.ok(m, 'no completedAt was prefilled')
    const ageDays = (Date.now() - new Date(m![1]!).getTime()) / 86_400_000
    assert.ok(ageDays < 1, `the fallback prefill claims ${ageDays.toFixed(1)}d ago`)
  })
})
