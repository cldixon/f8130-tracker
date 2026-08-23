import { Hono } from 'hono'

import {
  buildDisclosure,
  buildLevels,
  commitmentFromBundle,
  exposedHashes,
  fetchVerifiedRelease,
  FIELD_ORDER,
  FIELDS,
  leafHash,
  nodeHash,
  orgs,
  padLeaf,
  parseBundle,
  parseDisclosure,
  proofForField,
  syntheticForm,
  narratedForm,
  toHex,
  traceChain,
  verifyBundle,
  verifyDisclosure,
  type Bundle,
  type ChainTrace,
  type Narrator,
  type IdentityResolver,
  type RepoClient,
} from '@f8130/core'

import type {
  AcceptanceRow,
  DisputeRow,
  FeedEvent,
  ReadIndex,
  ReleaseRow,
} from './index-port.js'
import {
  acceptPage,
  cabinetPage,
  dashboardPage,
  disclosePage,
  errorPage,
  feedCard,
  feedPage,
  formPage,
  inboxPage,
  issuePage,
  partPage,
  threadPage,
  verifyPage,
  type FormFold,
} from './views.js'
import { PUBLIC_HANDLE, type NavKey } from './shell.js'
import type { Dock } from './dock.js'
import { RELEASE_NSID, type RecordWriter } from './writer.js'

const MAX_CHAIN_DEPTH = 100
const MAX_BUNDLE_BYTES = 256 * 1024

export type AppDeps = {
  resolver: IdentityResolver
  repo: RepoClient
  /**
   * Optional on purpose. Verification consults no database, so the service
   * remains fully useful for its primary job when the index is absent.
   */
  index?: ReadIndex | null
  /**
   * Seeded bundles, offered for download in demo mode.
   *
   * Without these the verify page is a box you cannot use until someone hands
   * you a document. With them the whole story — genuine, tampered, forged — is
   * reachable from a fresh clone with nothing installed.
   */
  demoBundles?: Record<string, unknown> | null
  /**
   * Whether the service is reading the real network or an in-memory stand-in.
   *
   * Surfaced in the UI and on /api/health rather than kept internal: a demo
   * instance that looks identical to a live one is a trap for anyone who
   * stumbles onto the URL.
   */
  mode?: 'demo' | 'live'
  /**
   * Optional. Without it the app is read-only, which is the correct posture
   * for a deployment that has no PDS to write to.
   */
  writer?: RecordWriter | null
  /**
   * Synthetic activity, if this deployment generates any.
   *
   * The app only ever tells it that a viewer arrived or left; when to write and
   * what to write are entirely the generator's business.
   */
  activity?: {
    viewerJoined(): void
    viewerLeft(): void
  } | null
  /**
   * Parts that physically arrived, awaiting inspection.
   *
   * Not part of the read model, and deliberately not derived from it: an
   * 8130-3 names the issuer and not the recipient, so no index built from the
   * public record can say what is waiting for anybody. See dock.ts.
   */
  dock?: Dock | null
  /**
   * A source of prose for generated forms.
   *
   * Optional in the strongest sense: with none configured every generated form
   * comes from the hand-written catalogue, which is what a fresh clone with no
   * API key gets and has always got.
   */
  narrator?: Narrator | null
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  const mode = deps.mode ?? 'live'

  app.get('/api/health', (c) =>
    c.json({ ok: true, mode, index: Boolean(deps.index) }),
  )

  // ------------------------------------------------------------------ feed
  //
  // The front page. Two things make it worth having as the front page rather
  // than a tab: it is the only view that shows the system rather than a
  // document, and it is ordered on this observer's own clock, so a backdating
  // issuer cannot choose where in the timeline they appear.

  const FEED_LIMIT = 40

  /**
   * Display names for the DIDs on screen.
   *
   * Read from station records this observer indexed off the firehose, not from
   * the roster compiled into this binary. The roster version worked only
   * because the demonstration cast happens to ship with the code, which is
   * precisely the shortcut the station lexicon exists to avoid — an AppView
   * should learn who anybody is from what they published.
   *
   * Kept separate from handles: the handle is the identity the viewpoint check
   * compares against, the display name is only for reading.
   */
  async function namesFor(dids: Iterable<string>): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!deps.index) return out
    const rows = await deps.index.actorsFor([...new Set(dids)])
    for (const [did, row] of rows) {
      if (row.displayName) out.set(did, row.displayName)
    }
    return out
  }

  /** Every party named by anything on screen. */
  function didsIn(events: FeedEvent[]): Set<string> {
    const dids = new Set<string>()
    for (const e of events) {
      if (e.kind === 'release') dids.add(e.release.issuerDid)
      else {
        dids.add(e.verdict.verifierDid)
        dids.add(e.verdict.issuerDid)
      }
    }
    return dids
  }

  /** Handles for the DIDs on screen, so a feed does not read as raw DIDs. */
  async function handlesFor(events: FeedEvent[]): Promise<Map<string, string>> {
    const dids = didsIn(events)
    const out = new Map<string, string>()
    if (!deps.index) return out
    await Promise.all(
      [...dids].map(async (did) => {
        const h = await deps.index!.handleFor(did)
        if (h) out.set(did, h)
      }),
    )
    return out
  }

  /** How many verdicts each release on screen has drawn. */
  async function replyCounts(events: FeedEvent[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (!deps.index) return out
    const cids = events.filter((e) => e.kind === 'release').map((e) => e.release.cid)
    if (cids.length === 0) return out
    for (const a of await deps.index.acceptancesForSubjects(cids)) {
      out.set(a.subjectCid, (out.get(a.subjectCid) ?? 0) + 1)
    }
    return out
  }

  app.get('/', async (c) => {
    const events = deps.index ? await deps.index.feed({ limit: FEED_LIMIT }) : []
    const handles = await handlesFor(events)
    return c.html(
      feedPage({
        mode,
        chrome: chrome(c, 'home'),
        events,
        handles,
        names: await namesFor(didsIn(events)),
        replies: await replyCounts(events),
        current: currentActor(c),
        hasIndex: Boolean(deps.index),
        live: Boolean(deps.index),
      }),
    )
  })

  /**
   * One release and its thread.
   *
   * Addressed the way atproto addresses it — repository plus record key —
   * rather than by the CID this observer happens to have stored, so the URL
   * survives this index being rebuilt.
   */
  app.get('/post/:did/:rkey', async (c) => {
    if (!deps.index) return c.html(errorPage(503, 'No index is configured.'), 503)
    const uri = `at://${c.req.param('did')}/${RELEASE_NSID}/${c.req.param('rkey')}`
    const release = await deps.index.releaseByUri(uri)
    if (!release) {
      return c.html(
        errorPage(404, 'This observer has not seen that release.'),
        404,
      )
    }

    const verdicts = await deps.index.acceptancesForSubjects([release.cid])
    const answers = await deps.index.disputesForSubjects(verdicts.map((v) => v.cid))
    const replies = new Map<string, DisputeRow[]>()
    for (const d of answers) {
      replies.set(d.subjectCid, [...(replies.get(d.subjectCid) ?? []), d])
    }

    const dids = new Set<string>([release.issuerDid])
    for (const v of verdicts) {
      dids.add(v.verifierDid)
      dids.add(v.issuerDid)
    }
    for (const d of answers) dids.add(d.authorDid)
    const handles = new Map<string, string>()
    await Promise.all(
      [...dids].map(async (did) => {
        const h = await deps.index!.handleFor(did)
        if (h) handles.set(did, h)
      }),
    )

    return c.html(
      threadPage({
        mode,
        chrome: chrome(c, 'home'),
        release,
        // Oldest first: a thread reads downward.
        verdicts: [...verdicts].reverse(),
        replies,
        handles,
        names: await namesFor(dids),
      }),
    )
  })

  /**
   * The live stream.
   *
   * Polls this AppView's own index rather than tapping the firehose directly,
   * which is deliberate: the feed shows what an observer *observed*, so
   * anything that reaches the index reaches the feed — the generator, a visitor
   * using the issue page, or the seed job. Tapping the firehose here would show
   * records the index had not accepted yet, which is a different claim.
   *
   * Holding this connection open is also what tells the generator somebody is
   * watching. Close the tab and synthetic activity stops.
   */
  app.get('/api/feed/stream', (c) => {
    if (!deps.index) return c.text('no index', 503)
    const index = deps.index

    // Fixed at connect time. The stream is per-connection, and switching
    // viewpoint reloads the page, which opens a new one.
    const viewer = currentActor(c)

    // A resumed stream picks up where the page left off. The client sends the
    // timestamp of the newest event it has drawn, so events another viewer's
    // session produced while this one was paused still arrive rather than
    // being silently skipped.
    const resume = c.req.query('since')
    const parsed = resume ? new Date(resume) : null
    let since =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date()
    let closed = false

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const send = (chunk: string) => {
          if (!closed) controller.enqueue(enc.encode(chunk))
        }

        deps.activity?.viewerJoined()
        send(': connected\n\n')

        const poll = setInterval(async () => {
          if (closed) return
          try {
            const events = await index.feed({ limit: FEED_LIMIT, since })
            if (events.length > 0) {
              // Oldest first, so prepending each one leaves the newest on top.
              const handles = await handlesFor(events)
              for (const e of [...events].reverse()) {
                const names = await namesFor(didsIn(events))
                const markup = String(
                  await feedCard(e, handles, new Date(), viewer, undefined, names),
                )
                  .replace(/\s*\n\s*/g, ' ')
                send(`event: event\ndata: ${markup}\n\n`)
              }
              since = events[0]!.at
            } else {
              // Keeps proxies from closing an idle connection, and is how the
              // generator learns the viewer is still there.
              send(': keep-alive\n\n')
            }
          } catch {
            // A transient index error should drop one poll, not the stream.
          }
        }, 3000)

        const shutdown = () => {
          if (closed) return
          closed = true
          clearInterval(poll)
          deps.activity?.viewerLeft()
          try {
            controller.close()
          } catch {
            // already closed by the client going away
          }
        }
        c.req.raw.signal.addEventListener('abort', shutdown)
      },
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  })

  // ------------------------------------------------------------- dashboard
  app.get('/parts', async (c) => {
    if (!deps.index) {
      return c.html(
        dashboardPage({
          chrome: chrome(c, 'parts'),
          recent: [],
          issuers: [],
          handles: new Map(),
          indexAvailable: false,
          mode,
        }),
      )
    }
    const [recent, issuers] = await Promise.all([
      deps.index.recentReleases(25),
      deps.index.issuerStats(),
    ])
    const handles = await resolveHandles(deps.index, [
      ...recent.map((r) => r.issuerDid),
      ...issuers.map((i) => i.did),
    ])
    return c.html(
      dashboardPage({
        chrome: chrome(c, 'parts'),
        recent,
        issuers,
        handles,
        indexAvailable: true,
        mode,
      }),
    )
  })

  // ------------------------------------------------------------ part page
  app.get('/part/:pn/:sn', async (c) => {
    if (!deps.index) return c.html(errorPage(503, 'No index is configured.'), 503)

    const partNumber = c.req.param('pn')
    const serialNumber = c.req.param('sn')

    const releases = await deps.index.releasesForPart(partNumber, serialNumber)
    if (releases.length === 0) {
      return c.html(
        partPage({
          chrome: chrome(c, 'parts'),
          partNumber,
          serialNumber,
          chain: [],
          acceptances: new Map(),
          handles: new Map(),
          reachedBirth: false,
          mode,
        }),
        404,
      )
    }

    // Walk from the newest release so the page shows one connected history
    // rather than every record that happens to mention this serial.
    const chain = await deps.index.chain(releases[0]!.cid, MAX_CHAIN_DEPTH)
    const oldest = chain[chain.length - 1]
    const reachedBirth = Boolean(oldest && !oldest.prevCid)

    const verdicts = await deps.index.acceptancesForSubjects(
      chain.map((r) => r.cid),
    )
    const acceptances = new Map<string, AcceptanceRow[]>()
    for (const v of verdicts) {
      const list = acceptances.get(v.subjectCid) ?? []
      list.push(v)
      acceptances.set(v.subjectCid, list)
    }

    const handles = await resolveHandles(deps.index, [
      ...chain.map((r) => r.issuerDid),
      ...verdicts.map((v) => v.verifierDid),
    ])

    // The same history, walked live over the issuers' own servers rather than
    // read out of here. It needs no bundle and no account, which is the point:
    // a buyer holding nothing can still ask whether a part traces to birth,
    // and get an answer this AppView had no part in. If the walk fails the
    // page says so and falls back to the stored view, labelled as such.
    let trace: ChainTrace | null = null
    try {
      trace = await traceChain({
        uri: releases[0]!.uri,
        resolver: deps.resolver,
        repo: deps.repo,
      })
    } catch (err) {
      trace = {
        links: [],
        reachedBirth: false,
        headError: describe(err),
      }
    }

    return c.html(
      partPage({
        chrome: chrome(c, 'parts'),
        partNumber,
        serialNumber,
        chain,
        acceptances,
        handles,
        names: await namesFor([
          ...chain.map((r) => r.issuerDid),
          ...verdicts.map((v) => v.verifierDid),
          ...verdicts.map((v) => v.issuerDid),
        ]),
        reachedBirth,
        trace,
        mode,
      }),
    )
  })

  // --------------------------------------------------------------- verify
  app.get('/cabinet', (c) =>
    c.html(cabinetPage({ mode, chrome: chrome(c, 'cabinet') })),
  )

  app.get('/verify', (c) => c.html(verifyPage(mode, undefined, undefined, chrome(c, 'verify'))))

  app.post('/verify', async (c) => {
    const form = await c.req.parseBody()
    const raw = typeof form.bundle === 'string' ? form.bundle : ''
    const serial = typeof form.serial === 'string' ? form.serial.trim() : ''

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return c.html(
        verifyPage(mode, undefined, 'That is not valid JSON.', chrome(c, 'verify')),
        400,
      )
    }

    try {
      const bundle = parseBundle(parsed)
      const report = await verifyBundle({
        bundle,
        stampedSerial: serial || undefined,
        resolver: deps.resolver,
        repo: deps.repo,
      })
      return c.html(verifyPage(mode, report, undefined, chrome(c, 'verify')))
    } catch (err) {
      return c.html(verifyPage(mode, undefined, describe(err), chrome(c, 'verify')), 400)
    }
  })

  app.post('/api/verify', async (c) => {
    const contentLength = Number(c.req.header('content-length') ?? 0)
    if (contentLength > MAX_BUNDLE_BYTES) {
      return c.json({ error: 'bundle too large' }, 413)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    const payload = body as { bundle?: unknown; stampedSerial?: unknown }
    // Accept either a bare bundle or {bundle, stampedSerial}, since the obvious
    // thing to POST is the file the station handed you.
    const bundleInput = payload?.bundle ?? body

    try {
      const bundle = parseBundle(bundleInput)
      const report = await verifyBundle({
        bundle,
        stampedSerial:
          typeof payload?.stampedSerial === 'string'
            ? payload.stampedSerial
            : undefined,
        resolver: deps.resolver,
        repo: deps.repo,
      })
      // Deliberately no logging of the request body anywhere in this handler:
      // a bundle carries every private field and its nonces, and an AppView
      // that kept them would rebuild the disclosure problem it exists to avoid.
      return c.json(report, report.verified ? 200 : 422)
    } catch (err) {
      return c.json({ error: describe(err) }, 400)
    }
  })

  // ------------------------------------------------- selective disclosure
  app.get('/disclose', (c) =>
    c.html(disclosePage({ mode, chrome: chrome(c), fields: FIELD_ORDER })),
  )

  app.post('/disclose', async (c) => {
    const form = await c.req.parseBody({ all: true })
    const raw = typeof form.bundle === 'string' ? form.bundle : ''
    const picked = Array.isArray(form.field)
      ? (form.field as string[])
      : typeof form.field === 'string'
        ? [form.field]
        : []

    const fail = (error: string, status: 400 | 404 = 400) =>
      c.html(
        disclosePage({ mode, chrome: chrome(c), fields: FIELD_ORDER, error }),
        status,
      )

    if (picked.length === 0) return fail('Choose at least one field to reveal.')

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return fail('That is not valid JSON.')
    }

    let disclosure
    try {
      disclosure = buildDisclosure({ bundle: parseBundle(parsed), fields: picked })
    } catch (err) {
      return fail(describe(err))
    }

    // Check it the way the recipient would: against the commitment the issuer
    // published, fetched from their own server. Building and checking are the
    // same screen here only because it is a demonstration.
    const fetched = await fetchVerifiedRelease({
      uri: disclosure.uri,
      resolver: deps.resolver,
      repo: deps.repo,
    })
    if (!fetched.ok) return fail(fetched.reason, 404)

    return c.html(
      disclosePage({
        mode,
        fields: FIELD_ORDER,
        disclosure,
        result: verifyDisclosure(disclosure, fetched.commitment),
        exposed: exposedHashes(disclosure),
      }),
    )
  })

  app.post('/api/disclose', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }
    try {
      const disclosure = buildDisclosure({
        bundle: parseBundle(body?.bundle ?? body),
        fields: Array.isArray(body?.fields) ? body.fields : [],
      })
      return c.json(disclosure)
    } catch (err) {
      return c.json({ error: describe(err) }, 400)
    }
  })

  app.post('/api/disclose/verify', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'body must be JSON' }, 400)
    }

    let disclosure
    try {
      disclosure = parseDisclosure((body as any)?.disclosure ?? body)
    } catch (err) {
      return c.json({ error: describe(err) }, 400)
    }

    const fetched = await fetchVerifiedRelease({
      uri: disclosure.uri,
      resolver: deps.resolver,
      repo: deps.repo,
    })
    if (!fetched.ok) return c.json({ error: fetched.reason }, 404)

    const result = verifyDisclosure(disclosure, fetched.commitment)
    return c.json(result, result.verified ? 200 : 422)
  })

  // ------------------------------------------------------------- form view
  //
  // One record rendered three ways: as the paper form a shop would recognise,
  // as the atproto record actually published, and as the commitment tree. The
  // point of putting them side by side is that a block on the left, a key in
  // the middle, and a leaf on the right are the same fact in three notations.

  /** Block 4 reaches the public record, so the issuer names itself. */
  function issuerNameOf(record: Record<string, unknown> | null): string | undefined {
    const n = record?.organizationName
    return typeof n === 'string' ? n : undefined
  }

  /** The published root, plus whatever the bundle lets us compute. */
  async function formData(uri: string, bundle: Bundle | null, field: string | null) {
    const fetched = await fetchVerifiedRelease({
      uri,
      resolver: deps.resolver,
      repo: deps.repo,
    })

    const record = fetched.ok ? fetched.record : null
    const root = fetched.ok ? toHex(fetched.commitment) : null
    const fetchError = fetched.ok ? null : fetched.reason

    if (!bundle) {
      return {
        record, root, fetchError,
        values: null, leaves: null, pad: null, matches: null,
        selected: null, fold: null,
      }
    }

    const commitment = commitmentFromBundle(bundle)
    const leaves = commitment.leaves.map(toHex)
    const computed = toHex(commitment.root)

    // The fold, when a field is chosen: leaf, then each sibling, then the root.
    // Exactly the walk a verifier does with a selective disclosure, shown
    // whole because here the holder has every leaf anyway.
    let fold: FormFold[] | null = null
    if (field && FIELD_ORDER.includes(field)) {
      const proof = proofForField(commitment, field)
      let acc = leafHash(proof.field, proof.value, proof.nonce)
      const running: FormFold[] = [{ label: `leaf(${field})`, hash: toHex(acc) }]
      for (const step of proof.path) {
        acc =
          step.side === 'left' ? nodeHash(step.hash, acc) : nodeHash(acc, step.hash)
        running.push({
          label: toHex(step.hash).slice(0, 12) + '…',
          hash: toHex(acc),
          side: step.side,
        })
      }
      fold = running
    }

    return {
      record, root, fetchError,
      values: commitment.values,
      leaves,
      pad: toHex(padLeaf()),
      matches: root === null ? null : root === computed,
      selected: field,
      fold,
    }
  }

  app.get('/form', async (c) => {
    const uri = c.req.query('uri')
    if (!uri) return c.html(errorPage(400, 'A record URI is required.'), 400)
    const field = c.req.query('field') ?? null
    const data = await formData(uri, null, field)
    return c.html(
      formPage({
        mode,
        chrome: chrome(c),
        uri,
        issuerHandle: issuerNameOf(data.record),
        ...data,
      }),
    )
  })

  app.post('/form', async (c) => {
    const form = await c.req.parseBody()
    const uriField = typeof form.uri === 'string' ? form.uri : ''
    const field = typeof form.field === 'string' ? form.field : null
    const raw = typeof form.bundle === 'string' ? form.bundle : ''
    if (raw.length > MAX_BUNDLE_BYTES) {
      return c.html(errorPage(413, 'That bundle is too large.'), 413)
    }

    // Clicking a block with nothing pasted is the ordinary case, not an error.
    // The viewer gets the public form back with their choice remembered, and
    // the tree still says it cannot be opened.
    if (raw.trim() === '') {
      const data = await formData(uriField, null, field)
      return c.html(
        formPage({
          mode,
          chrome: chrome(c),
          uri: uriField,
          issuerHandle: issuerNameOf(data.record),
          ...data,
        }),
      )
    }

    let bundle: Bundle
    try {
      bundle = parseBundle(JSON.parse(raw))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const data = await formData(uriField, null, null)
      return c.html(
        formPage({
          mode,
          uri: uriField,
          issuerHandle: issuerNameOf(data.record),
          ...data,
          error: message,
        }),
        422,
      )
    }

    // The bundle names the record it opens. Trust it over the form field, so a
    // bundle pasted on the wrong page still lands on the right document.
    const uri = bundle.uri || uriField
    const data = await formData(uri, bundle, field)
    return c.html(
      formPage({
        mode,
        uri,
        issuerHandle: bundle.issuerHandle,
        ...data,
        bundleEcho: raw,
      }),
    )
  })

  app.get('/api/chain/:cid', async (c) => {
    if (!deps.index) return c.json({ error: 'no index configured' }, 503)
    const chain = await deps.index.chain(c.req.param('cid'), MAX_CHAIN_DEPTH)
    if (chain.length === 0) return c.json({ error: 'unknown record' }, 404)
    const oldest = chain[chain.length - 1]!
    return c.json({
      chain: chain.map(serializeRelease),
      reachedBirth: !oldest.prevCid,
    })
  })

  if (deps.demoBundles) {
    app.get('/demo/bundles.json', (c) => c.json(deps.demoBundles!))
  }

  // ------------------------------------------------------------- writing
  //
  // The persona cookie is not authentication and is not treated as such — it
  // selects which demonstration organization to act as, and every account it
  // can select is fictional. Real issuance would authenticate the individual
  // who holds the certificate, which is a different problem this demo does not
  // pretend to solve.
  const ACTOR_COOKIE = 'f8130_actor'

  /**
   * Who the visitor is acting as.
   *
   * Three states, not two. No cookie means a first arrival, and a first
   * arrival lands signed in as a repair station — an application whose first
   * screen has no composer and no identity is a worse demonstration than one
   * that starts somewhere. `~public` is the explicit choice to watch as a
   * stranger, which is the viewpoint that shows what the record actually
   * discloses, so it stays one click away rather than being the front door.
   */
  const defaultActor = (): string | undefined =>
    deps.writer?.actors().find((a) => a.kind === 'mro')?.handle ??
    deps.writer?.actors()[0]?.handle

  const currentActor = (c: any): string | undefined => {
    const raw = c.req.header('cookie') ?? ''
    const match = /(?:^|;\s*)f8130_actor=([^;]+)/.exec(raw)
    if (!match) return defaultActor()
    const handle = decodeURIComponent(match[1]!)
    if (handle === PUBLIC_HANDLE) return undefined
    // Only ever a handle the writer already knows; a tampered cookie selects
    // nothing rather than becoming an injection point.
    return deps.writer?.actors().some((a) => a.handle === handle) ? handle : undefined
  }

  /**
   * What the layout needs to draw the viewpoint control, on every page.
   *
   * `current` is undefined for the public viewpoint, which is a real answer
   * rather than a missing one: most people who look at a certificate hold no
   * repository and no bundle, and the demonstration is more honest if that is
   * the default a visitor arrives in.
   */
  const chrome = (c: any, active: NavKey = null) => ({
    actors: deps.writer?.actors(),
    current: currentActor(c),
    active,
    waiting: deps.dock?.count(currentActor(c)) ?? 0,
  })

  if (deps.writer) {
    const writer = deps.writer

    app.post('/act-as', async (c) => {
      const form = await c.req.parseBody()
      const handle = typeof form.handle === 'string' ? form.handle : ''

      // Signing out is a stored choice rather than a cleared cookie: with no
      // cookie at all the next request would sign back in as the default.
      if (handle === PUBLIC_HANDLE) {
        c.header(
          'set-cookie',
          `${ACTOR_COOKIE}=${PUBLIC_HANDLE}; Path=/; HttpOnly; SameSite=Lax`,
        )
        return c.redirect(c.req.header('referer') ?? '/', 303)
      }
      if (writer.actors().some((a) => a.handle === handle)) {
        c.header(
          'set-cookie',
          `${ACTOR_COOKIE}=${encodeURIComponent(handle)}; Path=/; HttpOnly; SameSite=Lax`,
        )
      }
      // Back where they were, so switching viewpoint does not also navigate.
      return c.redirect(c.req.header('referer') ?? '/', 303)
    })

    /**
     * A generated example, as data.
     *
     * The composer fills its own inputs from this rather than round-tripping,
     * because a round trip closes the dialog. Same builder the seed job and
     * the full page use — a second one would drift the way the roster and the
     * record shape both did, quietly, and only visibly once something failed.
     */
    app.get('/api/example', async (c) => {
      const handle = currentActor(c)
      if (!handle) return c.json({ error: 'the public cannot sign' }, 403)
      const org = orgs(process.env.PDS_HOSTNAME ?? 'f8130.cldixon.dev').find(
        (o) => o.handle === handle,
      )
      if (!org) return c.json({ error: 'unknown organization' }, 404)
      // Narrated when a narrator is configured, drawn from the catalogue when
      // it is not or when the call fails. The caller cannot tell, and both are
      // a valid seventeen-block form.
      return c.json(
        await narratedForm({
          org,
          seed: Math.floor(Math.random() * 1e9),
          narrator: deps.narrator ?? null,
        }),
      )
    })

    app.get('/issue', (c) => {
      // The example button submits the handle it can see, and the handle it
      // can see wins. Reading only the cookie is what let a visitor pick an
      // organization, press generate, and get a form belonging to whoever was
      // first in the roster.
      const asked = c.req.query('handle')
      const handle =
        asked && writer.actors().some((a) => a.handle === asked)
          ? asked
          : currentActor(c)

      // Keep the viewpoint control in step with what the page is about to do.
      if (handle && handle !== currentActor(c)) {
        c.header(
          'set-cookie',
          `${ACTOR_COOKIE}=${encodeURIComponent(handle)}; Path=/; HttpOnly; SameSite=Lax`,
        )
      }

      // The generated example is issued BY the acting organization, so its
      // Block 4 is that organization's own — the one thing on the form a shop
      // could not plausibly get wrong about itself.
      let prefill: Record<string, unknown> | null = null
      if (handle && c.req.query('example') !== undefined) {
        const org = orgs(process.env.PDS_HOSTNAME ?? 'f8130.cldixon.dev').find(
          (o) => o.handle === handle,
        )
        if (org) {
          // A fresh seed per request, so clicking twice gives two parts. The
          // generator is deterministic in it, which is what tests pin.
          prefill = syntheticForm({ org, seed: Math.floor(Math.random() * 1e9) })
        }
      }

      return c.html(
        issuePage({
          mode,
          chrome: { actors: writer.actors(), current: handle, composer: false },
          actors: writer.actors(),
          current: handle,
          prefill,
        }),
      )
    })

    app.post('/issue', async (c) => {
      const form = await c.req.parseBody()
      const handle = currentActor(c)
      if (!handle) {
        return c.html(
          issuePage({
            mode,
            chrome: { ...chrome(c), composer: false },
            actors: writer.actors(),
            error: 'Choose an organization in the header before signing.',
          }),
          400,
        )
      }
      const str = (k: string) =>
        typeof form[k] === 'string' && form[k] !== '' ? (form[k] as string) : undefined
      const num = (k: string) => {
        const v = str(k)
        return v === undefined ? undefined : Number(v)
      }

      // Walked from FIELDS rather than listed, so adding a block to the form
      // cannot leave the issue form quietly unable to submit it.
      const raw: Record<string, unknown> = {}
      for (const spec of FIELDS) {
        const v = spec.kind === 'integer' ? num(spec.name) : str(spec.name)
        if (v !== undefined) raw[spec.name] = v
      }

      const prevUri = str('prevUri')
      const prevCid = str('prevCid')

      try {
        const issued = await writer.createRelease({
          handle,
          form: raw,
          prev: prevUri && prevCid ? { uri: prevUri, cid: prevCid } : undefined,
        })
        return c.html(
          issuePage({
            mode,
            chrome: { ...chrome(c), composer: false },
            actors: writer.actors(),
            current: handle,
            issued: { uri: issued.uri, bundle: issued.bundle },
          }),
        )
      } catch (err) {
        return c.html(
          issuePage({
            mode,
            chrome: { ...chrome(c), composer: false },
            actors: writer.actors(),
            current: handle,
            error: describe(err),
          }),
          400,
        )
      }
    })

    app.get('/inbox', (c) => {
      const handle = currentActor(c)
      return c.html(
        inboxPage({
          mode,
          chrome: chrome(c, 'inbox'),
          actor: writer.actors().find((a) => a.handle === handle),
          arrivals: deps.dock?.awaiting(handle) ?? [],
        }),
      )
    })

    app.get('/accept', (c) =>
      c.html(
        acceptPage({
          mode,
          chrome: chrome(c),
          actors: writer.actors(),
          current: currentActor(c),
        }),
      ),
    )

    app.post('/accept', async (c) => {
      const form = await c.req.parseBody()
      const handle = currentActor(c)
      if (!handle) {
        return c.html(
          acceptPage({
            mode,
            chrome: chrome(c),
            actors: writer.actors(),
            error: 'Choose an organization in the header before publishing.',
          }),
          400,
        )
      }
      const get = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '')

      const uri = get('subjectUri')
      const cid = get('subjectCid')
      const outcome = get('outcome') as 'accepted' | 'rejected' | 'discrepancy'

      const fail = (msg: string) =>
        c.html(
          acceptPage({
            mode,
            chrome: chrome(c),
            actors: writer.actors(),
            current: handle,
            error: msg,
          }),
          400,
        )

      if (!uri || !cid) return fail('A release URI and CID are both required.')

      // Look up what is actually being judged rather than trusting the form:
      // a verdict that named the wrong issuer would be evidence against an
      // innocent party.
      const fetched = await fetchVerifiedRelease({
        uri,
        resolver: deps.resolver,
        repo: deps.repo,
      })
      if (!fetched.ok) return fail(fetched.reason)

      try {
        const written = await writer.createAcceptance({
          handle,
          subject: { uri, cid },
          issuerDid: fetched.did,
          partNumber: String(fetched.record.partNumber ?? ''),
          serialNumber: String(fetched.record.serialNumber ?? ''),
          outcome,
          note: get('note') || undefined,
        })

        // The part has been dealt with, so it comes off the dock. Whether it
        // was accepted or rejected is beside the point — what settles a goods-in
        // line is that somebody answered it.
        deps.dock?.settle(uri)

        // Answering from the inbox goes back to the inbox: the useful next
        // thing is the next crate, not a receipt for this one.
        if (get('from') === 'inbox') return c.redirect('/inbox', 303)

        return c.html(
          acceptPage({
            mode,
            chrome: chrome(c),
            actors: writer.actors(),
            current: handle,
            written: { uri: written.uri, kind: 'acceptance' },
          }),
        )
      } catch (err) {
        return fail(describe(err))
      }
    })

    app.post('/dispute', async (c) => {
      const form = await c.req.parseBody()
      const handle = currentActor(c)
      if (!handle) {
        return c.html(
          acceptPage({
            mode,
            chrome: chrome(c),
            actors: writer.actors(),
            error: 'Choose an organization in the header before publishing.',
          }),
          400,
        )
      }
      const get = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '')

      const uri = get('subjectUri')
      const cid = get('subjectCid')
      const response = get('response')

      if (!uri || !cid || !response) {
        return c.html(
          acceptPage({
            mode,
            chrome: chrome(c),
            actors: writer.actors(),
            current: handle,
            error: 'An acceptance URI, CID and response are all required.',
          }),
          400,
        )
      }

      try {
        const written = await writer.createDispute({
          handle,
          subject: { uri, cid },
          response,
        })
        return c.html(
          acceptPage({
            mode,
            chrome: chrome(c),
            actors: writer.actors(),
            current: handle,
            written: { uri: written.uri, kind: 'dispute' },
          }),
        )
      } catch (err) {
        return c.html(
          acceptPage({
            mode,
            chrome: chrome(c),
            actors: writer.actors(),
            current: handle,
            error: describe(err),
          }),
          400,
        )
      }
    })
  }

  app.notFound((c) => c.html(errorPage(404, 'No such page.'), 404))

  return app
}

async function resolveHandles(
  index: ReadIndex,
  dids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const did of new Set(dids)) {
    const handle = await index.handleFor(did)
    if (handle) out.set(did, handle)
  }
  return out
}

function serializeRelease(r: ReleaseRow) {
  return {
    cid: r.cid,
    uri: r.uri,
    issuerDid: r.issuerDid,
    prev: r.prevUri ? { uri: r.prevUri, cid: r.prevCid } : null,
    approvingAuthority: r.approvingAuthority,
    formNumber: r.formNumber,
    organizationName: r.organizationName,
    organizationAddress: r.organizationAddress,
    description: r.description,
    partNumber: r.partNumber,
    serialNumber: r.serialNumber,
    signerCert: r.signerCert,
    completedAt: r.completedAt,
    observedAt: r.observedAt,
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
