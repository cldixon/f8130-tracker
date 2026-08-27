/**
 * The composer shell, and the block labels the rest of the app needs.
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
 * The composer, as a modal over whatever the visitor was reading.
 *
 * Deliberately empty. Everything inside it — the generated draft, the
 * confirmation that follows, the error that sends a bad edit back — is
 * rendered by `/issue` and fetched in. The page at `/issue` is the same
 * markup, so there is one template rather than two that drift, and what the
 * button degrades to with scripting off is the thing it was standing in for.
 *
 * The loader is the dialog's resting content rather than something script
 * inserts, so the first frame after `showModal()` already says what is
 * happening. Generating a form takes a call to a model; a blank box for a
 * second reads as broken.
 */
export function composer() {
  return html`<dialog id="composer">
    <div class="chead">
      <strong>New release certificate</strong>
      <form method="dialog"><button class="ghost" aria-label="Close">&times;</button></form>
    </div>
    <div class="cbody">
      <div class="working">
        <span class="spinner" aria-hidden="true"></span>
        <p>Generating a synthetic 8130-3&hellip;</p>
      </div>
    </div>
  </dialog>`
}

/**
 * The receiving dialog, as a frame with nothing in it.
 *
 * Empty for the same reason the composer is: everything inside — the scanned
 * document, the checks running, the result, the receipt — is rendered by the
 * routes under /inbox and fetched in, so the dialog and the pages cannot
 * disagree about what a check looks like.
 */
export function checker() {
  return html`<dialog id="checker">
    <div class="chead">
      <strong>Receiving</strong>
      <form method="dialog"><button class="ghost" aria-label="Close">&times;</button></form>
    </div>
    <div class="cbody">
      <div class="working">
        <span class="spinner" aria-hidden="true"></span>
        <p>Opening the paperwork&hellip;</p>
        <div class="detail"></div>
      </div>
    </div>
  </dialog>`
}
