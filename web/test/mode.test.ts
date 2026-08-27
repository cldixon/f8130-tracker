/**
 * Which mode this process can actually run in.
 *
 * The bug these exist for is the one config.ts opens by naming: a deployment
 * that is broken but looks healthy. Asked for live with no PDS behind it, the
 * app came up with no writer — so no issuance and no synthetic activity — and
 * an index with nothing in it. Every page rendered and the feed was empty.
 *
 * Every preview environment was in that state. They inherit F8130_MODE=live
 * from production and are cloned without the pds service, and an explicit
 * setting defeats the inference that would otherwise have picked demo.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import { resolveMode, pdsReachable } from '../src/mode.js'
import { loadConfig } from '../src/config.js'

const live = loadConfig({ F8130_MODE: 'live' } as NodeJS.ProcessEnv)
const demo = loadConfig({ F8130_MODE: 'demo' } as NodeJS.ProcessEnv)

/** A host that resolves nowhere, so the probe fails rather than hangs. */
const NOWHERE = 'http://127.0.0.1:9'

describe('resolving the mode a process can run in', () => {
  let server: Server
  let alive: string

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/xrpc/_health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ version: 'synthetic' }))
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const addr = server.address()
    alive = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  after(async () => {
    await new Promise<void>((ok) => server.close(() => ok()))
  })

  test('a PDS that answers keeps the deployment live', async () => {
    const mode = await resolveMode(live, { PDS_INTERNAL_URL: alive } as NodeJS.ProcessEnv)
    assert.equal(mode, 'live')
  })

  /**
   * The preview case, and the whole point. An environment cloned without a
   * pds service asked for live, got nothing, and served an empty feed.
   */
  test('a PDS that is not there falls back to the self-contained demonstration', async () => {
    const mode = await resolveMode(live, {
      PDS_INTERNAL_URL: NOWHERE,
      RAILWAY_ENVIRONMENT_NAME: 'f8130-tracker-pr-25',
    } as NodeJS.ProcessEnv)
    assert.equal(mode, 'demo')
  })

  test('live mode with no PDS configured at all falls back too', async () => {
    const mode = await resolveMode(live, {
      RAILWAY_ENVIRONMENT_NAME: 'f8130-tracker-pr-25',
    } as NodeJS.ProcessEnv)
    assert.equal(mode, 'demo')
  })

  /**
   * The exception that keeps the fallback honest.
   *
   * A real deployment whose PDS is briefly down at boot must not quietly start
   * serving invented records from its own domain. It stays live, read-only,
   * and says so in the log.
   */
  test('production never falls back, however unreachable its PDS is', async () => {
    const mode = await resolveMode(live, {
      PDS_INTERNAL_URL: NOWHERE,
      RAILWAY_ENVIRONMENT_NAME: 'production',
    } as NodeJS.ProcessEnv)
    assert.equal(mode, 'live')
  })

  test('demo mode is never probed and never changes', async () => {
    // No PDS_INTERNAL_URL at all: asking for demo is answered without a
    // network call, because demo mode does not depend on one.
    assert.equal(await resolveMode(demo, {} as NodeJS.ProcessEnv), 'demo')
  })

  test('the probe reports a live host and a dead one', async () => {
    assert.equal(await pdsReachable(alive), true)
    assert.equal(await pdsReachable(NOWHERE, 1000), false)
  })
})
