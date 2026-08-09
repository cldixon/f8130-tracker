/**
 * Server bootstrap.
 *
 * Three deliberate properties. Verification works with no database — losing the
 * index degrades browsing, not the service's primary job. With no PDS
 * configured the app boots against an in-memory network preloaded with the demo
 * scenario, so the whole thing runs from a fresh clone with nothing installed
 * but Node. And a deployment carrying no environment variables at all comes up
 * in that same working state rather than in a broken-but-green one.
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
import { describeConfig, loadConfig } from './config.js'
import { PostgresIndex } from './postgres.js'
import { AtpRecordWriter, demoActors, type RecordWriter } from './writer.js'

async function main() {
  const config = loadConfig()
  for (const line of describeConfig(config)) console.warn(line)

  let resolver: IdentityResolver
  let repo: RepoClient
  let demoBundles: Record<string, unknown> | null = null

  if (config.mode === 'demo') {
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
  } else {
    resolver = new AtprotoIdentityResolver({ plcUrl: config.plcUrl })
    repo = new XrpcRepoClient()
  }

  const index = config.databaseUrl
    ? PostgresIndex.fromUrl(config.databaseUrl)
    : null

  // Writing needs a live PDS and the demonstration account password. Without
  // both, the app runs read-only rather than offering forms that cannot work.
  let writer: RecordWriter | null = null
  const pdsUrl = process.env.PDS_INTERNAL_URL
  const actPassword = process.env.SEED_ACCOUNT_PASSWORD
  if (config.mode === 'live' && pdsUrl && actPassword) {
    writer = new AtpRecordWriter({
      service: pdsUrl,
      password: actPassword,
      actors: demoActors(process.env.PDS_HOSTNAME ?? 'f8130.cldixon.dev'),
    })
    console.warn(`Issuance enabled against ${pdsUrl}`)
  } else {
    console.warn('Issuance disabled: needs live mode, PDS_INTERNAL_URL and SEED_ACCOUNT_PASSWORD.')
  }

  const app = createApp({
    resolver,
    repo,
    index,
    demoBundles,
    mode: config.mode,
    writer,
  })

  // Plenty of containers and CI runners have no IPv6 at all, and a hard-coded
  // :: turns those into an unexplained EAFNOSUPPORT at boot — so fall back
  // rather than making local development require a flag.
  const start = (host: string, onFail?: (err: NodeJS.ErrnoException) => void) => {
    const server = serve(
      { fetch: app.fetch, port: config.port, hostname: host },
      (info) => {
        console.log(`f8130 web listening on [${host}]:${info.port}`)
      },
    )
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (onFail) onFail(err)
      else {
        console.error(err)
        process.exit(1)
      }
    })
  }

  start(config.hostname, (err) => {
    if (err.code === 'EAFNOSUPPORT' && config.hostname === '::') {
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
