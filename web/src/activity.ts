/**
 * Synthetic activity, generated only while somebody is watching.
 *
 * The feed exists to show a system in motion, and a system in motion needs
 * something to move. This writes real records through the real write path —
 * the PDS signs them, the firehose carries them, ingest verifies and indexes
 * them — because faking rows into the index would turn the demonstration into
 * a normal database with extra steps, which is the one thing the architecture
 * is arranged to avoid.
 *
 * Two consequences follow from that and are deliberate:
 *
 *   - Every generated event is a permanent write to a real repository. The
 *     generator therefore runs only while at least one viewer is connected,
 *     and idles the moment the last one leaves. A demonstration nobody is
 *     looking at should not be accumulating history.
 *   - Nothing appears in the feed until an AppView has independently observed
 *     it. The delay between writing and appearing is the pipeline working, not
 *     lag to paper over.
 *
 * The activity is choreographed rather than random. A part is released, and
 * some time later the operator who received it publishes a verdict; a rejection
 * is occasionally answered by the issuer. A feed of unrelated issuances reads
 * as a log. A feed where events answer each other reads as a system.
 */

import {
  orgs,
  syntheticForm,
  type Org,
  type RawForm,
} from '@f8130/core'

import type { RecordWriter, StrongRef } from './writer.js'

/** A release waiting for the operator who received it to say something. */
type Pending = {
  subject: StrongRef
  issuerDid: string
  issuerHandle: string
  partNumber: string
  serialNumber: string
  /** The operator the part went to. Not a field on the form — see below. */
  operatorHandle: string
  at: number
}

/** A verdict that went against an issuer, who may yet answer it. */
type Answerable = {
  subject: StrongRef
  issuerHandle: string
  at: number
}

export type ActivityOptions = {
  writer: RecordWriter
  /** The PDS hostname the roster's handles are built from. */
  domain: string
  /** Milliseconds between events. Jittered between these. */
  minGap?: number
  maxGap?: number
  /**
   * How long the first viewer waits before anything happens.
   *
   * Short on purpose. Arriving at a feed and watching nothing for a minute
   * teaches a visitor that the page is broken, which is the opposite of what
   * a live feed is for. Later events settle into the ordinary cadence.
   */
  firstGap?: number
  /** Injected so tests can drive the clock and the dice. */
  now?: () => number
  random?: () => number
  onError?: (err: unknown) => void
  /**
   * Where to record that a part was handed to somebody.
   *
   * Optional, because the generator's job is to publish records and the dock
   * is not one — it stands in for a goods-in process, which is exactly the
   * thing the public record cannot carry.
   */
  dock?: {
    handOver(toHandle: string, arrival: {
      subject: StrongRef
      issuerDid: string
      issuerName: string
      partNumber: string
      serialNumber: string
      description: string
      at: Date
    }): void
    settle(releaseUri: string): void
  }
}

// Paced for someone who is actually looking. A visitor spends well under a
// minute on a feed, so a ninety-second gap means most of them see nothing
// happen at all and conclude the page is static.
const DEFAULT_MIN_GAP = 12_000
const DEFAULT_MAX_GAP = 45_000
const DEFAULT_FIRST_GAP = 4_000

/** How often a verdict goes against the issuer. Most paperwork is fine. */
const REJECTION_RATE = 0.18

const REJECTION_NOTES = [
  'Back-to-birth documentation could not be produced on request.',
  'Serial number on the part does not match the accompanying paperwork.',
  'Supplied release references a shop visit we have no record of.',
  'Certificate number on the release does not match the issuing station.',
]

const DISCREPANCY_NOTES = [
  'Paperwork verifies; part shows damage not noted on the release.',
  'Part serviceable and paperwork verifies, but the chain stops short of birth.',
  'Received quantity does not match the quantity on the release.',
]

const DISPUTE_REPLIES = [
  'Back-to-birth records were supplied to the purchaser at time of sale.',
  'The referenced shop visit is published; we can provide the bundle on request.',
  'We stand by this release and have asked the operator to re-inspect.',
]

/**
 * Drives synthetic activity for as long as anyone is watching.
 *
 * Start and stop are reference-counted by viewer, not called directly: the
 * feed's event stream calls `viewerJoined` and `viewerLeft`, and the generator
 * runs exactly when that count is above zero.
 */
export class ActivityGenerator {
  private viewers = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: Pending[] = []
  private answerable: Answerable[] = []
  private seq = 0

  /** Counts, for the health endpoint and for tests. */
  readonly stats = { released: 0, verdicts: 0, disputes: 0, errors: 0 }

  constructor(private readonly opts: ActivityOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  private rand(): number {
    return (this.opts.random ?? Math.random)()
  }

  get running(): boolean {
    return this.timer !== null
  }

  get viewerCount(): number {
    return this.viewers
  }

  viewerJoined(): void {
    this.viewers++
    if (this.viewers === 1) this.schedule(this.opts.firstGap ?? DEFAULT_FIRST_GAP)
  }

  viewerLeft(): void {
    this.viewers = Math.max(0, this.viewers - 1)
    if (this.viewers === 0) this.stop()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(fixedGap?: number): void {
    if (this.viewers === 0) return
    const min = this.opts.minGap ?? DEFAULT_MIN_GAP
    const max = this.opts.maxGap ?? DEFAULT_MAX_GAP
    const gap = fixedGap ?? min + Math.floor(this.rand() * (max - min))
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, gap)
    // Never hold the process open for a demonstration.
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
  }

  private cast(): Org[] {
    return orgs(this.opts.domain)
  }

  private known(handle: string): boolean {
    return this.opts.writer.actors().some((a) => a.handle === handle)
  }

  private pickOne<T>(items: T[]): T | undefined {
    if (items.length === 0) return undefined
    return items[Math.floor(this.rand() * items.length)]
  }

  /**
   * One event.
   *
   * Public so a test can step the generator without waiting on timers, and so
   * the feed can prime an empty demonstration with a first event rather than
   * showing an empty page for the first minute.
   */
  async tick(): Promise<void> {
    try {
      const r = this.rand()

      // Answer a rejection now and then. The issuer cannot delete the verdict;
      // replying is the whole of what they can do.
      if (this.answerable.length > 0 && r < 0.15) {
        const target = this.answerable.shift()!
        if (this.known(target.issuerHandle)) {
          await this.opts.writer.createDispute({
            handle: target.issuerHandle,
            subject: target.subject,
            response: this.pickOne(DISPUTE_REPLIES)!,
          })
          this.stats.disputes++
          return
        }
      }

      // Close out a release that is waiting on its operator.
      if (this.pending.length > 0 && r < 0.55) {
        const item = this.pending.shift()!
        if (this.known(item.operatorHandle)) {
          const roll = this.rand()
          const outcome =
            roll < REJECTION_RATE
              ? 'rejected'
              : roll < REJECTION_RATE + 0.08
                ? 'discrepancy'
                : 'accepted'
          const note =
            outcome === 'rejected'
              ? this.pickOne(REJECTION_NOTES)
              : outcome === 'discrepancy'
                ? this.pickOne(DISCREPANCY_NOTES)
                : undefined

          const written = await this.opts.writer.createAcceptance({
            handle: item.operatorHandle,
            subject: item.subject,
            issuerDid: item.issuerDid,
            partNumber: item.partNumber,
            serialNumber: item.serialNumber,
            outcome,
            ...(note ? { note } : {}),
          })
          this.stats.verdicts++
          this.opts.dock?.settle(item.subject.uri)

          if (outcome !== 'accepted') {
            this.answerable.push({
              subject: { uri: written.uri, cid: written.cid },
              issuerHandle: item.issuerHandle,
              at: this.now(),
            })
          }
          return
        }
      }

      await this.issue()
    } catch (err) {
      this.stats.errors++
      this.opts.onError?.(err)
    }
  }

  /** A repair station or manufacturer releases a part to an operator. */
  private async issue(): Promise<void> {
    const cast = this.cast()
    const issuers = cast.filter(
      (o) => (o.kind === 'mro' || o.kind === 'oem') && this.known(o.handle),
    )
    const operators = cast.filter(
      (o) => (o.kind === 'operator' || o.kind === 'lessor') && this.known(o.handle),
    )
    const issuer = this.pickOne(issuers)
    const operator = this.pickOne(operators)
    if (!issuer || !operator) return

    const form: RawForm = syntheticForm({
      org: issuer,
      seed: Math.floor(this.rand() * 1e9) ^ this.seq++,
    })

    const written = await this.opts.writer.createRelease({
      handle: issuer.handle,
      form,
    })
    this.stats.released++

    this.opts.dock?.handOver(operator.handle, {
      subject: { uri: written.uri, cid: written.cid },
      issuerDid: written.uri.split('/')[2] ?? '',
      issuerName: issuer.displayName,
      partNumber: String(form.partNumber),
      serialNumber: String(form.serialNumber),
      description: String(form.description ?? ''),
      at: new Date(this.now()),
    })

    this.pending.push({
      subject: { uri: written.uri, cid: written.cid },
      // at://<did>/<collection>/<rkey> — the only place the write hands back
      // the issuer's DID, which the verdict has to name.
      issuerDid: written.uri.split('/')[2] ?? '',
      issuerHandle: issuer.handle,
      partNumber: String(form.partNumber),
      serialNumber: String(form.serialNumber),
      // Who received the part is NOT on the form — an 8130-3 says who issued
      // it, not who it went to. The generator remembers so it can have the
      // right operator publish the verdict, which is how the protocol
      // expresses receipt.
      operatorHandle: operator.handle,
      at: this.now(),
    })

    // Keep the backlog bounded; an unwatched demo should not accumulate one.
    if (this.pending.length > 20) this.pending.shift()
  }
}
