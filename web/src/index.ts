/**
 * Server bootstrap.
 *
 * Two deliberate properties. Verification works with no database — losing the
 * index degrades browsing, not the service's primary job. And with no PDS
 * configured the app boots against an in-memory network preloaded with the
 * demo scenario, so the whole thing runs from a fresh clone with nothing
 * installed but Node.
 */

import { serve } from '@hono/node-server'

import {
  AtprotoIdentityResolver,
  XrpcRepoClient,
  standardNetwork,
  type IdentityResolver,
  type RepoClient,
} from '@f8130/core'

import { createApp } from './app.js'
import { PostgresIndex } from './postgres.js'

const port = Number(process.env.PORT ?? 3000)

async function main() {
  let resolver: IdentityResolver
  let repo: RepoClient

  let demoBundles: Record<string, unknown> | null = null

  if (process.env.F8130_DEMO_MODE === '1') {
    const { net, birth, overhaul } = await standardNetwork()
    resolver = net
    repo = net
    demoBundles = {
      genuine: overhaul.bundle,
      birth: birth.bundle,
      tampered: {
        ...overhaul.bundle,
        values: { ...overhaul.bundle.values, findings: 'No defects found' },
      },
      forged: {
        ...overhaul.bundle,
        uri: `at://${overhaul.bundle.uri.split('/')[2]}/dev.cldixon.f8130.release/3mzzzzzzzzz2z`,
      },
    }
    console.warn(
      'DEMO MODE: serving an in-memory network. No real repositories are consulted.',
    )
    console.warn('Sample bundles: GET /demo/bundles.json')
  } else {
    resolver = new AtprotoIdentityResolver({ plcUrl: process.env.PLC_URL })
    repo = new XrpcRepoClient()
  }

  const dbUrl = process.env.DATABASE_URL
  const index = dbUrl ? PostgresIndex.fromUrl(dbUrl) : null
  if (!index) {
    console.warn(
      'No DATABASE_URL: browsing is disabled, verification is unaffected.',
    )
  }

  const app = createApp({ resolver, repo, index, demoBundles })

  // Railway's private network is IPv6-only, so :: is the right default there.
  // Plenty of containers and CI runners have no IPv6 at all, though, and a
  // hard-coded :: turns those into an unexplained EAFNOSUPPORT at boot — so
  // fall back rather than making local development require a flag.
  const hostname = process.env.HOST ?? '::'
  const start = (host: string, onFail?: (err: NodeJS.ErrnoException) => void) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      console.log(`f8130 web listening on [${host}]:${info.port}`)
    })
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (onFail) onFail(err)
      else {
        console.error(err)
        process.exit(1)
      }
    })
  }

  start(hostname, (err) => {
    if (err.code === 'EAFNOSUPPORT' && hostname === '::') {
      console.warn('no IPv6 available; falling back to 0.0.0.0')
      start('0.0.0.0')
      return
    }
    console.error(err)
    process.exit(1)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
