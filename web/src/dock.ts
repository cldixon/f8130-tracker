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
   * Drop an arrival once a verdict on it has been published.
   *
   * Keyed by the release, and swept across every recipient rather than only
   * the one that published: the verdict is the fact that the part was dealt
   * with, whoever ended up dealing with it.
   */
  settle(releaseUri: string): void {
    for (const [handle, list] of this.byRecipient) {
      const next = list.filter((a) => a.subject.uri !== releaseUri)
      if (next.length !== list.length) this.byRecipient.set(handle, next)
    }
  }
}
