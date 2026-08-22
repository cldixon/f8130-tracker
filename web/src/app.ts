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
  toHex,
  verifyBundle,
  verifyDisclosure,
  type Bundle,
  type IdentityResolver,
  type RepoClient,
} from '@f8130/core'

import type { AcceptanceRow, ReadIndex, ReleaseRow } from './index-port.js'
import {
  acceptPage,
  dashboardPage,
  disclosePage,
  errorPage,
  formPage,
  issuePage,
  partPage,
  verifyPage,
  type FormFold,
} from './views.js'
import type { RecordWriter } from './writer.js'

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
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  const mode = deps.mode ?? 'live'

  app.get('/api/health', (c) =>
    c.json({ ok: true, mode, index: Boolean(deps.index) }),
  )

  // ------------------------------------------------------------- dashboard
  app.get('/', async (c) => {
    if (!deps.index) {
      return c.html(
        dashboardPage({
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
      dashboardPage({ recent, issuers, handles, indexAvailable: true, mode }),
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

    return c.html(
      partPage({
        partNumber,
        serialNumber,
        chain,
        acceptances,
        handles,
        reachedBirth,
        mode,
      }),
    )
  })

  // --------------------------------------------------------------- verify
  app.get('/verify', (c) => c.html(verifyPage(mode)))

  app.post('/verify', async (c) => {
    const form = await c.req.parseBody()
    const raw = typeof form.bundle === 'string' ? form.bundle : ''
    const serial = typeof form.serial === 'string' ? form.serial.trim() : ''

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return c.html(verifyPage(mode, undefined, 'That is not valid JSON.'), 400)
    }

    try {
      const bundle = parseBundle(parsed)
      const report = await verifyBundle({
        bundle,
        stampedSerial: serial || undefined,
        resolver: deps.resolver,
        repo: deps.repo,
      })
      return c.html(verifyPage(mode, report))
    } catch (err) {
      return c.html(verifyPage(mode, undefined, describe(err)), 400)
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
  app.get('/disclose', (c) => c.html(disclosePage({ mode, fields: FIELD_ORDER })))

  app.post('/disclose', async (c) => {
    const form = await c.req.parseBody({ all: true })
    const raw = typeof form.bundle === 'string' ? form.bundle : ''
    const picked = Array.isArray(form.field)
      ? (form.field as string[])
      : typeof form.field === 'string'
        ? [form.field]
        : []

    const fail = (error: string, status: 400 | 404 = 400) =>
      c.html(disclosePage({ mode, fields: FIELD_ORDER, error }), status)

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
    return c.html(formPage({ mode, uri, issuerHandle: issuerNameOf(data.record), ...data }))
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
        formPage({ mode, uri: uriField, issuerHandle: issuerNameOf(data.record), ...data }),
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

  const currentActor = (c: any): string | undefined => {
    const raw = c.req.header('cookie') ?? ''
    const match = /(?:^|;\s*)f8130_actor=([^;]+)/.exec(raw)
    const handle = match ? decodeURIComponent(match[1]!) : undefined
    // Only ever a handle the writer already knows; a tampered cookie selects
    // nothing rather than becoming an injection point.
    return deps.writer?.actors().some((a) => a.handle === handle) ? handle : undefined
  }

  const actorOr = (c: any): string => {
    const handle = currentActor(c) ?? deps.writer?.actors()[0]?.handle
    if (!handle) throw new Error('no demonstration accounts are configured')
    return handle
  }

  if (deps.writer) {
    const writer = deps.writer

    app.post('/act-as', async (c) => {
      const form = await c.req.parseBody()
      const handle = typeof form.handle === 'string' ? form.handle : ''
      if (writer.actors().some((a) => a.handle === handle)) {
        c.header(
          'set-cookie',
          `${ACTOR_COOKIE}=${encodeURIComponent(handle)}; Path=/; HttpOnly; SameSite=Lax`,
        )
      }
      return c.redirect(c.req.header('referer') ?? '/issue', 303)
    })

    app.get('/issue', (c) => {
      const handle = actorOr(c)

      // The generated example is issued BY the acting organization, so its
      // Block 4 is that organization's own — the one thing on the form a shop
      // could not plausibly get wrong about itself.
      let prefill: Record<string, unknown> | null = null
      if (c.req.query('example') !== undefined) {
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
        issuePage({ mode, actors: writer.actors(), current: handle, prefill }),
      )
    })

    app.post('/issue', async (c) => {
      const form = await c.req.parseBody()
      const handle = actorOr(c)
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
            actors: writer.actors(),
            current: handle,
            issued: { uri: issued.uri, bundle: issued.bundle },
          }),
        )
      } catch (err) {
        return c.html(
          issuePage({
            mode,
            actors: writer.actors(),
            current: handle,
            error: describe(err),
          }),
          400,
        )
      }
    })

    app.get('/accept', (c) =>
      c.html(acceptPage({ mode, actors: writer.actors(), current: actorOr(c) })),
    )

    app.post('/accept', async (c) => {
      const form = await c.req.parseBody()
      const handle = actorOr(c)
      const get = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '')

      const uri = get('subjectUri')
      const cid = get('subjectCid')
      const outcome = get('outcome') as 'accepted' | 'rejected' | 'discrepancy'

      const fail = (msg: string) =>
        c.html(
          acceptPage({ mode, actors: writer.actors(), current: handle, error: msg }),
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
        return c.html(
          acceptPage({
            mode,
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
      const handle = actorOr(c)
      const get = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '')

      const uri = get('subjectUri')
      const cid = get('subjectCid')
      const response = get('response')

      if (!uri || !cid || !response) {
        return c.html(
          acceptPage({
            mode,
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
            actors: writer.actors(),
            current: handle,
            written: { uri: written.uri, kind: 'dispute' },
          }),
        )
      } catch (err) {
        return c.html(
          acceptPage({
            mode,
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
