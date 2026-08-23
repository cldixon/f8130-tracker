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
  demoNetwork,
  type IdentityResolver,
  type RepoClient,
} from '@f8130/core'

import { ActivityGenerator } from './activity.js'
import { Dock } from './dock.js'
import { createApp } from './app.js'
import { describeConfig, loadConfig } from './config.js'
import { MemoryIndex, releaseRow } from './memory-index.js'
import type { ReadIndex } from './index-port.js'
import { PostgresIndex } from './postgres.js'
import {
  AtpRecordWriter,
  MemoryRecordWriter,
  demoActors,
  type RecordWriter,
} from './writer.js'

async function main() {
  const config = loadConfig()
  for (const line of describeConfig(config)) console.warn(line)

  const domain = process.env.PDS_HOSTNAME ?? 'f8130.cldixon.dev'

  let resolver: IdentityResolver
  let repo: RepoClient
  let demoBundles: Record<string, unknown> | null = null
  let writer: RecordWriter | null = null
  let index: ReadIndex | null = null

  if (config.mode === 'demo') {
    const { net, birth, overhaul } = await demoNetwork(domain)
    resolver = net
    repo = net

    // Demo mode gets its own index and its own writer, which together let the
    // feed and the issue form work with no Postgres and no PDS. The signatures
    // and the proofs are the real thing; only the hosting is simulated.
    const memory = new MemoryIndex()
    index = memory
    writer = new MemoryRecordWriter(net, memory, demoActors(domain))

    // The two fixture certificates were signed inside demoNetwork, before any
    // index existed, so an observer has to be told about them the same way it
    // would have learned from the firehose. Without this the front page is
    // empty until the generator produces its first event, and the part page
    // for the sample bundles has nothing to show.
    const seen = new Date(Date.now() - 60_000)
    for (const [handle, issued, prev] of [
      ['northwind-turbine.' + domain, birth, undefined],
      ['cascadia-mro.' + domain, overhaul, { uri: birth.uri, cid: String(birth.cid) }],
    ] as const) {
      memory.setHandle(issued.uri.split('/')[2]!, handle)
      memory.addRelease(
        releaseRow({
          uri: issued.uri,
          cid: String(issued.cid),
          bundle: issued.bundle,
          prev,
          observedAt: seen,
        }),
      )
    }

    demoBundles = {
      genuine: overhaul.bundle,
      birth: birth.bundle,
      tampered: {
        ...overhaul.bundle,
        values: { ...overhaul.bundle.values, remarks: 'No defects found.' },
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

  if (config.mode === 'live') {
    index = config.databaseUrl ? PostgresIndex.fromUrl(config.databaseUrl) : null

    // Writing needs a live PDS and the demonstration account password. Without
    // both, the app runs read-only rather than offering forms that cannot work.
    const pdsUrl = process.env.PDS_INTERNAL_URL
    const actPassword = process.env.SEED_ACCOUNT_PASSWORD
    if (pdsUrl && actPassword) {
      writer = new AtpRecordWriter({
        service: pdsUrl,
        password: actPassword,
        actors: demoActors(domain),
      })
      console.warn(`Issuance enabled against ${pdsUrl}`)
    } else {
      console.warn('Issuance disabled: needs PDS_INTERNAL_URL and SEED_ACCOUNT_PASSWORD.')
    }
  }

  // Synthetic activity is opt-in in live mode and on by default in demo mode.
  // The asymmetry is the point: in demo mode a generated record dies with the
  // process, and in live mode it is a permanent write to a real repository, so
  // a deployment has to ask for it.
  const wantActivity =
    process.env.F8130_ACTIVITY === '0'
      ? false
      : config.mode === 'demo' || process.env.F8130_ACTIVITY === '1'

  // Stands in for a goods-in process. Not derived from the index and not
  // derivable from it: an 8130-3 names the issuer, never the recipient.
  const dock = new Dock()

  const activity =
    wantActivity && writer
      ? new ActivityGenerator({
          writer,
          domain,
          dock,
          onError: (err) => console.warn('activity generator:', describe(err)),
        })
      : null
  if (wantActivity && !writer) {
    console.warn('Synthetic activity disabled: no write path is configured.')
  }

  const app = createApp({
    resolver,
    repo,
    index,
    demoBundles,
    mode: config.mode,
    writer,
    activity,
    dock,
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

const describe = (err: unknown) =>
  err instanceof Error ? err.message : String(err)

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
