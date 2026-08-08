import { Hono } from 'hono'

import {
  parseBundle,
  verifyBundle,
  type IdentityResolver,
  type RepoClient,
} from '@f8130/core'

import type { AcceptanceRow, ReadIndex, ReleaseRow } from './index-port.js'
import { dashboardPage, errorPage, partPage, verifyPage } from './views.js'

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
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.get('/api/health', (c) =>
    c.json({ ok: true, index: Boolean(deps.index) }),
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
      dashboardPage({ recent, issuers, handles, indexAvailable: true }),
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
      }),
    )
  })

  // --------------------------------------------------------------- verify
  app.get('/verify', (c) => c.html(verifyPage()))

  app.post('/verify', async (c) => {
    const form = await c.req.parseBody()
    const raw = typeof form.bundle === 'string' ? form.bundle : ''
    const serial = typeof form.serial === 'string' ? form.serial.trim() : ''

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return c.html(verifyPage(undefined, 'That is not valid JSON.'), 400)
    }

    try {
      const bundle = parseBundle(parsed)
      const report = await verifyBundle({
        bundle,
        stampedSerial: serial || undefined,
        resolver: deps.resolver,
        repo: deps.repo,
      })
      return c.html(verifyPage(report))
    } catch (err) {
      return c.html(verifyPage(undefined, describe(err)), 400)
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
    partNumber: r.partNumber,
    serialNumber: r.serialNumber,
    status: r.status,
    formNumber: r.formNumber,
    signerCert: r.signerCert,
    completedAt: r.completedAt,
    observedAt: r.observedAt,
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
