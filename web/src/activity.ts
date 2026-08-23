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
  DISCREPANCY_ANGLES,
  narratedForm,
  orgs,
  REJECTION_ANGLES,
  type Narrator,
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
  /** Block 7, which is public — see VerdictBrief on why Block 12 is not. */
  description: string
  /**
   * How this will go, decided when the part ships rather than when it is
   * looked at.
   *
   * Nothing about the outcome depends on the moment of inspection — a part
   * either arrives damaged or it does not — so rolling it early costs nothing
   * and is arguably the more honest model. What it buys is a whole feed
   * interval of warning, which is what the note below needs.
   */
  outcome: 'accepted' | 'rejected' | 'discrepancy'
  /**
   * The stated reason, started at ship time and awaited at inspection time.
   *
   * This is the fix for notes falling back to the canned list. The narration
   * is not slow — p50 four seconds — but it used to run on the publishing
   * path, where a bad minute on the API meant a canned string. Started here,
   * it has twelve to forty-five seconds to arrive and by then has almost
   * always resolved, so awaiting it costs nothing and a slow call is a slower
   * reply rather than a worse one.
   */
  note: Promise<string | null> | null
  /** The operator the part went to. Not a field on the form — see below. */
  operatorHandle: string
  at: number
}

/** A verdict that went against an issuer, who may yet answer it. */
type Answerable = {
  subject: StrongRef
  issuerHandle: string
  description: string
  note: string
  /** Started the moment the verdict is published, for the same reason. */
  reply: Promise<string | null> | null
  at: number
}

/**
 * A part that exists and could come back in for more work.
 *
 * Every generated release used to be a birth, so a part page built from live
 * activity always showed exactly one shop visit and the back-to-birth view had
 * nothing to trace. A component's life is several visits at several shops, and
 * this is what makes the next one able to point at the last.
 */
type InService = {
  subject: StrongRef
  partNumber: string
  serialNumber: string
  description: string
  visits: number
}

export type ActivityOptions = {
  writer: RecordWriter
  /** The PDS hostname the roster's handles are built from. */
  domain: string
  /**
   * Where a form's prose comes from.
   *
   * Expected to be a buffered narrator — one that answers from a pool it
   * filled in the background and returns null the moment the pool is empty,
   * rather than one that reaches for the network while an event is waiting to
   * publish.
   */
  narrator?: Narrator | null
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

/**
 * How often a release continues a part already in service rather than
 * beginning a new one.
 *
 * Under a half, so the population of distinct parts keeps growing and chains
 * stay plausible lengths rather than every record piling onto one component.
 */
const CONTINUATION_RATE = 0.35

/** A part's history stops growing here, as a real one eventually would. */
const MAX_VISITS = 5

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
  private inService: InService[] = []
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

  /**
   * Starts work now to be read later, and never lets it reject.
   *
   * A floating promise that throws is an unhandled rejection, and an
   * unhandled rejection in a generator nobody is watching takes the process
   * with it on some Node versions. Everything that can go wrong becomes null,
   * which is what the caller already handles.
   */
  private start(fn: () => Promise<string | null> | undefined): Promise<string | null> {
    try {
      return Promise.resolve(fn() ?? null).catch((err) => {
        this.opts.onError?.(err)
        return null
      })
    } catch (err) {
      this.opts.onError?.(err)
      return Promise.resolve(null)
    }
  }

  private pickOne<T>(items: readonly T[]): T | undefined {
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
          // The reply answers the objection that was actually raised, which
          // is the whole interest of a right of reply. The canned list cannot
          // do that — it answers whatever it always answers.
          const response = (await target.reply) ?? this.pickOne(DISPUTE_REPLIES)!

          await this.opts.writer.createDispute({
            handle: target.issuerHandle,
            subject: target.subject,
            response,
          })
          this.stats.disputes++
          return
        }
      }

      // Close out a release that is waiting on its operator.
      if (this.pending.length > 0 && r < 0.55) {
        const item = this.pending.shift()!
        if (this.known(item.operatorHandle)) {
          const outcome = item.outcome
          // Started a whole feed interval ago, so this has almost always
          // resolved and awaiting it costs nothing. The canned list is still
          // behind it for the case where it has not.
          const note =
            outcome === 'accepted'
              ? undefined
              : ((await item.note) ??
                this.pickOne(
                  outcome === 'rejected' ? REJECTION_NOTES : DISCREPANCY_NOTES,
                ))

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
              description: item.description,
              note: note ?? '',
              // Same trick: the reply starts now and is read a tick or more
              // later, so the issuer's answer is off the publishing path too.
              reply: note
                ? this.start(() =>
                    this.opts.narrator?.narrateDispute?.({
                      verdictNote: note,
                      description: item.description,
                    }),
                  )
                : null,
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

    // Sometimes a part already in service comes back in for more work. An
    // OEM is not a candidate — a manufacturer certifies new manufacture under
    // Block 13, and a part it has already released is not new any more.
    const returning =
      issuer.kind !== 'oem' &&
      this.inService.length > 0 &&
      this.rand() < CONTINUATION_RATE
        ? this.pickOne(this.inService)
        : undefined

    const form: RawForm = await narratedForm({
      org: issuer,
      seed: Math.floor(this.rand() * 1e9) ^ this.seq++,
      narrator: this.opts.narrator ?? null,
      ...(returning
        ? {
            continues: {
              partNumber: returning.partNumber,
              serialNumber: returning.serialNumber,
              description: returning.description,
            },
          }
        : {}),
    })

    const written = await this.opts.writer.createRelease({
      handle: issuer.handle,
      form,
      // The strong reference is what makes this a history rather than two
      // records that happen to share a serial number.
      ...(returning ? { prev: returning.subject } : {}),
    })
    this.stats.released++

    // The part's newest release is what a further visit would point at.
    const subject = { uri: written.uri, cid: written.cid }
    if (returning) {
      returning.subject = subject
      returning.visits++
      if (returning.visits >= MAX_VISITS) {
        this.inService = this.inService.filter((p) => p !== returning)
      }
    } else {
      this.inService.push({
        subject,
        partNumber: String(form.partNumber),
        serialNumber: String(form.serialNumber),
        description: String(form.description ?? ''),
        visits: 1,
      })
      if (this.inService.length > 30) this.inService.shift()
    }

    this.opts.dock?.handOver(operator.handle, {
      subject: { uri: written.uri, cid: written.cid },
      issuerDid: written.uri.split('/')[2] ?? '',
      issuerName: issuer.displayName,
      partNumber: String(form.partNumber),
      serialNumber: String(form.serialNumber),
      description: String(form.description ?? ''),
      at: new Date(this.now()),
    })

    const roll = this.rand()
    const outcome =
      roll < REJECTION_RATE
        ? ('rejected' as const)
        : roll < REJECTION_RATE + 0.08
          ? ('discrepancy' as const)
          : ('accepted' as const)

    this.pending.push({
      outcome,
      note:
        outcome === 'accepted'
          ? null
          : this.start(() =>
              this.opts.narrator?.narrateVerdict?.({
                outcome,
                description: String(form.description ?? ''),
                angle: this.pickOne(
                  outcome === 'rejected' ? REJECTION_ANGLES : DISCREPANCY_ANGLES,
                )!,
              }),
            ),
      subject: { uri: written.uri, cid: written.cid },
      // at://<did>/<collection>/<rkey> — the only place the write hands back
      // the issuer's DID, which the verdict has to name.
      issuerDid: written.uri.split('/')[2] ?? '',
      issuerHandle: issuer.handle,
      partNumber: String(form.partNumber),
      serialNumber: String(form.serialNumber),
      description: String(form.description ?? ''),
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
