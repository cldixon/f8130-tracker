/**
 * The receiving dock: parts that physically arrived, awaiting inspection.
 *
 * This is not the network telling anyone anything, and the distinction is the
 * whole reason the file exists rather than being folded into the index.
 *
 * An 8130-3 says who *issued* a release. It does not say who received the
 * part — there is no block for it, and adding one would both break the
 * form-fidelity the lexicon is built on and publish the commercial
 * relationship between a shop and its customer, which is the leak operators
 * care most about. So the public record genuinely cannot answer "what is
 * waiting for me". Nothing is missing from the implementation; the answer is
 * not in the data.
 *
 * How an operator actually learns a part arrived is that a crate arrived. This
 * models exactly that and nothing more: a demonstration-local list of what was
 * handed over, standing in for a goods-in process this project does not have.
 * It is deliberately not durable, not published, and not readable by anyone
 * but the recipient.
 *
 * The seam for what comes next is here rather than in a comment elsewhere:
 * under a scheme that allows committed-but-private fields — the recipient
 * being the textbook case — the network could carry this, addressed to the
 * operator and to a regulator and to nobody else. Then the inbox becomes a
 * real protocol feature instead of a stand-in, and this file goes away.
 */

import type { StrongRef } from './writer.js'

/** One part sitting on a dock, waiting for somebody to look at it. */
export type Arrival = {
  subject: StrongRef
  issuerDid: string
  issuerName: string
  partNumber: string
  serialNumber: string
  description: string
  at: Date
  /**
   * The paperwork that came in the crate, as if somebody had scanned it.
   *
   * This is a bundle, which carries every nonce and therefore opens every
   * withheld block on the record it belongs to. The standing rule is that no
   * AppView may hold one. This does not break that rule, and it is close
   * enough to it to be worth saying why.
   *
   * The web service in this demonstration is playing three parts at once: the
   * AppView that reads the index, the issuer's client that composes a release,
   * and — here — the recipient's goods-in desk. Only the first of those is an
   * AppView. An operator's own document system holding the paperwork for a
   * part it was sent is not a leak; it is the operator's paper, and being
   * able to read it is the entire reason selective disclosure has a point.
   *
   * What keeps that true is where this lives and who can reach it. It is in
   * memory on this one process, keyed by the recipient, never written to the
   * index, never handed to the watchdog, never logged, and never rendered for
   * any organization but the one the part was sent to. `bundleFor` is the only
   * way out and it takes the recipient as an argument for that reason.
   */
  bundle: unknown
}

export class Dock {
  private readonly byRecipient = new Map<string, Arrival[]>()

  /** How many arrivals to keep per recipient. A demo should not hoard. */
  constructor(private readonly cap = 25) {}

  handOver(toHandle: string, arrival: Arrival): void {
    const list = this.byRecipient.get(toHandle) ?? []
    if (list.some((a) => a.subject.uri === arrival.subject.uri)) return
    list.unshift(arrival)
    this.byRecipient.set(toHandle, list.slice(0, this.cap))
  }

  /** Newest first. */
  awaiting(handle: string | undefined): Arrival[] {
    if (!handle) return []
    return this.byRecipient.get(handle) ?? []
  }

  count(handle: string | undefined): number {
    return this.awaiting(handle).length
  }

  /**
   * The scanned paperwork for one arrival, for its recipient and nobody else.
   *
   * Takes the recipient rather than looking the release up globally, so that
   * asking for somebody else's document is not a thing the caller can express
   * rather than a thing it is trusted not to do. A caller holding a release
   * URI it was not sent gets undefined, whoever it is.
   */
  bundleFor(handle: string | undefined, releaseUri: string): unknown {
    if (!handle) return undefined
    return this.awaiting(handle).find((a) => a.subject.uri === releaseUri)?.bundle
  }

  /** One arrival, for its recipient and nobody else. */
  arrival(handle: string | undefined, releaseUri: string): Arrival | undefined {
    if (!handle) return undefined
    return this.awaiting(handle).find((a) => a.subject.uri === releaseUri)
  }

  /**
   * Drop an arrival once somebody has published a check on it.
   *
   * Keyed by the release and swept across every recipient rather than only the
   * one that published: the attestation is the fact that the part was dealt
   * with, whoever ended up dealing with it.
   */
  settle(releaseUri: string): void {
    for (const [handle, list] of this.byRecipient) {
      const next = list.filter((a) => a.subject.uri !== releaseUri)
      if (next.length !== list.length) this.byRecipient.set(handle, next)
    }
  }
}
