import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

import { FIELDS, FIELD_ORDER, PUBLIC_FIELDS } from '@f8130/core'
import type {
  Disclosure,
  DisclosureResult,
  Stage,
  VerificationReport,
} from '@f8130/core'
import type {
  AcceptanceRow,
  FeedEvent,
  IssuerStat,
  ReleaseRow,
} from './index-port.js'
import { bareLabel, fieldLabel, issueInputs, signingAs } from './compose.js'
import { avatar, layout, type Chrome, type Mode } from './shell.js'
import type { Actor } from './writer.js'

// Re-exported because the field labels are asserted against FIELD_ORDER, and
// the test should not have to know which module happens to own them.
export { fieldLabel } from './compose.js'
export { layout, type Chrome, type Mode } from './shell.js'

const fmt = (d: Date | string | null | undefined) => {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
}

const short = (s: string, n = 14) =>
  s.length <= n * 2 ? s : `${s.slice(0, n)}…${s.slice(-6)}`

function stageRow(s: Stage) {
  const evidence =
    s.data && Object.keys(s.data).length > 0
      ? html`<div class="evidence mono">${JSON.stringify(s.data)}</div>`
      : ''
  return html`<div class="stage">
    <span class="badge ${s.status}">${s.status}</span>
    <div class="body">
      <div class="title">${s.title}</div>
      <div class="detail">${s.detail}</div>
      ${evidence}
    </div>
  </div>`
}

export function verifyPage(
  mode: Mode = 'live',
  report?: VerificationReport,
  error?: string,
  chrome?: Chrome,
) {
  const form = html`<form method="post" action="/verify">
    <label for="bundle">Bundle JSON — the document as it was handed to you</label>
    <textarea id="bundle" name="bundle" placeholder='{ "uri": "at://…", "issuerHandle": "…", "values": { … }, "nonces": [ … ] }'></textarea>
    <label for="serial">Serial number stamped on the part (optional)</label>
    <input type="text" id="serial" name="serial" placeholder="SN-000417">
    <button type="submit">Verify</button>
  </form>`

  if (!report) {
    return layout(
      'Verify',
      html`<h1>Verify a release certificate</h1>
      <p class="sub">
        Checks a document against the commitment its issuer published in their
        own repository. No account required, and nothing you paste is stored.
      </p>
      ${error ? html`<div class="verdict no"><h2>Could not read that bundle</h2><p>${error}</p></div>` : ''}
      <div class="card" style="padding:1.15rem">${form}</div>`,
      mode,
      chrome,
    )
  }

  const byName = new Map(report.stages.map((s) => [s.name, s]))
  const sig = byName.get('signature')
  const recompute = byName.get('recompute')

  // The single most instructive outcome in the whole demonstration, called out
  // explicitly rather than left for the reader to infer from two adjacent rows.
  const lesson =
    sig?.status === 'pass' && recompute?.status === 'fail'
      ? html`<div class="contrast">
          <strong>Read these two together.</strong> The signature is genuine —
          ${report.issuer?.handle} really did sign a release for this part. The
          commitment is not — the document you were handed is no longer the one
          they signed. A convincing signature on an altered document is exactly
          what this design exists to separate.
        </div>`
      : ''

  return layout(
    'Verification result',
    html`<h1>Verification result</h1>
    <p class="sub">
      ${report.issuer
        ? html`Document attributed to <code>${report.issuer.handle}</code>`
        : 'Issuer could not be identified'}
    </p>

    <div class="verdict ${report.verified ? 'ok' : 'no'}">
      <h2>${report.verified ? 'Verified' : 'Not verified'}</h2>
      <p>
        ${report.verified
          ? 'Every check passed. This document is what its issuer published.'
          : 'At least one check failed. See the stages below for what and why.'}
      </p>
    </div>

    <div class="card">${report.stages.map(stageRow)}</div>
    ${lesson}

    ${report.chain.length > 0
      ? html`<h2>History as this document reports it</h2>
          <div class="card">
            ${report.chain.map(
              (l, i) => html`<div class="link">
                <div class="rail"><div class="dot"></div>${i < report.chain.length - 1 ? html`<div class="line"></div>` : ''}</div>
                <div class="body">
                  <div class="title">${l.status} · ${l.partNumber} / ${l.serialNumber}</div>
                  <div class="detail mono">${short(l.issuerDid)}</div>
                  <div class="times">
                    <div><div class="label">Completed (claimed)</div>${fmt(l.completedAt)}</div>
                  </div>
                </div>
              </div>`,
            )}
          </div>
          ${report.reachedBirth
            ? ''
            : html`<div class="gap">
                This history does not reach the part's original manufacture.
                A seller can decline to hand over a document, but they cannot
                hide that the chain stops short.
              </div>`}`
      : ''}

    <h2>Verify another</h2>
    <div class="card" style="padding:1.15rem">${form}</div>`,
    mode,
    chrome,
  )
}

export function partPage(params: {
  chrome?: Chrome
  partNumber: string
  serialNumber: string
  chain: ReleaseRow[]
  acceptances: Map<string, AcceptanceRow[]>
  handles: Map<string, string>
  reachedBirth: boolean
  mode?: Mode
}) {
  const { chain, acceptances, handles } = params

  if (chain.length === 0) {
    return layout(
      `${params.partNumber} / ${params.serialNumber}`,
      html`<h1>${params.partNumber} / ${params.serialNumber}</h1>
      <p class="sub">No records for this part have been observed.</p>
      <div class="card"><div class="empty">
        This observer has never seen a release certificate for this part.
        That is not proof none exists — only that none has passed through here.
      </div></div>`,
      params.mode,
      params.chrome,
    )
  }

  return layout(
    `${params.partNumber} / ${params.serialNumber}`,
    html`<h1>${params.partNumber} / ${params.serialNumber}</h1>
    <p class="sub">
      ${chain.length} shop visit${chain.length === 1 ? '' : 's'} observed,
      newest first. Claimed times come from the issuer; observed times come
      from this service watching the firehose.
    </p>

    <div class="card">
      ${chain.map((r, i) => {
        const verdicts = acceptances.get(r.cid) ?? []
        return html`<div class="link">
          <div class="rail"><div class="dot"></div>${i < chain.length - 1 ? html`<div class="line"></div>` : ''}</div>
          <div class="body" style="flex:1">
            <div class="title">
              <a href="/form?uri=${encodeURIComponent(r.uri)}">${r.organizationName}</a>
            </div>
            <div class="detail">
              ${handles.get(r.issuerDid) ?? r.issuerDid}
              · form <span class="mono">${r.formNumber}</span>
            </div>
            <div class="detail muted">
              work performed is committed but not published —
              <a href="/disclose">ask the holder for a disclosure</a>
            </div>
            <div class="times">
              <div><div class="label">Completed (claimed)</div>${fmt(r.completedAt)}</div>
              <div><div class="label">First observed here</div>${fmt(r.observedAt)}</div>
            </div>
            ${verdicts.length > 0
              ? html`<div class="times">
                  <div>
                    <div class="label">Operator verdicts</div>
                    ${verdicts.map(
                      (v) => html`<span class="${v.outcome === 'rejected' ? 'flagged' : ''}">
                        ${v.outcome} by ${handles.get(v.verifierDid) ?? short(v.verifierDid)}
                      </span><br>`,
                    )}
                  </div>
                </div>`
              : ''}
          </div>
        </div>`
      })}
    </div>

    ${params.reachedBirth
      ? ''
      : html`<div class="gap">
          The observed history stops before the part's original manufacture.
          The oldest record here references a predecessor
          ${chain[chain.length - 1]?.prevUri
            ? html`(<span class="mono">${short(chain[chain.length - 1]!.prevUri!, 24)}</span>)`
            : ''}
          that this observer has never seen.
        </div>`}`,
  )
}

export function dashboardPage(params: {
  chrome?: Chrome
  recent: ReleaseRow[]
  issuers: IssuerStat[]
  handles: Map<string, string>
  indexAvailable: boolean
  mode?: Mode
}) {
  if (!params.indexAvailable) {
    return layout(
      'Dashboard',
      html`<h1>Dashboard</h1>
      <p class="sub">Browsing is unavailable; verification is not.</p>
      <div class="card"><div class="empty">
        No index is configured, so there is nothing to browse. Note that
        <a href="/verify">verifying a document</a> still works: verification
        reads signed records from issuers directly and never consults this
        database.
      </div></div>`,
      params.mode,
      params.chrome,
    )
  }

  return layout(
    'Dashboard',
    html`<h1>Release certificates observed</h1>
    <p class="sub">
      Everything below was read from independent repositories over the
      firehose and verified against its issuer's signing key.
    </p>

    <h2>Recent releases</h2>
    <div class="card scroll">
      ${params.recent.length === 0
        ? html`<div class="empty">Nothing observed yet.</div>`
        : html`<table>
            <tr><th>Part</th><th>Serial</th><th>Status</th><th>Issuer</th><th>Observed</th></tr>
            ${params.recent.map(
              (r) => html`<tr>
                <td><a href="/part/${encodeURIComponent(r.partNumber)}/${encodeURIComponent(r.serialNumber)}">${r.partNumber}</a></td>
                <td class="mono">${r.serialNumber}</td>
                <td><a href="/form?uri=${encodeURIComponent(r.uri)}">${r.description}</a></td>
                <td>${params.handles.get(r.issuerDid) ?? short(r.issuerDid)}</td>
                <td>${fmt(r.observedAt)}</td>
              </tr>`,
            )}
          </table>`}
    </div>

    <h2>Issuers</h2>
    <div class="card scroll">
      ${params.issuers.length === 0
        ? html`<div class="empty">No issuers observed yet.</div>`
        : html`<table>
            <tr><th>Issuer</th><th>Releases</th><th>Independent rejections</th></tr>
            ${params.issuers.map(
              (s) => html`<tr>
                <td>${params.handles.get(s.did) ?? short(s.did)}</td>
                <td>${s.releases}</td>
                <td class="${s.distinctRejectors >= 2 ? 'flagged' : ''}">
                  ${s.distinctRejectors === 0 ? '—' : s.distinctRejectors}
                </td>
              </tr>`,
            )}
          </table>`}
    </div>`,
    params.mode,
    params.chrome,
  )
}

export function errorPage(status: number, message: string) {
  return layout(
    'Error',
    html`<h1>${status}</h1><p class="sub">${message}</p>`,
  )
}


/* ------------------------------------------------------- selective disclosure */

export function disclosePage(params: {
  chrome?: Chrome
  mode?: Mode
  fields: readonly string[]
  disclosure?: Disclosure
  result?: DisclosureResult
  exposed?: string[]
  error?: string
}) {
  const form = html`<form method="post" action="/disclose">
    <label for="bundle">Your bundle — the document you were given</label>
    <textarea id="bundle" name="bundle" placeholder='{ "uri": "at://…", … }'></textarea>
    <label>Reveal only these fields</label>
    <div class="checks">
      ${params.fields.map(
        (f) => html`<label class="check">
          <input type="checkbox" name="field" value="${f}"
            ${f === 'costCents' || f === 'completedAt' ? 'checked' : ''}>
          ${fieldLabel(f)}
        </label>`,
      )}
    </div>
    <button type="submit">Build disclosure</button>
  </form>`

  const intro = html`<h1>Prove one field, reveal nothing else</h1>
    <p class="sub">
      A lessor auditing maintenance spend needs the cost figure and has no
      business seeing the findings, the customer, or the workscope. Hand over
      the whole bundle and they hold a competitor's cost structure forever.
      A disclosure proves the chosen fields against the commitment the issuer
      already published — no new signature, and no cooperation from anyone.
    </p>`

  if (!params.disclosure) {
    return layout(
      'Selective disclosure',
      html`${intro}
      ${params.error
        ? html`<div class="verdict no"><h2>Could not build that</h2><p>${params.error}</p></div>`
        : ''}
      <div class="card" style="padding:1.15rem">${form}</div>`,
      params.mode,
      params.chrome,
    )
  }

  const d = params.disclosure
  const r = params.result

  return layout(
    'Selective disclosure',
    html`${intro}

    ${r
      ? html`<div class="verdict ${r.verified ? 'ok' : 'no'}">
          <h2>${r.verified ? 'Disclosure verifies' : 'Disclosure does not verify'}</h2>
          <p>
            ${r.verified
              ? `Every revealed field is provably part of the record ${d.issuerHandle} published.`
              : 'At least one revealed field does not match the published commitment.'}
          </p>
        </div>`
      : ''}

    <h2>Revealed</h2>
    <div class="card">
      ${(r?.fields ?? []).map(
        (f) => html`<div class="stage">
          <span class="badge ${f.verified ? 'pass' : 'fail'}">${f.verified ? 'proven' : 'bad'}</span>
          <div class="body">
            <div class="title">${fieldLabel(f.field)}</div>
            <div class="detail">${f.value === null ? '(empty)' : String(f.value)}</div>
          </div>
        </div>`,
      )}
    </div>

    <h2>Withheld</h2>
    <div class="card">
      <div class="empty">
        ${(r?.withheld ?? []).map(fieldLabel).join(' · ')}
        <p style="margin:.6rem 0 0">
          The verifier is told which fields exist and were not shown. A verifier
          who could not tell the difference could be handed a flattering subset
          and told it was the whole form.
        </p>
      </div>
    </div>

    <h2>What this leaks</h2>
    <div class="card">
      <div class="empty">
        ${params.exposed?.length ?? 0} sibling hashes travel with the proof —
        unavoidable, since they are how the root is recomputed. Each covers a
        field salted with 32 random bytes, so a status with five possible values
        still cannot be recovered from one.
        <div class="evidence mono" style="margin-top:.5rem">
          ${(params.exposed ?? []).map((h) => `${h.slice(0, 16)}…`).join('  ')}
        </div>
      </div>
    </div>

    <h2>The disclosure document</h2>
    <p class="sub">
      This is what you hand over. Search it for the findings or the customer —
      they are not in it.
    </p>
    <div class="card" style="padding:1.15rem">
      <textarea readonly>${JSON.stringify(d, null, 2)}</textarea>
    </div>

    <h2>Build another</h2>
    <div class="card" style="padding:1.15rem">${form}</div>`,
    params.mode,
    params.chrome,
  )
}


/* --------------------------------------------------------------------- feed */

const OUTCOME_WORD: Record<string, string> = {
  accepted: 'accepted',
  rejected: 'rejected',
  discrepancy: 'flagged a discrepancy on',
}

const ago = (at: Date, now: Date) => {
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/**
 * One event, as a card.
 *
 * Exported because the live stream sends the same markup rather than a second
 * client-side template: one renderer means a streamed card and a reloaded card
 * cannot drift apart.
 */
export function feedCard(
  event: FeedEvent,
  handles: Map<string, string>,
  now = new Date(),
  /** Handle of the organization being viewed as, if any. */
  viewer?: string,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  // What the viewpoint control changes, and all it changes: which events are
  // marked as involving you. It grants no extra visibility — the withheld
  // blocks stay withheld whoever is looking, because the index never held
  // them in the first place.
  const yours = (did: string) =>
    viewer !== undefined && handles.get(did) === viewer
      ? html`<span class="mine">you</span>`
      : ''

  if (event.kind === 'release') {
    const r = event.release
    const withheld = FIELDS.filter((f) => !f.public).length
    return html`<article class="event" data-cid="${r.cid}">
      <div class="who">
        <span class="dot rel"></span>
        <strong>${r.organizationName}</strong>${yours(r.issuerDid)} issued a release certificate
        <span class="when">${ago(event.at, now)}</span>
      </div>
      <div class="what">
        <a href="/form?uri=${encodeURIComponent(r.uri)}">${r.description}</a>
        · <span class="mono">${r.partNumber}</span>
        · s/n <span class="mono">${r.serialNumber}</span>
      </div>
      <div class="meta">
        ${withheld} of ${FIELDS.length} blocks committed and withheld ·
        form <span class="mono">${r.formNumber}</span>
      </div>
    </article>`
  }

  const v = event.verdict
  const verifier = handles.get(v.verifierDid) ?? v.verifierDid
  const issuer = handles.get(v.issuerDid) ?? v.issuerDid
  return html`<article class="event ${v.outcome}" data-cid="${v.cid}">
    <div class="who">
      <span class="dot ${v.outcome}"></span>
      <strong>${verifier}</strong>${yours(v.verifierDid)}
      ${OUTCOME_WORD[v.outcome] ?? v.outcome}
      a part from <strong>${issuer}</strong>${yours(v.issuerDid)}
      <span class="when">${ago(event.at, now)}</span>
    </div>
    <div class="what">
      <a href="/part/${encodeURIComponent(v.partNumber)}/${encodeURIComponent(v.serialNumber)}">
        ${v.partNumber} / ${v.serialNumber}
      </a>
    </div>
    ${v.note ? html`<div class="note">“${v.note}”</div>` : ''}
    <div class="meta">
      published in ${verifier}&rsquo;s own repository — the issuer cannot remove it
    </div>
  </article>`
}

export function feedPage(params: {
  chrome?: Chrome
  mode?: Mode
  events: FeedEvent[]
  handles: Map<string, string>
  current?: string
  /** False when there is no index to read, which is a different empty. */
  hasIndex: boolean
  live: boolean
  now?: Date
}) {
  const now = params.now ?? new Date()
  const me = params.chrome?.actors?.find((a) => a.handle === params.chrome?.current)
  const body = html`
    <h1>Activity</h1>
    <p class="sub">
      Every release and every verdict this observer has seen, newest first,
      ordered by when <em>it</em> saw them rather than by any time an issuer
      claimed.
      ${params.live
        ? html`<span class="pulse" id="pulse">live</span>`
        : ''}
    </p>

    ${!params.hasIndex
      ? html`<div class="card"><div class="empty">
          No index is attached, so there is nothing to browse. Verification
          still works — it consults no database at all.
          <a href="/verify">Check a document</a>.
        </div></div>`
      : params.events.length === 0
        ? html`<div class="card"><div class="empty" id="empty">
            Nothing observed yet. ${params.live
              ? 'Records appear here within a few seconds of being published.'
              : ''}
          </div></div>`
        : ''}

    ${me
      ? html`<a href="/issue" class="compose-row" data-compose>
          ${avatar(me.displayName, true)} Release a part…
        </a>`
      : ''}

    <div id="feed" class="feed">
      ${params.events.map((e) => feedCard(e, params.handles, now, params.current))}
    </div>

    ${params.live
      ? html`${raw(`<script>
(function () {
  var feed = document.getElementById('feed')
  var pulse = document.getElementById('pulse')
  var es = new EventSource('/api/feed/stream')
  es.addEventListener('event', function (m) {
    var empty = document.getElementById('empty')
    if (empty) empty.parentNode.parentNode.remove()
    var wrap = document.createElement('div')
    wrap.innerHTML = m.data
    var node = wrap.firstElementChild
    if (!node) return
    if (feed.querySelector('[data-cid="' + node.getAttribute('data-cid') + '"]')) return
    node.classList.add('fresh')
    feed.insertBefore(node, feed.firstChild)
    while (feed.children.length > 60) feed.removeChild(feed.lastChild)
    if (pulse) { pulse.classList.add('beat'); setTimeout(function(){ pulse.classList.remove('beat') }, 700) }
  })
  es.onerror = function () { if (pulse) pulse.textContent = 'reconnecting' }
})()
</script>`)}`
      : ''}
  `
  return layout('Activity', body, params.mode ?? 'live', params.chrome)
}

/* ------------------------------------------------------------------ writing */

export function issuePage(params: {
  chrome?: Chrome
  mode?: Mode
  actors: Actor[]
  current?: string
  issued?: { uri: string; bundle: unknown }
  error?: string
  /** A generated example, filled into the inputs. */
  prefill?: Record<string, unknown> | null
}) {
  const issued = params.issued
  const actor = params.actors.find((a) => a.handle === params.current)

  return layout(
    'Issue a release',
    html`<h1>Issue a release certificate</h1>
    <p class="sub">
      Fields marked private never appear on the public record — only inside the
      commitment. This service builds the record and hands it to
      ${actor?.displayName ?? 'the issuer'}'s own server to sign; it holds no
      signing key of its own.
    </p>

    ${signingAs(actor)}

    ${params.error
      ? html`<div class="verdict no" style="margin-top:1.25rem"><h2>Could not issue</h2><p>${params.error}</p></div>`
      : ''}

    ${issued
      ? html`<div class="verdict ok" style="margin-top:1.25rem">
          <h2>Issued</h2>
          <p>The commitment is public. The bundle below is not — deliver it to your customer.</p>
        </div>
        <div class="card" style="padding:1.15rem">
          <div class="detail mono" style="word-break:break-all">${issued.uri}</div>
          <label for="out">Bundle — save this, it cannot be reconstructed</label>
          <textarea id="out" readonly>${JSON.stringify(issued.bundle, null, 2)}</textarea>
          <p class="sub" style="margin-top:.8rem">
            Paste it into <a href="/verify">verify</a> to see it check out, or
            into <a href="/disclose">selective disclosure</a> to reveal one
            field of it.
          </p>
        </div>`
      : ''}

    <h2>New release</h2>
    <p class="sub" style="margin-bottom:.75rem">
      Seventeen blocks is a lot to type. The generator fills them from the same
      builder the seed job uses, so an example issued here is the same shape as
      the demonstration data.
    </p>
    <form method="get" action="/issue" style="margin-bottom:1rem">
      <input type="hidden" name="handle" value="${params.current ?? ''}">
      <button type="submit" name="example" value="1"
        ${actor ? '' : 'disabled'}>Generate a synthetic example</button>
    </form>

    <div class="card" style="padding:1.15rem">
      <form method="post" action="/issue">
        ${issueInputs(params.prefill ?? null)}
        <label for="prevUri">Previous release URI (optional)</label>
        <input type="text" id="prevUri" name="prevUri"
          value="${String(params.prefill?.prevUri ?? '')}" placeholder="at://…">
        <label for="prevCid">Previous release CID (optional)</label>
        <input type="text" id="prevCid" name="prevCid"
          value="${String(params.prefill?.prevCid ?? '')}" placeholder="bafyrei…">
        <button type="submit" ${actor ? '' : 'disabled'}>Sign and publish</button>
      </form>
    </div>`,
    params.mode,
    params.chrome,
  )
}

export function acceptPage(params: {
  chrome?: Chrome
  mode?: Mode
  actors: Actor[]
  current?: string
  written?: { uri: string; kind: 'acceptance' | 'dispute' }
  error?: string
}) {
  const actor = params.actors.find((a) => a.handle === params.current)

  return layout(
    'Record a verdict',
    html`<h1>Record a verdict on a part you received</h1>
    <p class="sub">
      This verdict is published in <em>your</em> repository, not the issuer's.
      They cannot delete it, and no service sits in between with the power to
      suppress it. They can only answer it.
    </p>

    ${signingAs(actor)}

    ${params.error
      ? html`<div class="verdict no" style="margin-top:1.25rem"><h2>Could not record</h2><p>${params.error}</p></div>`
      : ''}
    ${params.written
      ? html`<div class="verdict ok" style="margin-top:1.25rem">
          <h2>${params.written.kind === 'dispute' ? 'Reply published' : 'Verdict published'}</h2>
          <p class="mono" style="word-break:break-all">${params.written.uri}</p>
        </div>`
      : ''}

    <h2>Acceptance or rejection</h2>
    <div class="card" style="padding:1.15rem">
      <form method="post" action="/accept">
        <label for="subjectUri">Release URI</label>
        <input type="text" id="subjectUri" name="subjectUri" placeholder="at://…">
        <label for="subjectCid">Release CID</label>
        <input type="text" id="subjectCid" name="subjectCid" placeholder="bafyrei…">
        <label for="outcome">Outcome</label>
        <select id="outcome" name="outcome">
          <option value="accepted">accepted</option>
          <option value="rejected">rejected</option>
          <option value="discrepancy">discrepancy</option>
        </select>
        <label for="note">Stated reason</label>
        <input type="text" id="note" name="note">
        <button type="submit">Publish verdict</button>
      </form>
    </div>

    <h2>Right of reply</h2>
    <p class="sub">
      For an issuer answering a verdict against them. It cannot remove the
      verdict — only respond to it, publicly and under their own signature.
    </p>
    <div class="card" style="padding:1.15rem">
      <form method="post" action="/dispute">
        <label for="dSubjectUri">Acceptance URI</label>
        <input type="text" id="dSubjectUri" name="subjectUri" placeholder="at://…">
        <label for="dSubjectCid">Acceptance CID</label>
        <input type="text" id="dSubjectCid" name="subjectCid" placeholder="bafyrei…">
        <label for="response">Response</label>
        <input type="text" id="response" name="response">
        <button type="submit">Publish reply</button>
      </form>
    </div>`,
    params.mode,
    params.chrome,
  )
}

// ---------------------------------------------------------------- form view

export type FormFold = { label: string; hash: string; side?: 'left' | 'right' }

export type FormPageParams = {
  mode?: Mode
  chrome?: Chrome
  /** at:// URI of the release. */
  uri: string
  issuerHandle?: string
  /** The record as published, or null if it could not be fetched. */
  record: Record<string, unknown> | null
  /** Published commitment root, hex. */
  root: string | null
  /**
   * Every committed value, which exists only when the viewer holds a bundle.
   * Null is the ordinary case: a passer-by sees the nine public blocks.
   */
  values: Record<string, string | number | null> | null
  /** Leaf hashes in FIELD_ORDER, hex. Needs the nonces, so bundle-only. */
  leaves: string[] | null
  /** Constant pad leaf, hex, for the leaves that are not fields. */
  pad: string | null
  /** Whether the bundle's recomputed root equals the published one. */
  matches: boolean | null
  /** Selected field name, if the viewer clicked a block. */
  selected?: string | null
  /** The fold from the selected leaf to the root. */
  fold?: FormFold[] | null
  /**
   * Why the record could not be fetched, if it could not be.
   *
   * Kept apart from `error`: a record that will not load and a bundle that
   * will not parse are different failures with different fixes, and folding
   * them together loses whichever one is not being displayed.
   */
  fetchError?: string | null
  /**
   * The bundle JSON, echoed into a hidden field so clicking a block keeps it.
   *
   * Not a violation of the rule that no AppView stores a bundle: it is never
   * written, logged or indexed, and it travels back only to the browser that
   * just sent it. Losing it on every click would make the tree unopenable
   * exactly when the viewer has what it takes to open it.
   */
  bundleEcho?: string | null
  error?: string | null
}

/** Values that reached the public record, for the no-bundle case. */
function publicOnly(record: Record<string, unknown> | null) {
  const out: Record<string, string | number | null> = {}
  if (!record) return out
  for (const name of PUBLIC_FIELDS) {
    const v = record[name]
    if (typeof v === 'string' || typeof v === 'number') out[name] = v
  }
  return out
}

const CERT_STATEMENTS: Record<string, string> = {
  APPROVED_DESIGN_DATA:
    'and are in a condition for safe operation, in conformity to approved design data.',
  NON_APPROVED_DESIGN_DATA:
    'to non-approved design data specified in Block 12.',
  PART_43_RETURN_TO_SERVICE:
    'accomplished in accordance with 14 CFR part 43; the items are approved for return to service.',
  OTHER_REGULATION: 'in accordance with other regulation specified in Block 12.',
}

/**
 * One block of the form.
 *
 * A block with no value is not blank — it is withheld, and says so, with the
 * leaf hash where the value would be if the viewer held the bundle. Silence
 * and secrecy look identical on paper and must not here.
 */
function block(params: {
  field: string
  value: string | number | null | undefined
  known: boolean
  leaf?: string
  span?: 2 | 4
  selected: boolean
}) {
  const spec = FIELDS.find((f) => f.name === params.field)
  const label = bareLabel(params.field)
  const cls = [
    'blk',
    params.span === 2 ? 'span2' : params.span === 4 ? 'span4' : '',
    params.known ? '' : 'withheld',
    params.selected ? 'sel' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const shown = params.known
    ? params.value === '' || params.value === null || params.value === undefined
      ? html`<span class="v" style="color:var(--muted)">— left blank —</span>`
      : html`<span class="v">${String(params.value)}</span>`
    : html`<span class="v">withheld</span>
        ${params.leaf ? html`<span class="leafhash">${params.leaf}</span>` : ''}`

  return html`<button type="submit" name="field" value="${params.field}" class="${cls}">
    <span class="n">${spec ? `Block ${spec.block}` : ''} · ${label}</span>
    ${shown}
  </button>`
}

export function formPage(params: FormPageParams) {
  const known = params.values ?? publicOnly(params.record)
  const haveBundle = params.values !== null
  const has = (f: string) => haveBundle || f in known
  const val = (f: string) => known[f]
  const leafOf = (f: string) => {
    const i = FIELD_ORDER.indexOf(f)
    return params.leaves && i >= 0 ? params.leaves[i] : undefined
  }

  const blk = (field: string, span?: 2 | 4) =>
    block({
      field,
      value: val(field),
      known: has(field),
      leaf: leafOf(field),
      span,
      selected: params.selected === field,
    })

  const basis = has('approvalBasis') ? String(val('approvalBasis') ?? '') : ''
  const column = has('certifyingBlock') ? String(val('certifyingBlock') ?? '') : ''
  const conformity = column === 'CONFORMITY'
  const rts = column === 'RETURN_TO_SERVICE'

  // Which certifying column applies is itself withheld without a bundle, so
  // neither side is dimmed — a passer-by cannot tell new manufacture from a
  // return to service, which is most of what Block 11 would have told them.
  //
  // The signer's certificate number and name belong to whichever column is in
  // use — 13c/13d under conformity, 14c/14d under return to service — not one
  // to each. A form uses one column and leaves the other blank, so rendering
  // them split across both would draw a document that could not exist.
  const certSide = (isConformity: boolean) => {
    const active = isConformity ? conformity : rts
    const dim = column !== '' && !active
    const unknown = column === ''
    return html`<div class="${dim ? 'unused' : ''}">
      <div class="capt">${isConformity ? 'Block 13a — Certifies conformity' : 'Block 14a — Approval for return to service'}</div>
      <div class="stmt ${active ? 'on' : ''}">
        ${unknown
          ? html`<em style="color:var(--muted)">withheld — which column certifies is not on the public record</em>`
          : active
            ? CERT_STATEMENTS[basis] ?? basis
            : html`<span style="color:var(--muted)">not used</span>`}
      </div>
      ${active || unknown
        ? html`${blk('signerCert')}${blk('signerName')}`
        : html`<div class="blk" style="cursor:default">
            <span class="n">Blocks ${isConformity ? '13c / 13d' : '14c / 14d'}</span>
            <span class="v" style="color:var(--muted)">—</span>
          </div>`}
    </div>`
  }

  const sheet = html`<div class="sheet">
    <div class="stamp"><span>SYNTHETIC<br>NOT AN AIRWORTHINESS RECORD</span></div>
    <div class="head">
      <div class="t1">${has('approvingAuthority') ? String(val('approvingAuthority') ?? '') : 'Block 1 withheld'}</div>
      <div class="t2">AUTHORIZED RELEASE CERTIFICATE</div>
      <div class="t1">FAA Form 8130-3 · AIRWORTHINESS APPROVAL TAG</div>
    </div>
    <div class="grid">
      ${blk('formNumber', 2)} ${blk('workOrder', 2)}
      ${blk('organizationName', 2)} ${blk('organizationAddress', 2)}
      ${blk('item')} ${blk('description')} ${blk('partNumber')} ${blk('quantity')}
      ${blk('serialNumber', 2)} ${blk('status', 2)}
      ${blk('remarks', 4)}
    </div>
    <div class="cert">${certSide(true)}${certSide(false)}</div>
    <div class="grid">${blk('completedAt', 4)}</div>
  </div>`

  // The record pane, with the selected field's key highlighted.
  const recordJson = params.record
    ? JSON.stringify(params.record, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v), 2)
    : null

  const recordPane = html`<div class="pane">
    <h3>The record, as published</h3>
    ${recordJson
      ? html`<pre class="rec">${recordJson}</pre>`
      : html`<div class="body" style="color:var(--muted);font-size:.88rem">
          Could not be fetched: ${params.fetchError ?? 'unknown reason'}
        </div>`}
    <div class="body" style="border-top:1px solid var(--line);font-size:.8rem;color:var(--muted)">
      Nine of the seventeen blocks travel here. The rest are committed to and
      withheld — the commitment covers the whole form either way.
    </div>
  </div>`

  const treePane = html`<div class="pane" id="tree">
    <h3>The commitment</h3>
    <div class="body">
      ${params.root
        ? html`<div class="mono" style="word-break:break-all;font-size:.72rem">
            <span style="color:var(--muted)">root</span> ${params.root}
          </div>`
        : html`<span style="color:var(--muted)">no commitment available</span>`}

      ${params.leaves && params.pad
        ? html`
            <div style="margin:.8rem 0 .35rem;font-size:.72rem;color:var(--muted)">
              32 leaves — 17 fields, then the constant pad
            </div>
            <div class="leaves">
              ${[...Array(32)].map((_, i) => {
                const name = FIELD_ORDER[i]
                const isPad = i >= FIELD_ORDER.length
                const hash = isPad ? params.pad! : params.leaves![i]!
                const spec = name ? FIELDS.find((f) => f.name === name) : undefined
                return html`<div class="leaf ${isPad ? 'pad' : ''} ${name && name === params.selected ? 'sel' : ''}">
                  <span class="bn">${isPad ? 'pad' : spec?.block ?? ''}</span>${hash.slice(0, 6)}
                </div>`
              })}
            </div>
            ${params.fold && params.fold.length > 0
              ? html`<div class="fold">
                  <div style="color:var(--muted);font-size:.72rem;margin-bottom:.3rem">
                    Folding ${fieldLabel(params.selected ?? '')} to the root
                  </div>
                  ${params.fold.map(
                    (f) => html`<div>
                      <span class="op">${f.side ? `+ ${f.label} (${f.side})` : f.label}</span><br>${f.hash}
                    </div>`,
                  )}
                  <div class="root">
                    ${params.fold[params.fold.length - 1]!.hash === params.root
                      ? html`<span style="color:var(--pass)">✓ identical to the published root</span>`
                      : html`<span style="color:var(--fail)">✗ does not reach the published root</span>`}
                  </div>
                </div>`
              : html`<div style="margin-top:.7rem;font-size:.8rem;color:var(--muted)">
                  Choose a block above to fold its leaf up to the root.
                </div>`}
          `
        : html`<div class="inert" style="margin-top:.8rem">
            <strong>You cannot open a leaf from the commitment.</strong>
            It is one-way and inert — not a container, an index, or something
            you can expand. Its only ability is to answer yes or no to a claim
            someone else brings you. Paste the bundle below and every leaf
            becomes computable.
          </div>`}
    </div>
  </div>`

  const verdict =
    params.matches === null
      ? ''
      : params.matches
        ? html`<div class="verdict ok">
            <h2>This document opens the published commitment</h2>
            <p>Every one of the seventeen blocks recomputes to the root the
            issuer published. The paper and the record are the same document.</p>
          </div>`
        : html`<div class="verdict no">
            <h2>This document does not open the published commitment</h2>
            <p>The issuer published a commitment for this record, and these
            values are not what produces it.</p>
          </div>`

  const body = html`
    <h1>Release certificate</h1>
    <p class="sub">
      ${params.issuerHandle ? html`Issued by <strong>${params.issuerHandle}</strong> · ` : ''}
      <span class="mono" style="font-size:.8rem">${params.uri}</span>
    </p>

    ${params.fetchError
      ? html`<div class="verdict no">
          <h2>Could not load this release</h2>
          <p>${params.fetchError}</p>
        </div>`
      : ''}
    ${params.error
      ? html`<div class="verdict no">
          <h2>That bundle could not be read</h2>
          <p>${params.error}</p>
        </div>`
      : ''}
    ${verdict}

    <form method="post" action="/form">
    <input type="hidden" name="uri" value="${params.uri}">
    <input type="hidden" name="bundle" value="${params.bundleEcho ?? ''}">
    ${sheet}

    <p class="sub" style="margin:.9rem 0 1.5rem;font-size:.85rem">
      Click any block to fold its leaf up to the published root.
      ${haveBundle
        ? ''
        : html`Without the bundle only the nine public blocks have values — the
            rest are committed and withheld.`}
    </p>

    <div class="panes">${recordPane}${treePane}</div>
    </form>

    <h2>${haveBundle ? 'Open a different bundle' : 'Open it with a bundle'}</h2>
    <p class="sub" style="margin-bottom:.75rem">
      The bundle is what travels with the part: all seventeen values and all
      seventeen nonces. It is recomputed and discarded — no AppView stores one.
    </p>
    <form method="post" action="/form">
      <input type="hidden" name="uri" value="${params.uri}">
      <textarea name="bundle" placeholder="Paste the bundle JSON"></textarea>
      <button type="submit">Open the form</button>
    </form>
  `
  return layout('Release certificate', body, params.mode ?? 'live', params.chrome)
}
