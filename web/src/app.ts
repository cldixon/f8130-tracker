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
  AttestationRow,
  FeedEvent,
  ReadIndex,
  ReleaseRow,
} from './index-port.js'
import {
  cabinetPage,
  dashboardPage,
  disclosePage,
  errorPage,
  feedCard,
  feedPage,
  formPage,
  inboxPage,
  inboxCheckPage,
  inboxCheckBody,
  inboxScanPage,
  inboxScanBody,
  inboxDoneBody,
  issueBody,
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
    viewerJoined(handle?: string): void
    viewerLeft(handle?: string): void
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

  /**
   * The DID the visitor is acting as.
   *
   * The viewpoint check compares this against the DID on a record, rather than
   * comparing the visitor's handle against a handle in the index. That was the
   * old arrangement and it could not work in production: nothing ever wrote a
   * real handle into the index, so the comparison was handle-against-DID and
   * never matched — no card in the live feed was ever marked as the visitor's.
   *
   * Resolved through the same port the verification pipeline uses, so this is
   * a real handle resolution rather than a lookup in the shipped roster. It is
   * cached because the roster is small, fixed for the life of the process, and
   * every page render would otherwise pay for it.
   */
  const actingDids = new Map<string, string | null>()
  async function actingDid(handle: string | undefined): Promise<string | undefined> {
    if (!handle) return undefined
    if (!actingDids.has(handle)) {
      try {
        actingDids.set(handle, await deps.resolver.resolveHandle(handle))
      } catch {
        // A name that will not resolve marks nothing, which is the safe way
        // for this to fail: it under-claims rather than mislabelling a card.
        actingDids.set(handle, null)
      }
    }
    return actingDids.get(handle) ?? undefined
  }

  /** Every party named by anything on screen. */
  function didsIn(events: FeedEvent[]): Set<string> {
    const dids = new Set<string>()
    for (const e of events) {
      if (e.kind === 'release') dids.add(e.release.issuerDid)
      else {
        dids.add(e.attestation.verifierDid)
        dids.add(e.attestation.issuerDid)
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

  /**
   * The releases the attestations on screen are about.
   *
   * An attestation card quotes its subject rather than restating it, which
   * needs the release itself. One lookup for the whole page rather than one
   * per card.
   */
  async function subjectsFor(events: FeedEvent[]): Promise<Map<string, ReleaseRow>> {
    if (!deps.index) return new Map()
    const uris = events
      .filter((e) => e.kind === 'attestation')
      .map((e) => (e as { attestation: AttestationRow }).attestation.subjectUri)
    if (uris.length === 0) return new Map()
    return deps.index.releasesByUris([...new Set(uris)])
  }

  /** How many independent checks each release on screen has drawn. */
  async function replyCounts(events: FeedEvent[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (!deps.index) return out
    const cids = events.filter((e) => e.kind === 'release').map((e) => e.release.cid)
    if (cids.length === 0) return out
    for (const a of await deps.index.attestationsForSubjects(cids)) {
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
        subjects: await subjectsFor(events),
        replies: await replyCounts(events),
        current: await actingDid(currentActor(c)),
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

    const attestations = await deps.index.attestationsForSubjects([release.cid])

    const dids = new Set<string>([release.issuerDid])
    for (const a of attestations) dids.add(a.verifierDid)
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
        attestations: [...attestations].reverse(),
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
  app.get('/api/feed/stream', async (c) => {
    if (!deps.index) return c.text('no index', 503)
    const index = deps.index

    // Fixed at connect time. The stream is per-connection, and switching
    // viewpoint reloads the page, which opens a new one.
    const viewer = await actingDid(currentActor(c))

    // A resumed stream picks up where the page left off. The client sends the
    // timestamp of the newest event it has drawn, so events another viewer's
    // session produced while this one was paused still arrive rather than
    // being silently skipped.
    const resume = c.req.query('since')
    const parsed = resume ? new Date(resume) : null
    let since =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date()
    let closed = false

    // -1 rather than 0, so the first poll always reports — including a count
    // of zero, which is the correct answer for a page rendered when something
    // was waiting and then cleared.
    let lastWaiting = -1

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const send = (chunk: string) => {
          if (!closed) controller.enqueue(enc.encode(chunk))
        }

        deps.activity?.viewerJoined(viewer)
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
                const subjects = await subjectsFor(events)
                const markup = String(
                  await feedCard(
                    e, handles, new Date(), viewer, undefined, names, subjects,
                  ),
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

            // What is waiting on the dock, whenever it changes.
            //
            // Sent on this stream rather than polled on its own, because the
            // arrival that changes it is produced by the same generator this
            // stream is keeping alive. Only on a change: an unchanged number
            // every three seconds is a message the client would spend its time
            // discarding.
            //
            // A count and nothing else. What is waiting is addressed to one
            // organization, and the stream is public — the number is the most
            // that can be said without saying whose part it is.
            const waiting = deps.dock?.count(viewer) ?? 0
            if (waiting !== lastWaiting) {
              lastWaiting = waiting
              send(`event: waiting\ndata: ${waiting}\n\n`)
            }
          } catch {
            // A transient index error should drop one poll, not the stream.
          }
        }, 3000)

        const shutdown = () => {
          if (closed) return
          closed = true
          clearInterval(poll)
          deps.activity?.viewerLeft(viewer)
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
          chrome: chrome(c, 'issuers'),
          issuers: [],
          handles: new Map(),
          indexAvailable: false,
          mode,
        }),
      )
    }
    const issuers = await deps.index.issuerStats()
    const dids = issuers.map((i) => i.did)
    const handles = await resolveHandles(deps.index, dids)
    return c.html(
      dashboardPage({
        chrome: chrome(c, 'issuers'),
        issuers,
        handles,
        // The table named everybody by handle and nobody by name, which is the
        // one screen in the app that is entirely about who is publishing.
        names: await namesFor(dids),
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
          chrome: chrome(c),
          partNumber,
          serialNumber,
          chain: [],
          attestations: new Map(),
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

    const checks = await deps.index.attestationsForSubjects(
      chain.map((r) => r.cid),
    )
    const attestations = new Map<string, AttestationRow[]>()
    for (const a of checks) {
      const list = attestations.get(a.subjectCid) ?? []
      list.push(a)
      attestations.set(a.subjectCid, list)
    }

    const handles = await resolveHandles(deps.index, [
      ...chain.map((r) => r.issuerDid),
      ...checks.map((a) => a.verifierDid),
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
        chrome: chrome(c),
        partNumber,
        serialNumber,
        chain,
        attestations,
        handles,
        names: await namesFor([
          ...chain.map((r) => r.issuerDid),
          ...checks.map((a) => a.verifierDid),
        ]),
        reachedBirth,
        trace,
        mode,
      }),
    )
  })

  // --------------------------------------------------------------- verify
  app.get('/cabinet', (c) =>
    c.html(cabinetPage({ mode, chrome: chrome(c, 'docs') })),
  )

  app.get('/verify', (c) => c.html(verifyPage(mode, undefined, undefined, chrome(c, 'docs'))))

  app.post('/verify', async (c) => {
    const form = await c.req.parseBody()
    const raw = typeof form.bundle === 'string' ? form.bundle : ''
    const serial = typeof form.serial === 'string' ? form.serial.trim() : ''

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return c.html(
        verifyPage(mode, undefined, 'That is not valid JSON.', chrome(c, 'docs')),
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
      // Only a successful check by somebody acting as an organization can be
      // vouched for. Everything else renders the report and stops.
      const acting = deps.writer ? currentActor(c) : undefined
      const actor = acting
        ? deps.writer!.actors().find((a) => a.handle === acting)
        : undefined
      const vouch =
        report.verified && actor
          ? {
              subjectUri: bundle.uri,
              // The chain is newest-first, so its head is the record this
              // document is about. A strong reference needs the CID, and this
              // is where the pipeline already has it.
              subjectCid: report.chain[0]?.cid ?? '',
              actor: actor.displayName,
            }
          : null
      return c.html(
        verifyPage(mode, report, undefined, chrome(c, 'docs'), vouch?.subjectCid ? vouch : null),
      )
    } catch (err) {
      return c.html(verifyPage(mode, undefined, describe(err), chrome(c, 'docs')), 400)
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
    c.html(disclosePage({ mode, chrome: chrome(c, 'docs'), fields: FIELD_ORDER })),
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
     * Publishing a successful check.
     *
     * Only successes reach here, and the lexicon has no failing counterpart.
     * A party who cannot verify a document cannot prove that to anybody, so
     * there is nothing publishable to write and no route that would write it.
     *
     * The record is rebuilt from the posted references and nothing else: the
     * form carries the release URI and CID, and who is vouching comes from the
     * session rather than the request, so a caller cannot attest as somebody
     * else.
     */
    app.post('/attest', async (c) => {
      const form = await c.req.parseBody()
      const handle = currentActor(c)
      if (!handle) {
        return c.html(errorPage(403, 'Sign in as an organization to publish.'), 403)
      }
      const subjectUri = typeof form.subjectUri === 'string' ? form.subjectUri : ''
      const subjectCid = typeof form.subjectCid === 'string' ? form.subjectCid : ''
      if (!subjectUri || !subjectCid) {
        return c.html(errorPage(400, 'An attestation needs the release it covers.'), 400)
      }

      try {
        // Read the dock before writing, because publishing clears it: an
        // attestation is the fact that the part was dealt with, so the crate
        // stops waiting. Without this the part stayed in Receiving
        // forever and could be attested again and again.
        const arrival = deps.dock?.arrival(handle, subjectUri)

        const written = await writer.createAttestation({
          handle,
          subject: { uri: subjectUri, cid: subjectCid },
        })
        deps.dock?.settle(subjectUri)

        // Somebody who came from their own goods-in gets a receipt for the
        // crate they were looking at. Landing them back on the Verify page,
        // with its empty textarea asking for a document they have already
        // checked, is a worse answer to "what happened".
        if (arrival) {
          const actor = writer.actors().find((a) => a.handle === handle)!
          const done = { actor, arrival, published: written.uri }
          if (c.req.query('fragment') !== undefined) {
            return c.html(inboxCheckBody(done))
          }
          return c.html(
            inboxCheckPage({ mode, chrome: chrome(c, 'inbox'), ...done }),
          )
        }
        return c.html(
          verifyPage(mode, undefined, undefined, chrome(c, 'docs'), null, written.uri),
        )
      } catch (err) {
        return c.html(errorPage(400, describe(err)), 400)
      }
    })

    app.get('/issue', async (c) => {
      // A handle on the query wins over the cookie. Reading only the cookie
      // is what let a visitor pick an organization, press generate, and get a
      // form belonging to whoever was first in the roster.
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

      // Always generated, never blank. Seventeen empty blocks is a chore
      // nobody was going to complete to see an idea, and the point of this
      // screen is the idea. The draft is issued BY the acting organization, so
      // its Block 4 is that organization's own — the one thing on a form a
      // shop could not plausibly get wrong about itself.
      //
      // agedDays: 0 because the work is finishing now; it is being signed now.
      let draft: Record<string, unknown> | null = null
      const org = handle
        ? orgs(process.env.PDS_HOSTNAME ?? 'f8130.cldixon.dev').find(
            (o) => o.handle === handle,
          )
        : undefined
      if (org) {
        draft = await narratedForm({
          org,
          seed: Math.floor(Math.random() * 1e9),
          narrator: deps.narrator ?? null,
          agedDays: 0,
        })
      }

      // Never cached, and this is not belt-and-braces.
      //
      // Every response here is a freshly generated certificate at a URL that
      // never varies. With no Cache-Control, no ETag and no Last-Modified, a
      // 200 GET is heuristically cacheable and fetch() reads the HTTP cache by
      // default — so the second press of "New release" reopened the document
      // the visitor had just signed and asked them to sign it again. The
      // header is the fix; the fetch also asks for no-store, because either
      // one alone leaves the other path relying on browser heuristics.
      c.header('cache-control', 'no-store')

      // The modal asks for the body alone and wraps it itself, so the two
      // paths render the same markup rather than two templates that drift.
      if (c.req.query('fragment') !== undefined) {
        return c.html(
          issueBody({ actors: writer.actors(), current: handle, draft }),
        )
      }

      return c.html(
        issuePage({
          mode,
          chrome: { actors: writer.actors(), current: handle, composer: false },
          actors: writer.actors(),
          current: handle,
          draft,
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
        const done = {
          uri: issued.uri,
          bundle: issued.bundle,
          // What they actually wrote, so the reveal shows their form rather
          // than a re-read of the public record — which is the half of it the
          // screen exists to contrast against.
          values: issued.bundle.values as Record<string, unknown>,
        }
        if (c.req.query('fragment') !== undefined) {
          return c.html(
            issueBody({ actors: writer.actors(), current: handle, issued: done }),
          )
        }
        return c.html(
          issuePage({
            mode,
            chrome: { ...chrome(c), composer: false },
            actors: writer.actors(),
            current: handle,
            issued: done,
          }),
        )
      } catch (err) {
        // Rendered back with what they typed, so a rejected edit is a
        // correction rather than starting over.
        const back = { ...raw }
        if (c.req.query('fragment') !== undefined) {
          return c.html(
            issueBody({
              actors: writer.actors(),
              current: handle,
              draft: back,
              error: describe(err),
            }),
            400,
          )
        }
        return c.html(
          issuePage({
            mode,
            chrome: { ...chrome(c), composer: false },
            actors: writer.actors(),
            current: handle,
            draft: back,
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

    /**
     * What the loading dock booked in, before anybody has checked it.
     *
     * Its own screen rather than a section of the result, because it is a
     * different question: this is "here is what arrived", and the check is
     * "and here is whether it holds up". Reading the document before running
     * anything against it is the order a records desk works in.
     */
    app.get('/inbox/scan', (c) => {
      const handle = currentActor(c)
      const actor = writer.actors().find((a) => a.handle === handle)
      if (!actor) {
        return c.html(errorPage(403, 'Only an organization receives parts.'), 403)
      }
      const arrival = deps.dock?.arrival(handle, c.req.query('uri') ?? '')
      if (!arrival) {
        return c.html(errorPage(404, 'Nothing by that name is waiting for you.'), 404)
      }
      // Never cached: the list it came from changes as crates are dealt with.
      c.header('cache-control', 'no-store')
      if (c.req.query('fragment') !== undefined) {
        return c.html(inboxScanBody({ actor, arrival }))
      }
      return c.html(
        inboxScanPage({ mode, chrome: chrome(c, 'inbox'), actor, arrival }),
      )
    })

    /**
     * Take a part off the list without publishing anything.
     *
     * The two ways a check ends without an attestation — the document did not
     * match, or it did and the receiver would rather not vouch — are the same
     * action here, because the network cannot tell them apart and must not.
     * Nothing is written. The crate stops waiting because the work is done,
     * not because anybody said anything about it.
     */
    app.post('/inbox/clear', async (c) => {
      const form = await c.req.parseBody()
      const handle = currentActor(c)
      if (!handle) {
        return c.html(errorPage(403, 'Only an organization receives parts.'), 403)
      }
      const subjectUri = typeof form.subjectUri === 'string' ? form.subjectUri : ''
      // Only ever from the acting organization's own dock, so a caller cannot
      // clear a crate that was never theirs.
      if (deps.dock?.arrival(handle, subjectUri)) deps.dock.settle(subjectUri)
      if (c.req.query('fragment') !== undefined) {
        return c.html(inboxDoneBody({ back: '/inbox' }))
      }
      return c.redirect('/inbox', 303)
    })

    /**
     * Check the paperwork that came with a part.
     *
     * Takes a release URI and nothing else. The document is looked up in the
     * dock under the acting organization, so a caller cannot check a bundle it
     * supplies, cannot check one addressed to somebody else, and cannot use
     * this route to have the service open a document it was not sent.
     *
     * The check itself is the ordinary pipeline against the live network. It
     * is not scripted to pass: the point of the screen is that a recomputed
     * commitment matches a signed record, and a demonstration that faked that
     * step would be demonstrating nothing. What is spared the visitor is the
     * typing, not the arithmetic.
     */
    app.post('/inbox/check', async (c) => {
      const form = await c.req.parseBody()
      const handle = currentActor(c)
      const actor = writer.actors().find((a) => a.handle === handle)
      if (!actor) {
        return c.html(errorPage(403, 'Only an organization receives parts.'), 403)
      }

      const subjectUri = typeof form.subjectUri === 'string' ? form.subjectUri : ''
      const arrival = deps.dock?.arrival(handle, subjectUri)
      if (!arrival) {
        return c.html(errorPage(404, 'Nothing by that name is waiting for you.'), 404)
      }

      try {
        const bundle = parseBundle(arrival.bundle)
        const report = await verifyBundle({
          bundle,
          // The serial stamped on the part itself, which in a real goods-in is
          // read off the dataplate rather than off the form. Here the crate
          // and the paperwork agree because the same generator wrote both.
          stampedSerial: arrival.serialNumber,
          resolver: deps.resolver,
          repo: deps.repo,
        })
        if (c.req.query('fragment') !== undefined) {
          return c.html(inboxCheckBody({ actor, arrival, report }))
        }
        return c.html(
          inboxCheckPage({
            mode,
            chrome: chrome(c, 'inbox'),
            actor,
            arrival,
            report,
          }),
        )
      } catch (err) {
        return c.html(errorPage(400, describe(err)), 400)
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
