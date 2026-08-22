import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

import { FIELDS } from '@f8130/core'
import type {
  Disclosure,
  DisclosureResult,
  Stage,
  VerificationReport,
} from '@f8130/core'
import type { AcceptanceRow, IssuerStat, ReleaseRow } from './index-port.js'
import type { Actor } from './writer.js'

const STYLES = `
:root {
  --bg: #fbfbfa; --fg: #1a1a19; --muted: #6b6b68; --line: #e2e2df;
  --card: #ffffff; --pass: #1a7f47; --fail: #b3261e; --warn: #8a6100;
  --skip: #8a8a86; --accent: #2c5aa0;
  --pass-bg: #eaf5ee; --fail-bg: #fdecea; --warn-bg: #fdf5e3; --skip-bg: #f4f4f2;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16161a; --fg: #e8e8e6; --muted: #9a9a96; --line: #2e2e34;
    --card: #1e1e23; --pass: #6cc48d; --fail: #f2857c; --warn: #e0b354;
    --skip: #7a7a78; --accent: #86aae8;
    --pass-bg: #17301f; --fail-bg: #351b19; --warn-bg: #33290f; --skip-bg: #232328;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 62rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
a { color: var(--accent); }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
h2 { font-size: 1.05rem; margin: 2rem 0 .75rem; letter-spacing: -0.01em; }
.sub { color: var(--muted); margin: 0 0 1.75rem; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
nav { border-bottom: 1px solid var(--line); background: var(--card); }
nav div { max-width: 62rem; margin: 0 auto; padding: .8rem 1.25rem; display: flex; gap: 1.25rem; align-items: baseline; }
nav strong { letter-spacing: -0.02em; }
nav a { text-decoration: none; color: var(--muted); font-size: .92rem; }
nav a:hover { color: var(--fg); }

.banner {
  background: var(--warn-bg); border: 1px solid var(--line);
  border-left: 3px solid var(--warn);
  padding: .6rem .8rem; border-radius: 4px; font-size: .85rem;
  color: var(--fg); margin-bottom: 1.5rem;
}
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.demo {
  background: var(--skip-bg); border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  padding: .6rem .8rem; border-radius: 4px; font-size: .85rem;
  margin-bottom: 1.5rem;
}

/* verification stages */
.verdict { padding: 1rem 1.15rem; border-radius: 8px; margin-bottom: 1.25rem; border: 1px solid var(--line); }
.verdict.ok { background: var(--pass-bg); border-left: 3px solid var(--pass); }
.verdict.no { background: var(--fail-bg); border-left: 3px solid var(--fail); }
.verdict h2 { margin: 0 0 .2rem; font-size: 1.15rem; }
.verdict p { margin: 0; color: var(--muted); font-size: .92rem; }

.stage { display: flex; gap: .9rem; padding: .85rem 1.15rem; border-bottom: 1px solid var(--line); }
.stage:last-child { border-bottom: 0; }
.stage .badge {
  flex: 0 0 auto; width: 4.4rem; text-align: center; align-self: flex-start;
  font-size: .68rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  padding: .2rem 0; border-radius: 3px;
}
.badge.pass { color: var(--pass); background: var(--pass-bg); }
.badge.fail { color: var(--fail); background: var(--fail-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.skipped { color: var(--skip); background: var(--skip-bg); }
.stage .body { min-width: 0; }
.stage .title { font-weight: 600; font-size: .93rem; }
.stage .detail { color: var(--muted); font-size: .88rem; margin-top: .12rem; }
.stage .evidence { margin-top: .4rem; font-size: .78rem; color: var(--muted); word-break: break-all; }

/* the lesson: a real signature over a document that has since changed */
.contrast {
  margin-top: 1.25rem; padding: .85rem 1.15rem; border-radius: 6px;
  background: var(--fail-bg); border: 1px dashed var(--fail); font-size: .89rem;
}
.contrast strong { color: var(--fail); }

/* timeline */
.link { display: flex; gap: 1rem; padding: 1rem 1.15rem; border-bottom: 1px solid var(--line); }
.link:last-child { border-bottom: 0; }
.link .rail { flex: 0 0 auto; width: .6rem; display: flex; flex-direction: column; align-items: center; }
.link .dot { width: .6rem; height: .6rem; border-radius: 50%; background: var(--accent); margin-top: .45rem; }
.link .line { flex: 1; width: 1px; background: var(--line); }
.times { display: flex; gap: 1.75rem; margin-top: .5rem; flex-wrap: wrap; }
.times div { font-size: .78rem; }
.times .label { color: var(--muted); text-transform: uppercase; letter-spacing: .05em; font-size: .68rem; }
.gap { background: var(--fail-bg); border: 1px dashed var(--fail); border-radius: 6px; padding: .85rem 1.15rem; margin-top: 1rem; font-size: .89rem; }

table { width: 100%; border-collapse: collapse; font-size: .89rem; }
th { text-align: left; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: .6rem 1.15rem; border-bottom: 1px solid var(--line); font-weight: 600; }
td { padding: .65rem 1.15rem; border-bottom: 1px solid var(--line); }
tr:last-child td { border-bottom: 0; }
.flagged { color: var(--fail); font-weight: 600; }
.scroll { overflow-x: auto; }

textarea { width: 100%; min-height: 11rem; font-family: ui-monospace, monospace; font-size: .82rem;
  padding: .75rem; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
input[type=text] { padding: .5rem .65rem; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); font-size: .9rem; width: 100%; max-width: 22rem; }
label { display: block; font-size: .8rem; color: var(--muted); margin: 1rem 0 .3rem; }
button { margin-top: 1.15rem; padding: .55rem 1.1rem; font-size: .92rem; font-weight: 600;
  border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
footer { border-top: 1px solid var(--line); margin-top: 3rem; padding-top: 1rem;
  color: var(--muted); font-size: .78rem; }
.empty { padding: 1.5rem 1.15rem; color: var(--muted); font-size: .9rem; }
.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .3rem .8rem; margin-top: .4rem; }
.check { display: flex; align-items: center; gap: .4rem; margin: 0; font-size: .85rem; color: var(--fg); }
.check input { margin: 0; }
select { padding: .5rem .65rem; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); font-size: .9rem; max-width: 22rem; width: 100%; }
.hint { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em;
  color: var(--accent); border: 1px solid var(--line); border-radius: 3px; padding: 0 .3rem; }
.persona { display: flex; gap: .6rem; align-items: flex-end; flex-wrap: wrap; }
.persona label { margin: 0 0 .3rem; }
.persona button { margin-top: 0; }
`

export type Mode = 'demo' | 'live'

export function layout(
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  mode: Mode = 'live',
) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · f8130</title>
<style>${raw(STYLES)}</style>
</head>
<body>
<nav><div>
  <strong>f8130</strong>
  <a href="/">Dashboard</a>
  <a href="/verify">Verify a document</a>
  <a href="/disclose">Selective disclosure</a>
  <a href="/issue">Issue</a>
</div></nav>
<main>
  <div class="banner">
    <strong>Synthetic demonstration data.</strong>
    Fictional organizations and non-existent part numbers. Not an
    airworthiness system, and not an approved method for one.
  </div>
  ${mode === 'demo'
    ? html`<div class="demo">
        <strong>Demo instance.</strong> This server is not reading the real
        AT Protocol network — it runs an in-memory one with real signing keys
        and real proofs, so the cryptography below is genuine while the hosting
        is simulated. Sample documents:
        <a href="/demo/bundles.json">/demo/bundles.json</a>.
      </div>`
    : ''}
  ${body}
  <footer>
    SYNTHETIC DATA — demonstration only. Records are read from independent
    AT Protocol repositories; this service holds no signing keys and is not
    the source of truth for anything shown.
  </footer>
</main>
</body>
</html>`
}

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
  )
}

export function partPage(params: {
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
            <div class="title">${r.organizationName}</div>
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
                <td>${r.description}</td>
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
  )
}

export function errorPage(status: number, message: string) {
  return layout(
    'Error',
    html`<h1>${status}</h1><p class="sub">${message}</p>`,
  )
}


/* ------------------------------------------------------- selective disclosure */

/**
 * Human names for the committed fields.
 *
 * Every entry corresponds to a numbered block on FAA Form 8130-3, and
 * `fieldLabel` prefixes the block so the page and the paper form can be read
 * side by side. A test asserts this table covers FIELD_ORDER, because a field
 * with no label renders as a camelCase identifier and nobody notices.
 */
const FIELD_LABELS: Record<string, string> = {
  approvingAuthority: 'Approving authority',
  formNumber: 'Form tracking number',
  organizationName: 'Organization name',
  organizationAddress: 'Organization address',
  workOrder: 'Work order / contract / invoice',
  item: 'Item',
  description: 'Description',
  partNumber: 'Part number',
  quantity: 'Quantity',
  serialNumber: 'Serial number',
  status: 'Status / work',
  remarks: 'Remarks',
  certifyingBlock: 'Certifying block',
  approvalBasis: 'Approval basis',
  signerCert: 'Approval / certificate no.',
  signerName: 'Name',
  completedAt: 'Date',
}

/** "Block 4 · Organization name", falling back to the raw name. */
export function fieldLabel(name: string): string {
  const label = FIELD_LABELS[name] ?? name
  const spec = FIELDS.find((f) => f.name === name)
  return spec ? `Block ${spec.block} · ${label}` : label
}

export function disclosePage(params: {
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
  )
}


/* ------------------------------------------------------------------ writing */

const RELEASE_FIELDS: { name: string; label: string; type: 'text' | 'number' | 'enum'; hint?: string }[] = [
  { name: 'formNumber', label: 'Form number', type: 'text' },
  { name: 'partNumber', label: 'Part number', type: 'text' },
  { name: 'serialNumber', label: 'Serial number', type: 'text' },
  { name: 'description', label: 'Description', type: 'text' },
  { name: 'status', label: 'Status', type: 'enum' },
  { name: 'quantity', label: 'Quantity', type: 'number' },
  { name: 'workOrder', label: 'Work order', type: 'text' },
  { name: 'findings', label: 'Findings', type: 'text', hint: 'private' },
  { name: 'workscope', label: 'Workscope', type: 'text', hint: 'private' },
  { name: 'costCents', label: 'Cost in cents', type: 'number', hint: 'private' },
  { name: 'customer', label: 'Customer', type: 'text', hint: 'private' },
  { name: 'signerCert', label: 'Signer certificate', type: 'text' },
  { name: 'signerName', label: 'Signer name', type: 'text', hint: 'private' },
  { name: 'remarks', label: 'Remarks', type: 'text', hint: 'private' },
  { name: 'completedAt', label: 'Completed at (RFC 3339 UTC)', type: 'text' },
]

const STATUSES = ['NEW', 'OVERHAULED', 'REPAIRED', 'INSPECTED', 'MODIFIED']

function personaPicker(actors: Actor[], current?: string) {
  return html`<form method="post" action="/act-as" class="persona">
    <label for="actor">Acting as</label>
    <select id="actor" name="handle">
      ${actors.map(
        (a) => html`<option value="${a.handle}" ${a.handle === current ? 'selected' : ''}>
          ${a.displayName} (${a.kind})
        </option>`,
      )}
    </select>
    <button type="submit">Switch</button>
  </form>`
}

export function issuePage(params: {
  mode?: Mode
  actors: Actor[]
  current?: string
  issued?: { uri: string; bundle: unknown }
  error?: string
}) {
  const issued = params.issued

  return layout(
    'Issue a release',
    html`<h1>Issue a release certificate</h1>
    <p class="sub">
      Fields marked private never appear on the public record — only inside the
      commitment. This service builds the record and hands it to
      ${params.current ?? 'the issuer'}'s own server to sign; it holds no
      signing key of its own.
    </p>

    <div class="banner">
      <strong>Persona switcher, not a login.</strong> Anyone may act as any
      demonstration organization here. Real issuance would authenticate the
      individual holding the certificate.
    </div>

    <div class="card" style="padding:1.15rem">${personaPicker(params.actors, params.current)}</div>

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
    <div class="card" style="padding:1.15rem">
      <form method="post" action="/issue">
        ${RELEASE_FIELDS.map((f) =>
          f.type === 'enum'
            ? html`<label for="${f.name}">${f.label}</label>
                <select id="${f.name}" name="${f.name}">
                  ${STATUSES.map((s) => html`<option value="${s}">${s}</option>`)}
                </select>`
            : html`<label for="${f.name}">
                  ${f.label}${f.hint ? html` <span class="hint">${f.hint}</span>` : ''}
                </label>
                <input type="${f.type === 'number' ? 'number' : 'text'}"
                  id="${f.name}" name="${f.name}">`,
        )}
        <label for="prevUri">Previous release URI (optional)</label>
        <input type="text" id="prevUri" name="prevUri" placeholder="at://…">
        <label for="prevCid">Previous release CID (optional)</label>
        <input type="text" id="prevCid" name="prevCid" placeholder="bafyrei…">
        <button type="submit">Sign and publish</button>
      </form>
    </div>`,
    params.mode,
  )
}

export function acceptPage(params: {
  mode?: Mode
  actors: Actor[]
  current?: string
  written?: { uri: string; kind: 'acceptance' | 'dispute' }
  error?: string
}) {
  return layout(
    'Record a verdict',
    html`<h1>Record a verdict on a part you received</h1>
    <p class="sub">
      This verdict is published in <em>your</em> repository, not the issuer's.
      They cannot delete it, and no service sits in between with the power to
      suppress it. They can only answer it.
    </p>

    <div class="card" style="padding:1.15rem">${personaPicker(params.actors, params.current)}</div>

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
  )
}
