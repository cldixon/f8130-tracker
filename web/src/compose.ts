/**
 * The composer: the form for signing a release, and the block labels it needs.
 *
 * This lives apart from the pages because the composer is chrome now rather
 * than a destination. A repair station releasing a part is the one thing this
 * application exists to let somebody do, so the way in is a button in the rail
 * that opens over whatever you were looking at — the same move a social client
 * makes for the same reason. `/issue` remains a real page underneath it, which
 * is what the button degrades to when scripting is off.
 */

import { html } from 'hono/html'

import { FIELDS } from '@f8130/core'

import type { Actor } from './writer.js'

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

/** Just the human name, for places that draw the block number themselves. */
export function bareLabel(name: string): string {
  return FIELD_LABELS[name] ?? name
}

/** "Block 4 · Organization name", falling back to the raw name. */
export function fieldLabel(name: string): string {
  const label = FIELD_LABELS[name] ?? name
  const spec = FIELDS.find((f) => f.name === name)
  return spec ? `Block ${spec.block} · ${label}` : label
}

/**
 * The seventeen blocks, drawn from the field set rather than listed.
 *
 * It used to be a hand-written list, and the field set moved out from under it:
 * for a while the form asked for cost and customer, which are not blocks on an
 * 8130-3, and never asked for Block 1, Block 4 or the certifying column, all of
 * which a record requires. It rendered fine and could not produce a valid
 * record. Deriving it means a field cannot be missing from the form without
 * being missing from the schema.
 */
export function issueInputs(prefill: Record<string, unknown> | null) {
  const value = (name: string) => {
    const v = prefill?.[name]
    return v === null || v === undefined ? '' : String(v)
  }
  return FIELDS.map((spec) => {
    const label = html`<label for="${spec.name}">
      ${fieldLabel(spec.name)}${spec.public ? '' : html` <span class="hint">private</span>`}
    </label>`
    if (spec.kind === 'enum') {
      return html`${label}
        <select id="${spec.name}" name="${spec.name}">
          ${(spec.values ?? []).map(
            (v) => html`<option value="${v}" ${value(spec.name) === v ? 'selected' : ''}>${v}</option>`,
          )}
        </select>`
    }
    // Block 12 is the one field that is genuinely prose — findings, workscope
    // and whatever else the shop wrote down — and it does not fit on a line.
    if (spec.name === 'remarks') {
      return html`${label}
        <textarea id="${spec.name}" name="${spec.name}"
          style="min-height:5rem">${value(spec.name)}</textarea>`
    }
    // The placeholder goes in as a value rather than as a fragment of markup:
    // interpolating the whole `placeholder="…"` string escapes its quotes and
    // renders an attribute whose name contains the entities, which is why the
    // date field used to display its own hint in quotation marks.
    return html`${label}
      <input type="${spec.kind === 'integer' ? 'number' : 'text'}"
        id="${spec.name}" name="${spec.name}" value="${value(spec.name)}"
        placeholder="${spec.kind === 'timestamp' ? '2026-04-01T12:00:00Z' : ''}">`
  })
}

/**
 * Says who is about to sign.
 *
 * It deliberately cannot change who that is. There used to be a picker here as
 * well as one in the chrome, and only the chrome's took effect — choosing an
 * organization in this one and pressing generate produced a form belonging to
 * whoever was first in the roster.
 */
export function signingAs(current: Actor | undefined) {
  if (!current) {
    return html`<div class="needs-actor">
      You are viewing as the public, which cannot sign anything. Switch to an
      organization in the rail to continue.
    </div>`
  }
  return html`<p class="signing">
    Signing as <strong>${current.displayName}</strong> (${current.kind}) — this
    service builds the record and hands it to their server to sign.
  </p>`
}

/**
 * The composer, as a modal over whatever the visitor was reading.
 *
 * Submitting leaves the dialog and lands on a page, which is deliberate: what
 * comes back is a bundle that cannot be reconstructed if it is lost, and that
 * deserves more than a toast.
 */
export function composer(actor: Actor | undefined) {
  return html`<dialog id="composer">
    <div class="chead">
      <strong>New release certificate</strong>
      <form method="dialog"><button class="ghost" aria-label="Close">&times;</button></form>
    </div>
    <div class="cbody">
      ${signingAs(actor)}
      ${actor
        ? html`<p class="sub" style="margin-bottom:.6rem">
              Seventeen blocks is a lot to type. The generator fills them from
              the same builder the seed job uses.
            </p>
            <button type="button" id="gen" class="ghost">Generate a synthetic example</button>`
        : ''}
      <form method="post" action="/issue" id="composeForm">
        ${issueInputs(null)}
        <label for="c_prevUri">Previous release URI (optional)</label>
        <input type="text" id="c_prevUri" name="prevUri" placeholder="at://…">
        <label for="c_prevCid">Previous release CID (optional)</label>
        <input type="text" id="c_prevCid" name="prevCid" placeholder="bafyrei…">
        <button type="submit" ${actor ? '' : 'disabled'}>Sign and publish</button>
      </form>
    </div>
  </dialog>`
}
