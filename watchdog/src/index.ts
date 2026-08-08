/**
 * f8130 watchdog — AppView B.
 *
 * A second reader of the same repositories, run by a different party, asking a
 * question the first one never asks: which issuers keep having their parts
 * refused, by operators who do not know each other?
 *
 * It has no relationship with AppView A. No shared database, no shared code, no
 * API between them, no agreement of any kind. It reaches the firehose over the
 * public internet like any stranger would, because it is one. That it can exist
 * at all — without asking permission, without being granted access, without
 * anyone having the standing to switch it off — is the property this whole
 * demonstration is built to show.
 *
 * Deliberately plain. The point is not that this is a nice application; the
 * point is that a rival interpretation of the same public record is a weekend's
 * work rather than a negotiation.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { html, raw } from 'hono/html'

import { FLAG_THRESHOLD, WatchdogIndex, type IssuerRow } from './db.js'

const port = Number(process.env.PORT ?? 3000)
const databaseUrl = process.env.DATABASE_URL
const peerUrl = process.env.PEER_APPVIEW_URL ?? ''

const STYLE = `
body { font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
       max-width: 54rem; margin: 2rem auto; padding: 0 1rem;
       background: #fff; color: #111; }
@media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } a { color: #8ab4f8; } }
h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8884; font-size: .9rem; }
th { font-weight: 700; text-transform: uppercase; font-size: .7rem; letter-spacing: .05em; }
.flag { font-weight: 700; }
.note { opacity: .7; font-size: .85rem; }
hr { border: 0; border-top: 1px solid #8884; margin: 2rem 0; }
`

const page = (title: string, body: unknown) => html`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — f8130 watchdog</title><style>${raw(STYLE)}</style></head>
<body>
<p class="note">
  <strong>f8130 watchdog</strong> — an independent reader of public
  AT&nbsp;Protocol records. SYNTHETIC DEMONSTRATION DATA.
</p>
${body}
<hr>
<p class="note">
  This service holds no agreement with the issuers it describes, and none with
  the other AppView reading the same records. It subscribes to a public
  firehose, keeps its own index, and applies its own rule. Nobody granted it
  permission and nobody can withdraw it.
</p>
</body></html>`

const short = (s: string) => (s.length > 28 ? `${s.slice(0, 20)}…${s.slice(-6)}` : s)
const name = (i: { handle: string | null; did: string }) => i.handle ?? short(i.did)

function verdict(i: IssuerRow): string {
  if (i.distinctRejectors >= FLAG_THRESHOLD) return 'FLAGGED'
  if (i.distinctRejectors === 1) return 'one rejection'
  return 'no rejections observed'
}

async function main() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const index = WatchdogIndex.fromUrl(databaseUrl)
  const app = new Hono()

  app.get('/health', async (c) =>
    c.json({ ok: true, indexed: await index.ready(), cursor: await index.cursor() }),
  )

  app.get('/', async (c) => {
    if (!(await index.ready())) {
      return c.html(
        page(
          'Waiting',
          html`<h1>Nothing indexed yet</h1>
          <p class="note">
            This AppView's own firehose consumer has not yet seen any records.
            It is not waiting on anyone's permission — only on data.
          </p>`,
        ),
      )
    }

    const issuers = await index.issuers()
    const flagged = issuers.filter((i) => i.distinctRejectors >= FLAG_THRESHOLD)

    return c.html(
      page(
        'Issuers',
        html`<h1>Issuers by independent rejection</h1>
        <p class="note">
          Ranked by how many <em>distinct</em> operators refused a part. One
          operator refusing repeatedly is a commercial dispute. Several
          unrelated operators refusing independently is a pattern — and it is a
          pattern none of them could see alone, because today each rejection
          dies inside the shop that made it.
        </p>

        ${flagged.length > 0
          ? html`<p class="flag">
              ${flagged.length} issuer${flagged.length === 1 ? '' : 's'} flagged
              at ${FLAG_THRESHOLD}+ independent rejectors:
              ${flagged.map((f) => name(f)).join(', ')}.
            </p>`
          : html`<p class="note">No issuer has reached the flag threshold.</p>`}

        <table>
          <tr>
            <th>Issuer</th><th>Releases</th><th>Distinct rejectors</th>
            <th>Total rejections</th><th>Verdict</th>
          </tr>
          ${issuers.map(
            (i) => html`<tr>
              <td><a href="/issuer/${encodeURIComponent(i.did)}">${name(i)}</a></td>
              <td>${i.releases}</td>
              <td class="${i.distinctRejectors >= FLAG_THRESHOLD ? 'flag' : ''}">${i.distinctRejectors}</td>
              <td>${i.totalRejections}</td>
              <td class="${i.distinctRejectors >= FLAG_THRESHOLD ? 'flag' : ''}">${verdict(i)}</td>
            </tr>`,
          )}
        </table>

        ${peerUrl
          ? html`<p class="note">
              Every certificate counted here verifies cleanly in the other
              AppView — <a href="${peerUrl}">${peerUrl}</a> — and it is right to.
              Each document really was signed by the organization that claims it.
              Both readings are correct; they are answers to different questions,
              and no platform arbitrates between them.
            </p>`
          : ''}`,
      ),
    )
  })

  app.get('/issuer/:did', async (c) => {
    const did = c.req.param('did')
    const issuer = await index.issuer(did)
    if (!issuer) return c.html(page('Unknown', html`<h1>No such issuer observed</h1>`), 404)

    const rejections = await index.rejectionsFor(did)
    const distinct = new Set(rejections.map((r) => r.verifierDid))

    return c.html(
      page(
        name(issuer),
        html`<h1>${name(issuer)}</h1>
        <p class="note">${issuer.did}</p>
        <p>
          ${issuer.releases} release${issuer.releases === 1 ? '' : 's'} observed ·
          <span class="${distinct.size >= FLAG_THRESHOLD ? 'flag' : ''}">
            ${distinct.size} independent rejector${distinct.size === 1 ? '' : 's'}
          </span>
        </p>

        <h2>Rejections</h2>
        ${rejections.length === 0
          ? html`<p class="note">None observed.</p>`
          : html`<table>
              <tr><th>Operator</th><th>Part</th><th>Outcome</th><th>Stated reason</th><th>Observed</th></tr>
              ${rejections.map(
                (r) => html`<tr>
                  <td>${short(r.verifierDid)}</td>
                  <td>${r.partNumber}/${r.serialNumber}</td>
                  <td class="flag">${r.outcome}</td>
                  <td>${r.note ?? '—'}</td>
                  <td>${r.observedAt?.toISOString?.().slice(0, 19).replace('T', ' ') ?? '—'}</td>
                </tr>`,
              )}
            </table>
            <p class="note">
              Each verdict above was published by the operator into their own
              repository. The issuer cannot delete them, and no service sits in
              between with the power to suppress them.
            </p>`}`,
      ),
    )
  })

  const start = (host: string, onFail?: (e: NodeJS.ErrnoException) => void) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info) =>
      console.log(`watchdog listening on [${host}]:${info.port}`),
    )
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (onFail) onFail(err)
      else {
        console.error(err)
        process.exit(1)
      }
    })
  }
  start(process.env.HOST ?? '::', (err) => {
    if (err.code === 'EAFNOSUPPORT') {
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
