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
  AttestationRow,
  FeedEvent,
  IssuerStat,
  ReleaseRow,
} from './index-port.js'
import { bareLabel, fieldLabel } from './compose.js'
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

/**
 * How a party is named, in one place.
 *
 * Three steps, best first. The display name comes from a station record the
 * organization published, which is the answer this AppView should prefer —
 * learned from the network rather than read out of a table it ships. The
 * handle is a domain somebody proved control of: less friendly, still a name,
 * and far better to read than base32. The identifier is the last resort.
 *
 * The `h !== did` guard is the part that matters. The index stores the DID in
 * the handle column when it could not resolve one, so an unguarded fallback
 * trades one rendering of a DID for a longer one and looks, from outside,
 * exactly like the bug it was meant to fix.
 *
 * Three copies of this logic existed and they disagreed: the parts page fell
 * back to the handle, the feed and the thread page went straight to the DID.
 * That is why a receiver rendered as an identifier on one screen and a name on
 * another.
 */
export function nameParty(
  did: string,
  names: Map<string, string> | undefined,
  handles: Map<string, string> | undefined,
  didLength = 10,
): string {
  const name = names?.get(did)
  if (name) return name
  const h = handles?.get(did)
  if (h && h !== did) return h
  return short(did, didLength)
}

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
  /**
   * The document that produced this report, and who could vouch for it.
   *
   * Present only on a successful check by somebody signed in as an
   * organization. There is no failing counterpart: a party who cannot verify a
   * document cannot prove that to anyone, so the page offers nothing to
   * publish and says why.
   */
  vouch?: { subjectUri: string; subjectCid: string; actor: string } | null,
  published?: string,
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
      ${published
        ? html`<div class="verdict ok">
            <h2>Published</h2>
            <p class="mono" style="word-break:break-all">${published}</p>
            <p>It is in your repository now. The issuer cannot remove it.</p>
          </div>`
        : ''}
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

    ${published
      ? html`<div class="verdict ok" style="margin-top:1rem">
          <h2>Published</h2>
          <p class="mono" style="word-break:break-all">${published}</p>
          <p>
            It is in your repository now. The issuer cannot remove it.
          </p>
        </div>`
      : vouch
        ? html`<form method="post" action="/attest" class="card" style="margin-top:1rem">
            <input type="hidden" name="subjectUri" value="${vouch.subjectUri}">
            <input type="hidden" name="subjectCid" value="${vouch.subjectCid}">
            <h2 style="margin-top:0">Say so in public</h2>
            <p class="sub">
              Publishes a record in ${vouch.actor}&rsquo;s repository saying
              this document checked out. It names no findings and carries no
              part number — only which release you checked, and when.
            </p>
            <button type="submit">Publish an attestation</button>
          </form>`
        : report.verified
          ? ''
          : html`<div class="meta" style="margin-top:1rem">
              There is nothing to publish. A document that fails to recompute
              proves only that some document fails, and anyone can produce one,
              so a failed check is not evidence to anybody but you. Take it up
              with the issuer directly.
            </div>`}

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
  attestations: Map<string, AttestationRow[]>
  handles: Map<string, string>
  names?: Map<string, string>
  reachedBirth: boolean
  /** The live walk, when one was run. Absent means it was not attempted. */
  trace?: ChainTrace | null
  mode?: Mode
}) {
  const { chain, attestations, handles } = params
  const nameOf = (did: string) => nameParty(did, params.names, handles, 12)

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
        const checks = attestations.get(r.cid) ?? []
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
            ${checks.length > 0
              ? html`<div class="times">
                  <div>
                    <div class="label">Independently checked by</div>
                    ${checks.map(
                      (a) => html`<span>${nameOf(a.verifierDid)}</span><br>`,
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
  /** Display names from station records, same as everywhere else. */
  names?: Map<string, string>
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
            <tr><th>Issuer</th><th>Releases</th><th>Independently checked</th></tr>
            ${params.issuers.map(
              (s) => html`<tr>
                <td title="${s.did}">${nameParty(s.did, params.names, params.handles, 12)}</td>
                <td>${s.releases}</td>
                <td>
                  ${s.attested === 0 ? '—' : `${s.attested} of ${s.releases}`}
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
  /**
   * The DID the visitor is acting as, not their handle.
   *
   * It used to be the handle, compared against `handles.get(did)` — and in
   * production that map is DID-to-DID, because nothing ever wrote a real
   * handle into the index. The comparison could not be true, so no card was
   * ever marked as yours. A DID is the identity anyway; the handle is a name
   * that points at it and one more hop to get wrong.
   */
  viewer?: string,
  /** How many independent checks this observer has seen on each release. */
  replies?: Map<string, number>,
  /**
   * Display names by DID. Handles stay separate because they are the identity
   * the viewpoint check compares against, while these are only for reading.
   */
  names?: Map<string, string>,
  /** The releases attestations are about, keyed by URI. */
  subjects?: Map<string, ReleaseRow>,
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const nameOf = (did: string) => nameParty(did, names, handles)

  // What the viewpoint control changes, and all it changes: which events are
  // marked as involving you. It grants no extra visibility — the withheld
  // blocks stay withheld whoever is looking, because the index never held
  // them in the first place.
  const yours = (did: string) =>
    viewer !== undefined && did === viewer
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
            >checked by ${n}</a></div>`
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
  const t = event.attestation
  const subject = subjects?.get(t.subjectUri)
  return html`<article class="event attested" data-cid="${t.cid}">
    <div class="who">
      ${avatar(nameOf(t.verifierDid), true)}
      ${byline(t.verifierDid)} accepted this certificate
      <span class="when"><a href="${postPath(t.subjectUri)}"
        >${ago(t.verifiedAt, now)}</a></span>
    </div>

    <a class="quoted" href="${postPath(t.subjectUri)}">
      <div class="qwho">
        ${avatar(subject?.organizationName ?? nameOf(t.issuerDid), true)}
        <strong>${subject?.organizationName ?? nameOf(t.issuerDid)}</strong>
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
        : html`<div class="unseen">this observer has not seen the release itself</div>`}
    </a>
  </article>`
}

/* ------------------------------------------------------------------ thread */

/**
 * One release and everyone who has publicly checked it.
 *
 * The shape is a thread because the records are one. An attestation is a
 * record in the checker's repository carrying a strong reference to the
 * release, which is structurally what a reply is on this protocol — and the
 * consequence is the thing worth showing: the issuer whose release is at the
 * top cannot delete anything below it. They can add.
 *
 * Nothing here is a judgement this service is passing. The page offers to run
 * the checks and show them; it does not stamp a mark on the post. A mark would
 * say the platform vouches, and the whole argument is that nobody vouches.
 */
export function threadPage(params: {
  chrome?: Chrome
  mode?: Mode
  release: ReleaseRow
  attestations: AttestationRow[]
  handles: Map<string, string>
  names?: Map<string, string>
  now?: Date
}) {
  const r = params.release
  const now = params.now ?? new Date()
  const withheld = FIELDS.filter((f) => !f.public).length
  const nameOf = (did: string) => nameParty(did, params.names, params.handles)
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
        copy you hold against this record.
      </div>
    </article>

    <div class="replies">
      ${params.attestations.length === 0
        ? html`<div class="card"><div class="empty">
            Nobody has published a check on this release. That is not a mark
            against it — most releases are never checked in public, and a party
            who could not verify one has nothing publishable to say either.
          </div></div>`
        : params.attestations.map(
            (a) => html`<article class="event attested reply" data-cid="${a.cid}">
              <div class="who">
                ${avatar(nameOf(a.verifierDid), true)}
                <strong>${nameOf(a.verifierDid)}</strong> accepted this certificate
                <span class="when">${ago(a.verifiedAt, now)}</span>
              </div>
              <div class="meta">
                in <span class="mono">${handleOf(a.verifierDid)}</span>&rsquo;s own
                repository · observed here ${fmt(a.observedAt)}
              </div>
            </article>`,
          )}
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
    ? html`<h1>Receiving</h1>
      <div class="needs-actor">
        You are watching as the public, which receives nothing. Switch to an
        organization in the rail to see what is waiting for it.
      </div>`
    : html`<h1>Receiving</h1>
      <p class="sub">
        Parts delivered to ${params.actor.displayName}, with the 8130 paperwork
        that arrived in the crate. Check the document against the record issued
        by the sending station. You have the option to publicly attest that the
        record is valid.
      </p>

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
                <div class="checkrow">
                  <a class="button"
                    href="/inbox/scan?uri=${encodeURIComponent(a.subject.uri)}"
                    >Review the paperwork</a>
                </div>
              </article>`,
            )}
          </div>`}`

  return layout('Receiving', body, params.mode, params.chrome)
}

/**
 * The result of checking a document that arrived with a part.
 *
 * The same pipeline and the same stage rows as the verify page, without the
 * textarea. That absence is the point of the screen: a recipient holding a
 * crate has the paperwork already, and making them paste a file they were
 * handed is a step that exists in this application and in no warehouse.
 *
 * What is not skipped is the check. Every stage below ran against the live
 * network — the issuer's DID resolved, their repository fetched, the commit
 * signature verified against the key their DID document declares, and the
 * document recomputed to the commitment in the record. A demonstration that
 * drew a green tick without doing that would be demonstrating a green tick.
 */
/**
 * Runs the check without leaving the page, so there is something to watch.
 *
 * The bug this fixes: submitting the form navigated, which meant the browser
 * sat on a blank page for as long as the server took and the checks only
 * appeared afterwards, on the result. The one moment a visitor is waiting was
 * the one moment nothing was on screen.
 *
 * So the request is made in place and the checklist goes up immediately. The
 * seven names are real and in the order the pipeline runs them; the ticks are
 * paced by us, because the client cannot see which check the server is on and
 * saying otherwise would be inventing a fact. What arrives at the end is the
 * real report, with each stage's real result, and it replaces all of this.
 *
 * Deliberately waits for the later of the two: if the checks finish before the
 * list does the visitor still sees it through, and if the network is slow the
 * list finishes and holds. Without scripting the form submits and navigates,
 * which is where this started and still works.
 */
const VERIFY_SCRIPT = `
(function () {
  var form = document.querySelector('[data-verify]')
  if (!form || !window.fetch) return

  var CHECKS = [
    'Resolving the issuer&rsquo;s identity',
    'Fetching the release from their repository',
    'Verifying the signature against their declared key',
    'Recomputing this document&rsquo;s commitment',
    'Comparing the blocks published in the clear',
    'Checking the serial against the part',
    'Walking the history back'
  ]

  form.addEventListener('submit', function (e) {
    e.preventDefault()

    // Only the zone under the document changes. The heading, the component
    // and the form itself stay exactly where the reader left them, which is
    // what makes this read as something happening to the document in front of
    // them rather than as a page swap.
    var zone = document.querySelector('[data-zone]')
    if (!zone) return
    zone.innerHTML =
      '<div class="checking"><h2 class="sect">Verifying</h2>' +
      '<ol class="steps">' +
      CHECKS.map(function (c) {
        return '<li><span class="tick" aria-hidden="true"></span>' + c + '</li>'
      }).join('') +
      '</ol></div>'
    zone.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

    var items = zone.querySelectorAll('.steps li')
    var i = 0
    var pacedDone = false
    var markup = null

    function finish() {
      if (!pacedDone || markup === null) return
      // Into the zone, not over the page. Everything above — the heading, the
      // component, the document — is where the reader left it, and what the
      // check produced arrives underneath. The page grows rather than being
      // thrown away and rebuilt, so it can be scrolled back through.
      zone.innerHTML = markup
      // The document has been read by now and the decision is below it, so it
      // folds out of the way. It is still there and still openable.
      var sheet = document.querySelector('[data-sheet]')
      if (sheet) sheet.removeAttribute('open')
      var head = zone.querySelector('.verdict-head')
      if (head) head.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    function step() {
      if (i >= items.length) { pacedDone = true; setTimeout(finish, 200); return }
      items[i].className = 'done'
      i++
      setTimeout(step, i === 3 || i === 4 ? 560 : 340)
    }
    setTimeout(step, 200)

    fetch('/inbox/check?fragment', { method: 'POST', body: new FormData(form) })
      .then(function (r) { return r.text() })
      .then(function (h) { markup = h; finish() })
      .catch(function () {
        markup = '<div class="empty">The check could not be run.</div>'
        finish()
      })
  })
})()
`

/**
 * A certificate drawn as the document it is, read-only.
 *
 * The composer's sheet without the inputs and the record page's sheet without
 * the disclosure machinery — the same seventeen blocks in the same arrangement
 * and the same stylesheet, so a form looks like itself wherever it appears.
 *
 * Every value is present because the only caller holds the paper. There is no
 * withheld half to draw here; that distinction belongs to the record, not to
 * the document somebody was handed.
 */
export function paperSheet(values: Record<string, unknown>) {
  const cell = (field: string, span?: 2 | 4) => {
    const spec = FIELDS.find((f) => f.name === field)
    const v = values[field]
    const shown = v === null || v === undefined || v === '' ? '—' : String(v)
    const cls = ['blk', span === 2 ? 'span2' : span === 4 ? 'span4' : '']
      .filter(Boolean)
      .join(' ')
    return html`<div class="${cls}">
      <span class="n">${spec ? `Block ${spec.block}` : ''} · ${bareLabel(field)}</span>
      <span class="v">${shown}</span>
    </div>`
  }

  return html`<div class="sheet paper">
    <div class="stamp"><span>SYNTHETIC<br>NOT AN AIRWORTHINESS RECORD</span></div>
    <div class="head">
      <div class="t1">${String(values.approvingAuthority ?? 'FAA/United States')}</div>
      <div class="t2">AUTHORIZED RELEASE CERTIFICATE</div>
      <div class="t1">FAA Form 8130-3 · AIRWORTHINESS APPROVAL TAG</div>
    </div>
    <div class="grid">
      ${cell('formNumber', 2)} ${cell('workOrder', 2)}
      ${cell('organizationName', 2)} ${cell('organizationAddress', 2)}
      ${cell('item')} ${cell('description')} ${cell('partNumber')} ${cell('quantity')}
      ${cell('serialNumber', 2)} ${cell('status', 2)}
      ${cell('remarks', 4)}
      ${cell('certifyingBlock', 2)} ${cell('approvalBasis', 2)}
      ${cell('signerCert', 2)} ${cell('signerName', 2)}
      ${cell('completedAt', 4)}
    </div>
  </div>`
}

/**
 * Receiving a certificate: one page, three states.
 *
 * Received, checking, and the outcome are the same screen rather than three,
 * because they are one act. The frame holds still — the way back, the heading,
 * the component, the document — and only the block underneath changes. That is
 * what makes the checks read as something happening to the document in front
 * of you rather than as a different page that happens to mention it.
 *
 * They were separate before and the seams showed: a verdict arrived above the
 * evidence for it, the document a reader had just been studying reappeared
 * buried in the middle of the result, and the stage rows sat underneath the
 * decision they were supposed to justify.
 *
 * The document folds away once there is a result. It is the subject of the
 * page until the check runs and the outcome is the subject afterwards, so
 * leaving seventeen blocks expanded between the reader and the thing they now
 * have to decide would be keeping the wrong half open.
 *
 * Only the first two states are rendered here as such — the middle one is
 * assembled in the browser, because it exists only while a request is in
 * flight. Without scripting there are two states and a navigation between
 * them, which is the same page either way.
 */
export function receivedBody(params: {
  actor: Actor
  arrival: Arrival
  report?: VerificationReport
  published?: string
}) {
  const a = params.arrival
  const report = params.report
  // The scanned paperwork, which the recipient holds in full. Rendering it is
  // not a disclosure: the bundle came in the crate and the paper it was
  // stapled to has all seventeen blocks printed on it.
  const scanned = (a.bundle as { values?: Record<string, unknown> } | null)?.values ?? null
  const settled = Boolean(report || params.published)

  const sections = receivedSections(params)

  return html`<p class="backlink"><a href="/inbox">&larr; Receiving</a></p>
    <h1>Received 8130 Certificate</h1>
    <p class="sub">
      This is the received 8130-3 form, included in the component shipment. We
      must verify the paper document matches what the issuer submitted.
    </p>

    <h2 class="sect">The component</h2>
    ${dataplate({
      description: a.description,
      partNumber: a.partNumber,
      serialNumber: a.serialNumber,
      href: postPath(a.subject.uri),
    })}

    ${scanned
      ? html`<details class="scan sheetfold" data-sheet ${settled ? '' : 'open'}>
          <summary>Scanned 8130</summary>
          ${paperSheet(scanned)}
        </details>`
      : html`<div class="card"><div class="empty">
          No document was scanned with this shipment.
        </div></div>`}

    <div data-zone>${scanned ? sections : ''}</div>

    ${scanned && !settled ? raw(`<script>${VERIFY_SCRIPT}</script>`) : ''}`
}

/**
 * Everything below the document: the button, or what the check produced.
 *
 * Exported because the browser asks for exactly this and drops it in where the
 * button was, so the page it is already showing grows rather than being thrown
 * away and rebuilt. The full page renders the same sections in the same place,
 * which is what a visitor without scripting gets after the form navigates.
 */
export function receivedSections(params: {
  actor: Actor
  arrival: Arrival
  report?: VerificationReport
  published?: string
}) {
  const a = params.arrival
  const report = params.report
  const settled = Boolean(report || params.published)
  const verified = report ? report.verified : true

  const byName = new Map((report?.stages ?? []).map((st) => [st.name, st]))
  const sig = byName.get('signature')
  const recompute = byName.get('recompute')

  /*
   * What this observer can say about a document that did not match.
   *
   * The nine public blocks are on the record in the clear, so a disagreement
   * in one of them can be named exactly. The other eight exist on the record
   * only underneath the commitment, so the same check can establish that the
   * document is not what was published and cannot say which line is wrong —
   * the root is one hash over all seventeen and it does not decompose.
   */
  const agree = byName.get('agree')
  const named = (agree?.status === 'fail' ? (agree.data?.fields as string[]) : null) ?? []
  const recordSide = (agree?.data?.record ?? {}) as Record<string, unknown>
  const bundleSide = (agree?.data?.bundle ?? {}) as Record<string, unknown>

  // The heading is what the page is about, and that does not change as the
  // work proceeds. The outcome is a section of this page rather than a
  // replacement for it, so it carries its own heading and its own colour.
  const title = 'Received 8130 Certificate'
  const tagline = html`This is the received 8130-3 form, included in the
    component shipment. We must verify the paper document matches what the
    issuer submitted.`

  /* ------------------------------------------------ what to do about it */

  const publishedBlock = html`<div class="outcome">
    <p class="mono ref">${params.published}</p>
    <p><a href="/">Back to the feed</a> — it will appear there once an observer
      has seen it.</p>
  </div>`

  const attestBlock = html`<div class="outcome">
    <p class="caveat">
      A verified document does not mean a verified component. This process
      ensures the information on the form matches what the issuer released. We
      must still perform all required inspections on the part itself.
    </p>
    <h2 class="sect">Say so in public</h2>
    <p class="sub">
      Publishes a record in ${params.actor.displayName}&rsquo;s own repository
      saying this document checked out. It names no findings and carries no
      part number — only which release was checked, and when. The check has
      already happened either way; this is whether anybody else gets to know
      it did.
    </p>
    <div class="choose">
      <form method="post" action="/attest">
        <input type="hidden" name="subjectUri" value="${a.subject.uri}">
        <input type="hidden" name="subjectCid" value="${a.subject.cid}">
        <button type="submit">Publish an attestation</button>
      </form>
      <form method="post" action="/inbox/clear">
        <input type="hidden" name="subjectUri" value="${a.subject.uri}">
        <button type="submit" class="ghost">Accept without publishing</button>
      </form>
    </div>
    <p class="meta">
      Declining publishes nothing at all. An absence on the network is not a
      claim that anything was wrong — most checks in a real supply chain would
      never be announced.
    </p>
  </div>`

  const mismatchBlock = html`<div class="outcome">
    <div class="mismatch">
      ${named.length > 0
        ? html`<p>
              The document disagrees with the published record on
              ${named.length === 1 ? 'a block' : 'blocks'} the record carries in
              the clear, so the difference can be shown:
            </p>
            <dl class="diff">
              ${named.map(
                (f) => html`<div>
                  <dt>${fieldLabel(f)}</dt>
                  <dd>
                    <span class="was">${String(recordSide[f] ?? '—')}</span>
                    <span class="sep">published</span>
                  </dd>
                  <dd>
                    <span class="is">${String(bundleSide[f] ?? '—')}</span>
                    <span class="sep">in the crate</span>
                  </dd>
                </div>`,
              )}
            </dl>`
        : html`<p>
            The difference is in one of the eight blocks the record keeps under
            its commitment, so this observer cannot say which line is wrong —
            and neither can anyone else. The commitment is a single hash over
            all seventeen blocks; it establishes that the document is not the
            one ${a.issuerName} published, and it does not decompose into which
            part of it changed.
          </p>`}
      <p>
        There is nothing to publish. A document that fails to recompute proves
        only that some document fails, and anyone can produce one, so this is
        evidence to you and to nobody else.
      </p>
    </div>

    ${sig?.status === 'pass' && recompute?.status === 'fail'
      ? html`<div class="contrast">
          <strong>Read these two together.</strong> The signature is genuine —
          ${a.issuerName} really did sign a release for this part. The
          commitment is not: the document in this crate is no longer the one
          they signed.
        </div>`
      : ''}

    <form method="post" action="/inbox/clear" class="checkrow">
      <input type="hidden" name="subjectUri" value="${a.subject.uri}">
      <button type="submit" class="ghost">Mark as handled</button>
      <span class="meta">Takes it off your list. Nothing is published either way.</span>
    </form>
  </div>`

  /*
   * Everything the check adds, as sections rather than as a new page.
   *
   * Returned on its own to the browser, which drops it in where the button
   * was — so the heading, the component and the document stay put and the
   * page grows downwards. A reader can scroll back through the whole thing
   * afterwards and see what they did, which a page that replaced itself threw
   * away every time.
   */
  const outcome = params.published
    ? publishedBlock
    : verified
      ? attestBlock
      : mismatchBlock

  const sections = settled
    ? html`${report
        ? html`<h2 class="sect">Verification</h2>
            <div class="card">${report.stages.map(stageRow)}</div>`
        : ''}
      <h2 class="verdict-head ${verified ? 'ok' : 'no'}">
        ${params.published
          ? 'Attestation published'
          : verified
            ? 'Certificate verified'
            : 'Form does not match'}
      </h2>
      <p class="sub">
        ${params.published
          ? html`Published to ${params.actor.displayName}&rsquo;s own
              repository, under their own key. ${a.issuerName} cannot remove
              it.`
          : verified
            ? html`The 8130 form we received matches what ${a.issuerName}
                submitted to the network when they released the part.`
            : html`The 8130 form we received does not match what the issuer
                submitted to the network on release. We will need to contact
                them directly to resolve the discrepancy.`}
      </p>
      ${outcome}`
    : html`<form method="post" action="/inbox/check" class="startcheck" data-verify>
        <input type="hidden" name="subjectUri" value="${a.subject.uri}">
        <button type="submit">Verify this document</button>
      </form>`

  return sections
}

/** Nothing was published, the crate is off the list, and that is the whole of it. */
export function inboxDoneBody(params: { back: string }) {
  return html`<div class="issued">
    <h1>Handled</h1>
    <p class="sub">
      Off your list. Nothing was published — an absence on the network is not a
      claim that anything was wrong, and most checks in a real supply chain
      would never be announced.
    </p>
    <p><a href="${params.back}">Back to receiving</a></p>
  </div>`
}

export function inboxScanPage(params: {
  chrome?: Chrome
  mode?: Mode
  actor: Actor
  arrival: Arrival
}) {
  return layout('Received certificate', receivedBody(params), params.mode, params.chrome)
}

export function inboxCheckPage(params: {
  chrome?: Chrome
  mode?: Mode
  actor: Actor
  arrival: Arrival
  report?: VerificationReport
  published?: string
}) {
  const verified = params.report ? params.report.verified : true
  return layout(
    params.published ? 'Published' : verified ? 'Certificate verified' : 'Form does not match',
    receivedBody(params),
    params.mode,
    params.chrome,
  )
}

/** The body of a check, without a page around it. */
export const inboxCheckBody = receivedBody
/** The received certificate, without a page around it. */
export const inboxScanBody = receivedBody

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
    <h1>Feed</h1>
    <p class="sub">
      Every released certificate is published to the network. Upon receipt,
      receivers can opt-in to publish their verification of the returned
      certificate.
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
    // What is waiting on the dock. The rail is outside the feed, so this is
    // the one thing on the page the stream updates that is not a card — and
    // it is the point of the badge: a part arriving for you while you are
    // reading should be visible without reloading to find out.
    es.addEventListener('waiting', function (m) {
      var b = document.getElementById('waiting')
      if (!b) return
      var n = parseInt(m.data, 10)
      b.textContent = String(n)
      b.hidden = !(n > 0)
    })
  }

  function disconnect(why) {
    if (!es) return
    es.close()
    es = null
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
  return layout('Feed', body, params.mode ?? 'live', params.chrome)
}

/* ------------------------------------------------------------------ writing */

/**
 * One block of a draft, as something you can type into.
 *
 * The read-only twin of this — `block`, further down — draws a published
 * record, where a withheld field is a hash and nothing is editable. Here the
 * author holds every value because they are writing them, so all seventeen
 * are open. Which of them the network will keep is deliberately not marked:
 * that is the reveal on the next screen, and marking it here would spend it
 * early.
 *
 * The control is chosen from the field spec rather than a list kept in step by
 * hand. An enum typed into freely produces a record the lexicon rejects, and
 * the spec already knows which fields those are.
 */
function draftBlock(field: string, value: unknown, span?: 2 | 4) {
  const spec = FIELDS.find((f) => f.name === field)
  const label = bareLabel(field)
  const v = value === null || value === undefined ? '' : String(value)
  const cls = ['blk', 'edit', span === 2 ? 'span2' : span === 4 ? 'span4' : '']
    .filter(Boolean)
    .join(' ')

  const control =
    spec?.kind === 'enum'
      ? html`<select name="${field}">
          ${(spec.values ?? []).map(
            (opt) => html`<option value="${opt}" ${opt === v ? 'selected' : ''}>${opt}</option>`,
          )}
        </select>`
      : field === 'remarks'
        ? html`<textarea name="${field}" rows="2">${v}</textarea>`
        : html`<input type="${spec?.kind === 'integer' ? 'number' : 'text'}"
            name="${field}" value="${v}">`

  return html`<label class="${cls}">
    <span class="n">${spec ? `Block ${spec.block}` : ''} · ${label}</span>
    ${control}
  </label>`
}

/**
 * A generated certificate, laid out as the document and open for editing.
 *
 * Not a pixel copy of the paper — the published view is that, and it is one
 * click away once this is signed. What matters here is that a visitor is
 * editing a form rather than filling in a list of seventeen labelled inputs,
 * because the second is a chore nobody was ever going to do and the first
 * takes ten seconds.
 *
 * The certification area collapses the two paper columns into one row. On
 * paper a form uses column 13 or column 14 and leaves the other blank, which
 * is a thing to *draw* and a poor thing to type into: without scripting the
 * sheet cannot redraw when the choice changes, and a layout that lies about
 * which half is live would be worse than one that does not try.
 */
export function draftSheet(values: Record<string, unknown>) {
  return html`<div class="sheet draft">
    <div class="stamp"><span>SYNTHETIC<br>NOT AN AIRWORTHINESS RECORD</span></div>
    <div class="head">
      <div class="t1">${String(values.approvingAuthority ?? 'FAA/United States')}</div>
      <div class="t2">AUTHORIZED RELEASE CERTIFICATE</div>
      <div class="t1">FAA Form 8130-3 · AIRWORTHINESS APPROVAL TAG</div>
    </div>
    <input type="hidden" name="approvingAuthority" value="${String(values.approvingAuthority ?? 'FAA/United States')}">
    <div class="grid">
      ${draftBlock('formNumber', values.formNumber, 2)}
      ${draftBlock('workOrder', values.workOrder, 2)}
      ${draftBlock('organizationName', values.organizationName, 2)}
      ${draftBlock('organizationAddress', values.organizationAddress, 2)}
      ${draftBlock('item', values.item)}
      ${draftBlock('description', values.description)}
      ${draftBlock('partNumber', values.partNumber)}
      ${draftBlock('quantity', values.quantity)}
      ${draftBlock('serialNumber', values.serialNumber, 2)}
      ${draftBlock('status', values.status, 2)}
      ${draftBlock('remarks', values.remarks, 4)}
      ${draftBlock('certifyingBlock', values.certifyingBlock, 2)}
      ${draftBlock('approvalBasis', values.approvalBasis, 2)}
      ${draftBlock('signerCert', values.signerCert, 2)}
      ${draftBlock('signerName', values.signerName, 2)}
      ${draftBlock('completedAt', values.completedAt, 4)}
    </div>
  </div>`
}

/**
 * What the network kept, and what it did not.
 *
 * The whole argument in one screen. A visitor has just typed seventeen blocks
 * and pressed a button; this is where eight of them stop being visible to
 * anybody but whoever holds the paper. Saying it in prose beforehand never
 * landed — showing which lines went dark does.
 */
export function releasedSheet(
  values: Record<string, unknown>,
  /**
   * `all` renders every block with its value, for a reader who holds the
   * document rather than one looking at the record from outside. The two are
   * the same list; what differs is whether the withheld half is legible, and
   * that is exactly the distinction the page is about.
   */
  opts: { all?: boolean } = {},
) {
  return html`<div class="reveal">
    ${FIELDS.map((f) => {
      const v = values[f.name]
      const shown = v === null || v === undefined || v === '' ? '—' : String(v)
      return html`<div class="rev ${f.public ? 'pub' : 'priv'}">
        <span class="n">Block ${f.block} · ${bareLabel(f.name)}</span>
        <span class="v">${f.public || opts.all ? shown : 'withheld'}</span>
      </div>`
    })}
  </div>`
}

export function issuePage(params: {
  chrome?: Chrome
  mode?: Mode
  actors: Actor[]
  current?: string
  issued?: { uri: string; bundle: unknown; values: Record<string, unknown> }
  error?: string
  /** The generated draft, which is the only way this form is ever filled. */
  draft?: Record<string, unknown> | null
}) {
  const actor = params.actors.find((a) => a.handle === params.current)
  return layout(
    'Issue a release',
    issueBody({ ...params, actor }),
    params.mode,
    params.chrome,
  )
}

/**
 * The body of the issue flow, without a page around it.
 *
 * Exported so the modal and the page render the same thing. The modal fetches
 * this fragment rather than rebuilding the form in the client, which is the
 * only way the scripted and unscripted paths stay honestly identical — the
 * alternative is two templates that drift and only one of which anybody looks
 * at.
 */
export function issueBody(params: {
  actors: Actor[]
  current?: string
  actor?: Actor
  issued?: { uri: string; bundle: unknown; values: Record<string, unknown> }
  error?: string
  draft?: Record<string, unknown> | null
}) {
  const actor = params.actor ?? params.actors.find((a) => a.handle === params.current)

  if (params.issued) {
    const withheld = FIELDS.filter((f) => !f.public).length
    return html`<div class="issued">
      <h1>Released</h1>
      <p class="sub">
        Signed by ${actor?.displayName ?? 'the issuer'}&rsquo;s own server and
        published to their repository. It will reach the feed once an observer
        has seen it, which takes a moment.
      </p>

      <h2>What the network can see</h2>
      <p class="sub">
        ${FIELDS.length - withheld} of ${FIELDS.length} blocks are on the public
        record. The other ${withheld} are committed and withheld — the
        commitment proves nobody changed them, and nobody can read them without
        the document. Part and serial numbers lose their punctuation and case
        on the way, so that two shops writing one serial differently still
        write the same commitment.
      </p>
      ${releasedSheet(params.issued.values)}

      <div class="seam">
        <strong>The paper still travels with the part.</strong> Nothing here
        replaces it. What has changed is that whoever receives it can check the
        copy in their hands against what you just published, without asking you
        or anybody else.
      </div>

      <div class="card" style="padding:1.15rem">
        <div class="detail mono" style="word-break:break-all">${params.issued.uri}</div>
        <label for="out">The document — save this, it cannot be reconstructed</label>
        <textarea id="out" readonly data-uri="${params.issued.uri}"
          >${JSON.stringify(params.issued.bundle, null, 2)}</textarea>
      </div>
    </div>`
  }

  if (!actor) {
    return html`<h1>Release a certificate</h1>
      <div class="card"><div class="empty">
        Choose an organization in the header first. The public cannot sign.
      </div></div>`
  }

  return html`<h1>Release a certificate</h1>
    <p class="sub">
      A synthetic 8130-3, generated for ${actor.displayName}. Edit anything on
      it. Releasing it publishes a real signed record to a real repository —
      the data is invented, the cryptography is not.
    </p>

    ${params.error
      ? html`<div class="verdict no" style="margin:1rem 0"><h2>Could not release</h2><p>${params.error}</p></div>`
      : ''}

    <form method="post" action="/issue" class="draftform">
      ${draftSheet(params.draft ?? {})}
      <button type="submit">Release this certificate</button>
    </form>`
}

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
