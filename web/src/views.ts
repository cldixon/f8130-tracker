import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

import { FIELDS, FIELD_ORDER, PUBLIC_FIELDS } from '@f8130/core'
import type {
  ChainTrace,
  Disclosure,
  DisclosureResult,
  Stage,
  VerificationReport,
} from '@f8130/core'
import type {
  AcceptanceRow,
  DisputeRow,
  FeedEvent,
  IssuerStat,
  ReleaseRow,
} from './index-port.js'
import { bareLabel, fieldLabel, issueInputs, signingAs } from './compose.js'
import { avatar, layout, type Chrome, type Mode } from './shell.js'
import type { Arrival } from './dock.js'
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
        Checks a document against the commitment its issuer published. Nothing
        you paste is stored.
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

/**
 * A part, as a topic rather than as an account.
 *
 * The distinction earns its keep. A part has no repository, no key and no DID;
 * it cannot sign and it cannot post. Drawing it as a profile would say it is a
 * participant on the network, which is exactly the claim a central parts
 * registry makes and this design does not. What it is instead is an identifier
 * that many independent records happen to name — a topic — and its history is
 * something an observer assembles rather than something anyone holds.
 *
 * Which is why the page shows two histories and not one. On the left, what
 * this AppView indexed from the firehose. On the right, what the issuers' own
 * servers say right now, walked live. They usually agree. When they do not,
 * the network is right and the index is stale, and a buyer deciding whether to
 * pay for a part is exactly the reader who needs to be told which they are
 * looking at.
 */
export function partPage(params: {
  chrome?: Chrome
  partNumber: string
  serialNumber: string
  chain: ReleaseRow[]
  acceptances: Map<string, AcceptanceRow[]>
  handles: Map<string, string>
  names?: Map<string, string>
  reachedBirth: boolean
  /** The live walk, when one was run. Absent means it was not attempted. */
  trace?: ChainTrace | null
  mode?: Mode
}) {
  const { chain, acceptances, handles } = params
  const nameOf = (did: string) =>
    params.names?.get(did) ?? handles.get(did) ?? short(did, 12)

  const head = html`<div class="topic">
    <div class="tname">${chain[0]?.description ?? 'Unknown component'}</div>
    <dl class="ids big">
      <div><dt>P/N</dt><dd class="mono">${params.partNumber}</dd></div>
      <div><dt>S/N</dt><dd class="mono">${params.serialNumber}</dd></div>
    </dl>
    <p class="tnote">
      A part holds no repository and signs nothing. This page is assembled from
      records published independently by
      ${new Set(chain.map((r) => r.issuerDid)).size || 'no'}
      organization${new Set(chain.map((r) => r.issuerDid)).size === 1 ? '' : 's'}.
    </p>
  </div>`

  if (chain.length === 0) {
    return layout(
      `${params.partNumber} / ${params.serialNumber}`,
      html`${head}
      <div class="card"><div class="empty">
        This observer has never seen a release certificate for this part.
        That is not proof none exists — only that none has passed through here.
      </div></div>`,
      params.mode,
      params.chrome,
    )
  }

  const t = params.trace
  const agree =
    t && !t.headError
      ? t.links.length === chain.length && t.reachedBirth === params.reachedBirth
      : null

  return layout(
    `${params.partNumber} / ${params.serialNumber}`,
    html`${head}

    ${t
      ? html`<div class="compare ${agree === false ? 'differ' : ''}">
          <div>
            <span class="label">This observer indexed</span>
            <b>${chain.length} shop visit${chain.length === 1 ? '' : 's'}</b>,
            ${params.reachedBirth ? 'reaching birth' : 'stopping short of birth'}
          </div>
          <div>
            <span class="label">The issuers&rsquo; servers say, just now</span>
            ${t.headError
              ? html`<b class="flagged">could not be walked</b> — ${t.headError}`
              : html`<b>${t.links.length} shop visit${t.links.length === 1 ? '' : 's'}</b>,
                  ${t.reachedBirth ? 'reaching birth' : 'stopping short of birth'}`}
          </div>
          <p class="cnote">
            ${agree === true
              ? html`The two agree. The right-hand answer is the one that counts —
                  it was walked over the network just now, verifying each hop
                  against its own issuer&rsquo;s key, and it consulted no database.`
              : agree === false
                ? html`<strong>They disagree.</strong> The network is right and this
                    index is stale or incomplete. Nothing below is evidence; the
                    live walk is.`
                : html`The live walk did not complete, so only this observer&rsquo;s
                    stored view is shown. Treat it as a lead, not as evidence.`}
          </p>
        </div>`
      : ''}

    ${t && !t.headError && t.reason
      ? html`<div class="gap">
          <strong>The live history stops short.</strong> ${t.reason}
          ${t.missing
            ? html`<br>Missing: <span class="mono">${short(t.missing, 28)}</span>`
            : ''}
        </div>`
      : ''}

    <h2>Shop visits, newest first</h2>
    <div class="card">
      ${chain.map((r, i) => {
        const verdicts = acceptances.get(r.cid) ?? []
        return html`<div class="link">
          <div class="rail"><div class="dot"></div>${i < chain.length - 1 ? html`<div class="line"></div>` : ''}</div>
          <div class="body" style="flex:1">
            <div class="title">
              ${avatar(r.organizationName, true)}
              <a href="${postPath(r.uri)}">${r.organizationName}</a>
            </div>
            <div class="detail">
              ${nameOf(r.issuerDid)} · form <span class="mono">${r.formNumber}</span>
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
                    <div class="label">Verdicts</div>
                    ${verdicts.map(
                      (v) => html`<span class="${v.outcome === 'rejected' ? 'flagged' : ''}">
                        ${v.outcome} by ${nameOf(v.verifierDid)}
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
    params.mode,
    params.chrome,
  )
}

export function dashboardPage(params: {
  chrome?: Chrome
  issuers: IssuerStat[]
  handles: Map<string, string>
  indexAvailable: boolean
  mode?: Mode
}) {
  if (!params.indexAvailable) {
    return layout(
      'Issuers',
      html`<h1>Issuers</h1>
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
    'Issuers',
    html`<h1>Issuers</h1>
    <p class="sub">
      Every organization this observer has seen publish, verified against the
      issuer&rsquo;s own signing key.
    </p>

    <h2>Who is publishing</h2>
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
      Proves the fields you choose against the commitment the issuer already
      published, and reveals nothing else. No new signature, and no cooperation
      from the issuer.
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
          The verifier is told which fields exist and were not shown, so a
          flattering subset cannot pass as the whole form.
        </p>
      </div>
    </div>

    <h2>What this leaks</h2>
    <div class="card">
      <div class="empty">
        ${params.exposed?.length ?? 0} sibling hashes travel with the proof —
        they are how the root is recomputed. Each covers a field salted with 32
        random bytes, so none can be reversed.
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

/** at://did/collection/rkey → the permalink this app serves it at. */
export function postPath(uri: string): string {
  const parts = uri.split('/')
  const did = parts[2] ?? ''
  const rkey = parts[4] ?? ''
  return `/post/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`
}

/**
 * A part's identity, the way the industry writes it.
 *
 * It used to be a run-on line — name · number · s/n number — which read as
 * three unrelated strings separated by punctuation and tied to nothing. A part
 * is not identified that way anywhere in the trade. It is identified by its
 * nomenclature and then by two labelled numbers, P/N and S/N, which is what is
 * stamped on the component's own dataplate and what every form, every purchase
 * order and every receiving inspection repeats.
 *
 * So the labels come back. They are two characters each, they cost almost no
 * room, and they are the difference between a reader parsing a sentence and a
 * reader recognising a plate they have seen ten thousand times.
 *
 * The part number links to the part's history and the nomenclature to the
 * record, because those are two different questions — "what else happened to
 * this part" and "what does this document say" — and a reader arrives with one
 * or the other.
 */
export function dataplate(params: {
  description: string
  partNumber: string
  serialNumber: string
  /** Where the nomenclature points. Omitted on a card that is itself a link. */
  href?: string
  /** Suppresses the part-history link, for use inside another anchor. */
  flat?: boolean
  small?: boolean
}) {
  const { description, partNumber, serialNumber } = params
  const partHref = `/part/${encodeURIComponent(partNumber)}/${encodeURIComponent(serialNumber)}`

  return html`<div class="plate ${params.small ? 'sm' : ''}">
    <div class="nomen">
      ${params.href && !params.flat
        ? html`<a href="${params.href}">${description}</a>`
        : description}
    </div>
    <dl class="ids">
      <div><dt>P/N</dt><dd class="mono">
        ${params.flat
          ? partNumber
          : html`<a href="${partHref}">${partNumber}</a>`}
      </dd></div>
      <div><dt>S/N</dt><dd class="mono">${serialNumber}</dd></div>
    </dl>
  </div>`
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
  /** How many verdicts this observer has seen on each release. */
  replies?: Map<string, number>,
  /**
   * Display names by DID. Handles stay separate because they are the identity
   * the viewpoint check compares against, while these are only for reading.
   */
  names?: Map<string, string>,
  /** The releases verdicts are about, keyed by URI. */
  subjects?: Map<string, ReleaseRow>,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const nameOf = (did: string) => names?.get(did) ?? short(did, 10)

  // What the viewpoint control changes, and all it changes: which events are
  // marked as involving you. It grants no extra visibility — the withheld
  // blocks stay withheld whoever is looking, because the index never held
  // them in the first place.
  const yours = (did: string) =>
    viewer !== undefined && handles.get(did) === viewer
      ? html`<span class="mine">you</span>`
      : ''

  // The DID rides in a title rather than on the line. It is the thing that is
  // actually cryptographically meaningful, and it is also nine characters of
  // base32 that nobody reads — so it stays available on hover and on the
  // record's own page, and out of the way of the sentence.
  const byline = (did: string) =>
    html`<strong title="${did}">${nameOf(did)}</strong>${yours(did)}`

  if (event.kind === 'release') {
    const r = event.release
    const n = replies?.get(r.cid) ?? 0
    return html`<article class="event" data-cid="${r.cid}">
      <div class="who">
        ${avatar(r.organizationName, true)}
        <strong title="${r.issuerDid}">${r.organizationName}</strong>${yours(r.issuerDid)}
        issued a release certificate
        <span class="when"><a href="${postPath(r.uri)}"
          >${ago(r.completedAt, now)}</a></span>
      </div>
      ${dataplate({
        description: r.description,
        partNumber: r.partNumber,
        serialNumber: r.serialNumber,
        href: postPath(r.uri),
      })}
      ${n > 0
        ? html`<div class="meta"><a href="${postPath(r.uri)}"
            >${n} ${n === 1 ? 'verdict' : 'verdicts'}</a></div>`
        : ''}
    </article>`
  }

  /*
   * A verdict quotes the release it judges rather than describing it.
   *
   * It used to say "replying to X's release" above the card and "a part from
   * X" inside it, which named the same organization twice and still left the
   * reader without the one thing they wanted — what the part actually was.
   * Showing the release itself, embedded, says all of it once. It is also the
   * more faithful shape: a verdict is a record about another record, which is
   * a quote rather than a reply.
   */
  const v = event.verdict
  const subject = subjects?.get(v.subjectUri)
  return html`<article class="event ${v.outcome}" data-cid="${v.cid}">
    <div class="who">
      ${avatar(nameOf(v.verifierDid), true)}
      ${byline(v.verifierDid)} ${OUTCOME_WORD[v.outcome] ?? v.outcome}
      <span class="when"><a href="${postPath(v.subjectUri)}"
        >${ago(v.receivedAt, now)}</a></span>
    </div>

    ${v.note ? html`<div class="note">&ldquo;${v.note}&rdquo;</div>` : ''}

    <a class="quoted" href="${postPath(v.subjectUri)}">
      <div class="qwho">
        ${avatar(subject?.organizationName ?? nameOf(v.issuerDid), true)}
        <strong>${subject?.organizationName ?? nameOf(v.issuerDid)}</strong>
        <span class="when">
          ${subject ? html`released ${ago(subject.completedAt, now)}` : 'released'}
        </span>
      </div>
      ${subject
        ? dataplate({
            description: subject.description,
            partNumber: subject.partNumber,
            serialNumber: subject.serialNumber,
            flat: true,
            small: true,
          })
        : html`${dataplate({
              description: 'Not seen by this observer',
              partNumber: v.partNumber,
              serialNumber: v.serialNumber,
              flat: true,
              small: true,
            })}
            <div class="unseen">this observer has not seen the release itself</div>`}
    </a>
  </article>`
}

/* ------------------------------------------------------------------ thread */

/**
 * One release and everything published in answer to it.
 *
 * The shape is a thread because the records are one. A verdict is a record in
 * the verifier's repository carrying a strong reference to the release, which
 * is structurally what a reply is on this protocol — and the consequence is
 * the thing worth showing: the issuer whose release is at the top cannot
 * delete anything below it. They can add.
 *
 * Nothing here is a verdict this service is passing. The page offers to run
 * the checks and show them; it does not stamp a mark on the post. A mark would
 * say the platform vouches, and the whole argument is that nobody vouches.
 */
export function threadPage(params: {
  chrome?: Chrome
  mode?: Mode
  release: ReleaseRow
  verdicts: AcceptanceRow[]
  /** Replies to verdicts, keyed by the acceptance CID each answers. */
  replies: Map<string, DisputeRow[]>
  handles: Map<string, string>
  names?: Map<string, string>
  now?: Date
}) {
  const r = params.release
  const now = params.now ?? new Date()
  const withheld = FIELDS.filter((f) => !f.public).length
  const nameOf = (did: string) => params.names?.get(did) ?? short(did, 10)
  // Whose repository a record lives in is a claim about a DID, not about a
  // name, so this stays the identifier even where the byline is a name.
  const handleOf = (did: string) => short(did, 10)

  return layout(
    `${r.organizationName} · ${r.partNumber}`,
    html`<article class="post">
      <div class="who">
        ${avatar(r.organizationName)}
        <span class="ident">
          <strong>${r.organizationName}</strong>
          <span class="hnd mono" title="${r.issuerDid}">${short(r.issuerDid, 14)}</span>
        </span>
      </div>
      ${dataplate({
        description: r.description,
        partNumber: r.partNumber,
        serialNumber: r.serialNumber,
      })}
      <div class="pmeta">form <span class="mono">${r.formNumber}</span></div>
      <div class="ptimes">
        <div><span class="label">Completed (claimed)</span> ${fmt(r.completedAt)}</div>
        <div><span class="label">First observed here</span> ${fmt(r.observedAt)}</div>
      </div>
      <div class="pactions">
        <a class="act" href="/form?uri=${encodeURIComponent(r.uri)}">View as an 8130-3</a>
        <a class="act" href="/verify">Check a document you hold</a>
      </div>
      <div class="meta">
        ${withheld} of ${FIELDS.length} blocks are withheld. Checking compares a
        copy you hold against this record; a verdict below is a party&rsquo;s
        account of the part itself.
      </div>
    </article>

    <div class="replies">
      ${params.verdicts.length === 0
        ? html`<div class="card"><div class="empty">
            No verdict has been published on this release yet. Whoever received
            the part can publish one at any time, in their own repository.
          </div></div>`
        : params.verdicts.map((v) => {
            const answers = params.replies.get(v.cid) ?? []
            return html`<article class="event ${v.outcome} reply" data-cid="${v.cid}">
              <div class="who">
                ${avatar(nameOf(v.verifierDid), true)}
                <strong>${nameOf(v.verifierDid)}</strong>
                ${OUTCOME_WORD[v.outcome] ?? v.outcome} the part
                <span class="when">${ago(v.receivedAt, now)}</span>
              </div>
              ${v.note ? html`<div class="note">&ldquo;${v.note}&rdquo;</div>` : ''}
              <div class="meta">
                in <span class="mono">${handleOf(v.verifierDid)}</span>&rsquo;s own
                repository · observed here ${fmt(v.observedAt)}
              </div>
              ${answers.map(
                (d) => html`<article class="event answer" data-cid="${d.cid}">
                  <div class="who">
                    ${avatar(nameOf(d.authorDid), true)}
                    <strong>${nameOf(d.authorDid)}</strong> answered
                    <span class="when">${ago(d.disputedAt, now)}</span>
                  </div>
                  <div class="note">&ldquo;${d.response}&rdquo;</div>
                  <div class="meta">
                    the reply is all they can publish — the verdict above is not
                    theirs to remove
                  </div>
                </article>`,
              )}
            </article>`
          })}
    </div>`,
    params.mode,
    params.chrome,
  )
}

/* ------------------------------------------------------------------ inbox */

/**
 * Parts that arrived and have not been answered.
 *
 * The page says where this list comes from, because the honest answer is
 * interesting. It is not the network: an 8130-3 names the issuer and not the
 * recipient, so the public record cannot say what is waiting for anybody. What
 * an operator actually has is a crate on a dock, and that is what this stands
 * in for.
 *
 * Saying so is also how the next version becomes legible. Once a scheme
 * exists for fields that are committed but disclosed only to named parties —
 * the recipient being the obvious one — this list can come off the wire, and
 * the change will be a real gain in capability rather than a refactor nobody
 * can see.
 */
export function inboxPage(params: {
  chrome?: Chrome
  mode?: Mode
  actor?: Actor
  arrivals: Arrival[]
  now?: Date
}) {
  const now = params.now ?? new Date()

  const body = !params.actor
    ? html`<h1>Goods in</h1>
      <div class="needs-actor">
        You are watching as the public, which receives nothing. Switch to an
        organization in the rail to see what is waiting for it.
      </div>`
    : html`<h1>Goods in</h1>
      <p class="sub">
        Parts delivered to ${params.actor.displayName} that nobody has published
        a verdict on yet.
      </p>

      <div class="seam">
        <strong>This list is not from the network.</strong> An 8130-3 names who
        issued a release, not who received it, so this stands in for your
        goods-in process.
      </div>

      ${params.arrivals.length === 0
        ? html`<div class="card"><div class="empty">
            Nothing is waiting. Parts appear here as they are released to you.
          </div></div>`
        : html`<div class="feed">
            ${params.arrivals.map(
              (a) => html`<article class="event">
                <div class="who">
                  ${avatar(a.issuerName, true)}
                  <strong>${a.issuerName}</strong> released a part to you
                  <span class="when">${ago(a.at, now)}</span>
                </div>
                <div class="what">
                  <a href="${postPath(a.subject.uri)}">${a.description}</a>
                  · <a class="mono tag"
                      href="/part/${encodeURIComponent(a.partNumber)}/${encodeURIComponent(a.serialNumber)}"
                    >${a.partNumber}</a>
                  · s/n <span class="mono">${a.serialNumber}</span>
                </div>
                <form method="post" action="/accept" class="verdict-row">
                  <input type="hidden" name="subjectUri" value="${a.subject.uri}">
                  <input type="hidden" name="subjectCid" value="${a.subject.cid}">
                  <input type="hidden" name="from" value="inbox">
                  <select name="outcome" aria-label="Outcome">
                    <option value="accepted">accepted</option>
                    <option value="rejected">rejected</option>
                    <option value="discrepancy">discrepancy</option>
                  </select>
                  <input type="text" name="note" placeholder="Stated reason (optional)">
                  <button type="submit">Publish verdict</button>
                </form>
                <div class="meta">
                  The verdict goes in <strong>your</strong> repository under your
                  own key. ${a.issuerName} cannot delete it — only answer it.
                </div>
              </article>`,
            )}
          </div>`}`

  return layout('Goods in', body, params.mode, params.chrome)
}

/* --------------------------------------------------------------- cabinet */

/**
 * What this browser is holding.
 *
 * Rendered client-side from localStorage, because that is genuinely where the
 * documents are. The server sends an empty shell and could not fill it in if
 * it wanted to: it has never seen these bundles and must never store one.
 *
 * The demonstration that matters is on the record page rather than here — an
 * issuer opening a form they issued and finding every withheld block readable,
 * not because they are signed in but because they hold the nonces. No service
 * granted that and no service can withdraw it.
 */
export function cabinetPage(params: { chrome?: Chrome; mode?: Mode }) {
  return layout(
    'Your documents',
    html`<h1>Your documents</h1>
    <p class="sub">
      Bundles this browser is holding. A bundle opens every withheld block on
      the record it belongs to.
    </p>

    <div class="seam">
      <strong>These are not stored on this server.</strong> They are in your
      browser only. Clearing your site data deletes them, and they cannot be
      reissued.
    </div>

    <div class="card" id="cabinet">
      <div class="empty">Reading this browser&rsquo;s storage&hellip;</div>
    </div>

    <h2>What you can do with one</h2>
    <div class="pactions">
      <a class="act" href="/verify">Check a document</a>
      <a class="act" href="/disclose">Prove one field</a>
    </div>
    <p class="sub">
      Checking works on any bundle, including one somebody else handed you.
      Proving one field builds a redacted copy that opens a single block.
    </p>`,
    params.mode,
    params.chrome,
  )
}

export function feedPage(params: {
  chrome?: Chrome
  mode?: Mode
  events: FeedEvent[]
  handles: Map<string, string>
  current?: string
  /** Verdict counts by release CID, so a card can say a thread exists. */
  replies?: Map<string, number>
  /** Display names by DID, for reading rather than for identity. */
  names?: Map<string, string>
  /** The releases verdicts are about, so a verdict can quote rather than restate. */
  subjects?: Map<string, ReleaseRow>
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
      Every release and every verdict this observer has seen. Dates are what
      the document claims; the order is this observer&rsquo;s own clock.
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
      ${params.events.map((e) =>
        feedCard(
          e, params.handles, now, params.current, params.replies,
          params.names, params.subjects,
        ),
      )}
    </div>

    ${params.live
      ? html`${raw(`<script>
/*
 * The stream follows attention, not the tab.
 *
 * Holding this connection open is what tells the server somebody is watching,
 * and the generator writes a real record for every event it produces. An open
 * tab is a poor proxy for a watcher: a page left in a background window
 * overnight would keep publishing to a real repository with nobody reading a
 * line of it.
 *
 * So the connection closes when the tab is hidden and when the reader has
 * stopped interacting, and reopens on the first sign of either coming back.
 * The server needs no part in this — it already counts viewers by connection,
 * so a closed stream is an absent viewer and the generator idles on its own.
 */
(function () {
  var feed = document.getElementById('feed')
  var pulse = document.getElementById('pulse')
  var IDLE_MS = 3 * 60 * 1000
  var es = null
  var lastSeen = null
  var lastActive = Date.now()

  function render(markup) {
    var empty = document.getElementById('empty')
    if (empty) empty.parentNode.parentNode.remove()
    var wrap = document.createElement('div')
    wrap.innerHTML = markup
    var node = wrap.firstElementChild
    if (!node) return
    if (feed.querySelector('[data-cid="' + node.getAttribute('data-cid') + '"]')) return
    node.classList.add('fresh')
    feed.insertBefore(node, feed.firstChild)
    while (feed.children.length > 60) feed.removeChild(feed.lastChild)
    if (pulse) { pulse.classList.add('beat'); setTimeout(function(){ pulse.classList.remove('beat') }, 700) }
  }

  function connect() {
    if (es) return
    // Resume from the newest event this page has already drawn, so anything
    // another viewer's session produced while this one was idle still arrives.
    var url = '/api/feed/stream' + (lastSeen ? '?since=' + encodeURIComponent(lastSeen) : '')
    es = new EventSource(url)
    es.addEventListener('event', function (m) {
      lastSeen = new Date().toISOString()
      render(m.data)
    })
    es.onerror = function () { if (pulse) pulse.textContent = 'reconnecting' }
    if (pulse) { pulse.textContent = 'live'; pulse.classList.remove('idle') }
  }

  function disconnect(why) {
    if (!es) return
    es.close()
    es = null
    if (pulse) { pulse.textContent = why; pulse.classList.add('idle') }
  }

  function active() {
    lastActive = Date.now()
    if (!document.hidden) connect()
  }

  ;['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart', 'focus']
    .forEach(function (ev) { window.addEventListener(ev, active, { passive: true }) })

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) disconnect('paused')
    else active()
  })

  setInterval(function () {
    if (Date.now() - lastActive > IDLE_MS) disconnect('idle')
  }, 15000)

  connect()
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
      Fields marked private never appear on the public record. Signing is done
      by ${actor?.displayName ?? 'the issuer'}&rsquo;s own server; this service
      holds no key.
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
          <textarea id="out" readonly data-uri="${issued.uri}"
            >${JSON.stringify(issued.bundle, null, 2)}</textarea>
          <p class="sub" id="kept" hidden style="margin-top:.8rem">
            Kept in <a href="/cabinet">this browser</a> — not on this server,
            which must never hold a bundle. Clear your site data and it is gone
            for good.
          </p>
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
      Published in <em>your</em> repository, not the issuer&rsquo;s. They
      cannot delete it — only answer it.
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
      verdict, only respond to it.
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

    <!-- Lets the browser open this record with a bundle it is already
         holding. The submit happens client-side; nothing is stored here. -->
    <span id="opener" data-uri="${params.uri}"
      ${haveBundle ? 'data-open="1"' : ''}></span>
    <form method="post" action="/form" id="openWith" hidden>
      <input type="hidden" name="uri" value="${params.uri}">
      <input type="hidden" name="bundle" value="">
    </form>

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
