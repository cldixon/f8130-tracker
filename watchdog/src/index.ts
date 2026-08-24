/**
 * f8130 watchdog — AppView B.
 *
 * A second reader of the same repositories, run by a different party, asking
 * questions the first one never asks — and asking them of the records
 * themselves rather than of anybody's opinion.
 *
 * That constraint is not a limitation here, it is the whole strength. The
 * network carries no accusations and never will: a party who cannot verify a
 * document cannot prove that to a third party, so there is nothing negative
 * for anyone to publish and nothing for this service to tally. What is left is
 * arithmetic over what issuers put out under their own signatures — a serial
 * with two origins, a history pointing at a record nobody can produce — and a
 * station cannot decline to participate in a check it is not being asked to
 * make.
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

import { WatchdogIndex, type IssuerRow } from './db.js'

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

const when = (d: Date | null | undefined) =>
  d?.toISOString?.().slice(0, 10) ?? '—'

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

    const [issuers, cloned, dangling] = await Promise.all([
      index.issuers(),
      index.clonedSerials(),
      index.danglingLinks(),
    ])

    return c.html(
      page(
        'Signals',
        html`<h1>Contradictions in the public record</h1>
        <p class="note">
          Everything below is arithmetic over records the issuers published
          themselves. Nobody was asked for an opinion and nobody is accused of
          anything: these are places where the record disagrees with itself, or
          where it is thinner than the rest.
        </p>

        <h2>One serial, two origins</h2>
        <p class="note">
          A part passes through many shops, so several releases naming one
          serial is an ordinary service history. More than one release claiming
          to be the part&rsquo;s <em>first</em> is not: a record with no
          predecessor asserts the part began there, and two such claims for one
          part number cannot both be true.
        </p>
        ${cloned.length === 0
          ? html`<p class="note">None observed.</p>`
          : html`<table>
              <tr><th>Part</th><th>Serial</th><th>Origin claims</th><th>Releases</th><th>Stations</th></tr>
              ${cloned.map(
                (r) => html`<tr>
                  <td>${r.partNumber}</td>
                  <td>${r.serialNumber}</td>
                  <td class="flag">${r.births}</td>
                  <td>${r.releases}</td>
                  <td>${r.stations}</td>
                </tr>`,
              )}
            </table>`}

        <h2>Histories that stop at a record nobody can produce</h2>
        <p class="note">
          A release naming a previous shop visit this observer has never seen.
          It can mean the record was never published. It can equally mean this
          index has not caught up, or was not subscribed when it went by — so
          the claim here is about what this observer holds, not about what
          exists.
        </p>
        ${dangling.length === 0
          ? html`<p class="note">None observed.</p>`
          : html`<table>
              <tr><th>Part</th><th>Serial</th><th>Issuer</th><th>Points at</th><th>Signed</th></tr>
              ${dangling.map(
                (r) => html`<tr>
                  <td>${r.partNumber}</td>
                  <td>${r.serialNumber}</td>
                  <td>${short(r.issuerDid)}</td>
                  <td class="note">${short(r.prevUri ?? r.prevCid ?? '—')}</td>
                  <td>${when(r.completedAt)}</td>
                </tr>`,
              )}
            </table>`}

        <h2>How much of each station&rsquo;s output anybody vouched for</h2>
        <p class="note">
          Two numbers, not a rate and not a score. A thin count most often
          means nobody got round to publishing a check — most releases are
          never checked in public, and a party who could not verify one has
          nothing publishable to say either. It is a shape worth looking at,
          and it is not evidence.
        </p>
        <table>
          <tr><th>Station</th><th>Releases</th><th>Checked in public</th><th>First seen</th></tr>
          ${issuers.map(
            (i) => html`<tr>
              <td><a href="/issuer/${encodeURIComponent(i.did)}">${name(i)}</a></td>
              <td>${i.releases}</td>
              <td>${i.attested} of ${i.releases}</td>
              <td class="note">${when(i.firstSeen)}</td>
            </tr>`,
          )}
        </table>

        ${peerUrl
          ? html`<p class="note">
              Every certificate counted here verifies cleanly in the other
              AppView — <a href="${peerUrl}">${peerUrl}</a> — and it is right
              to. Each document really was signed by the organization that
              claims it. Both readings are correct; they are answers to
              different questions, and no platform arbitrates between them.
            </p>`
          : ''}`,
      ),
    )
  })

  app.get('/issuer/:did', async (c) => {
    const did = c.req.param('did')
    const issuer = await index.issuer(did)
    if (!issuer) return c.html(page('Unknown', html`<h1>No such issuer observed</h1>`), 404)

    const releases = await index.releasesFor(did)

    return c.html(
      page(
        name(issuer),
        html`<h1>${name(issuer)}</h1>
        <p class="note">${issuer.did}</p>
        <p>
          ${issuer.releases} release${issuer.releases === 1 ? '' : 's'} observed ·
          ${issuer.attested} checked in public
        </p>

        <h2>Releases</h2>
        ${releases.length === 0
          ? html`<p class="note">None observed.</p>`
          : html`<table>
              <tr><th>Part</th><th>Serial</th><th>Item</th><th>Signed</th><th>Checked</th></tr>
              ${releases.map(
                (r) => html`<tr>
                  <td>${r.partNumber}</td>
                  <td>${r.serialNumber}</td>
                  <td>${r.description}</td>
                  <td>${when(r.completedAt)}</td>
                  <td>${r.attested === 0 ? html`<span class="note">—</span>` : r.attested}</td>
                </tr>`,
              )}
            </table>
            <p class="note">
              A dash means nobody has published a check on that release. It is
              not a mark against it: the network carries successes only,
              because a failed check cannot be proven to anybody.
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
