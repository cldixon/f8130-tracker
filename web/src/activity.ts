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
  narratedForm,
  orgs,
  type Narrator,
  type Org,
  type RawForm,
} from '@f8130/core'

import type { RecordWriter, StrongRef } from './writer.js'

/** A release waiting for the operator who received it to say something. */
/** A part handed to an operator, waiting for somebody to check its paperwork. */
type Pending = {
  subject: StrongRef
  issuerHandle: string
  partNumber: string
  serialNumber: string
  description: string
  /** The date the certificate claims it was signed. Receipt is dated from it. */
  completedAt: Date
  /** The operator the part went to. Not a field on the form — see below. */
  operatorHandle: string
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
  /** Prior releases to write before the first live event. Zero disables it. */
  backlogSize?: number
  /** How many days back that backlog reaches. */
  backlogDays?: number
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

/**
 * How much of a station's output somebody independently checks and says so.
 *
 * Not every part that arrives gets its paperwork verified against the network,
 * and not every operator that verifies bothers to publish. Sixty per cent is
 * high enough that attestation reads as ordinary practice and low enough that
 * a gap on any one release means nothing — which is the correct strength for
 * it, because absence is the only negative signal this network can carry and
 * it must not be mistaken for an accusation.
 */
const COVERAGE = 0.6

/**
 * Stations whose work almost nobody vouches for.
 *
 * Planted on purpose, so the watchdog has something real to find rather than a
 * uniform population where every station looks like every other. Thin coverage
 * is not proof of anything and the UI must not present it as such; it is the
 * shape that makes a reader go and look.
 */
const THIN_COVERAGE = 0.15
const THIN_STATIONS = new Set(['saltmarsh-technics', 'wexford-components'])

/** Where the tick splits between checking an old part and releasing a new one. */
const ATTEST_ROLL = 0.42

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

/**
 * The history that already exists when the first viewer arrives.
 *
 * Without it the only parts available to inspect were the ones this session
 * had just released, so a verdict always landed seconds after the release it
 * judged and both read as having happened at the same moment. A part crosses
 * an ocean between those two events. The backlog is what gives an inspection
 * something realistically old to be about.
 *
 * It also fixes the mix. Every release eventually draws a verdict, so a feed
 * with no prior stock spends its whole life closing out parts it opened
 * minutes ago, and reads as an inspection log rather than as a supply chain.
 */
const BACKLOG_SIZE = 34

/** The far end of the window the backlog is spread across. */
const BACKLOG_DAYS = 21

/**
 * The near end.
 *
 * Nothing in the backlog claims to be newer than this, and a live release
 * claims today, so every historical card is dated older than every live one.
 * That keeps the column monotonic: a reader scrolling down sees time recede
 * instead of jumping about. Without the floor the two populations interleave
 * by date while the ordering stays on the observer's clock, and the result
 * looks like a bug even though every date on it is correct.
 */
const BACKLOG_MIN_DAYS = 4

/** How much of that backlog has already been inspected on arrival. */
const BACKLOG_SETTLED = 0.35

/**
 * Shipping time, in days, between a certificate being signed and the part
 * reaching the operator's receiving dock.
 *
 * A component out of an overhaul shop is crated, booked onto a freight
 * forwarder and cleared through customs. Two days is a domestic overnight
 * with paperwork; nine is an ordinary international routing.
 */
const TRANSIT_MIN_DAYS = 2
const TRANSIT_MAX_DAYS = 9

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
  private inService: InService[] = []
  private seq = 0
  private seeded = false
  /**
   * Seeding is in flight.
   *
   * Part of `running` because the invariant that matters is "this generator is
   * writing records", and it is writing them during the seed as much as during
   * a tick. Reporting idle while twenty-six releases go out would make the one
   * property the feed page promises — nothing accumulates unwatched — a
   * statement the class could not actually back.
   */
  private seeding = false

  /** Counts, for the health endpoint and for tests. */
  readonly stats = { released: 0, attestations: 0, errors: 0 }

  constructor(private readonly opts: ActivityOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  private rand(): number {
    return (this.opts.random ?? Math.random)()
  }

  get running(): boolean {
    return this.timer !== null || this.seeding
  }

  get viewerCount(): number {
    return this.viewers
  }

  viewerJoined(): void {
    this.viewers++
    if (this.viewers !== 1) return
    this.seeding = true

    // The stock in transit has to exist before the first live event, or the
    // first verdict has nothing to be about except a release from ten seconds
    // ago. Seeding is not awaited by the caller — a visitor loading the page
    // should not wait on twenty-six writes — but the first tick is scheduled
    // behind it, so ordering holds.
    void this.seedBacklog()
      .catch((err) => {
        this.stats.errors++
        this.opts.onError?.(err)
      })
      .finally(() => {
        this.seeding = false
        this.schedule(this.opts.firstGap ?? DEFAULT_FIRST_GAP)
      })
  }

  viewerLeft(): void {
    this.viewers = Math.max(0, this.viewers - 1)
    if (this.viewers === 0) this.stop()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // A seed already in flight cannot be cancelled mid-write, but it checks
    // for viewers between records and stops at the next one.
    this.seeding = false
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

  /** Days in a crate, on a freight forwarder, through customs. */
  private transitDays(): number {
    return (
      TRANSIT_MIN_DAYS +
      Math.floor(this.rand() * (TRANSIT_MAX_DAYS - TRANSIT_MIN_DAYS + 1))
    )
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
      // Check an old part, or release a new one. The oldest waiting part
      // first, which with a backlog in place means one that has genuinely been
      // in transit for days rather than the one released a tick ago.
      if (this.pending.length > 0 && this.rand() < ATTEST_ROLL) {
        const item = this.pending.shift()!
        if (this.known(item.operatorHandle)) {
          await this.attest(item)
          return
        }
      }

      await this.issue()
    } catch (err) {
      this.stats.errors++
      this.opts.onError?.(err)
    }
  }

  /**
   * An operator says in public that a document checked out.
   *
   * Dated from the release rather than from the wall clock. The certificate
   * was signed when the part left the shop; it is checked when the part
   * arrives, a shipping time later. Publishing now and dating it now was what
   * made a release and the statement about it read as the same moment.
   *
   * There is no failing counterpart to this method, here or anywhere. A party
   * who cannot verify a document cannot prove that to anybody, so there is
   * nothing to publish and nothing for this generator to simulate.
   */
  private async attest(item: Pending, verifiedAtOverride?: Date): Promise<void> {
    // The tick path has already taken it off the front; the backlog path
    // reaches items by name and has not.
    this.pending = this.pending.filter((p) => p !== item)

    // Never later than now: a check cannot happen in the future, however long
    // the crate took.
    const verifiedAt =
      verifiedAtOverride ??
      new Date(
        Math.min(this.now(), item.completedAt.getTime() + this.transitDays() * 86_400_000),
      )

    await this.opts.writer.createAttestation({
      handle: item.operatorHandle,
      subject: item.subject,
      verifiedAt,
    })
    this.stats.attestations++
    this.opts.dock?.settle(item.subject.uri)
  }

  /**
   * The stock of parts already moving through the world before anyone looked.
   *
   * Written oldest first, deliberately. The feed is ordered on this observer's
   * clock, and these records all arrive within a second of each other, so the
   * order they are written in is the order they will appear in. Writing them
   * oldest first makes that order agree with the dates on the certificates,
   * and a reader scrolling down sees history recede instead of jumping about.
   *
   * The catalogue writes these rather than the narrator. Twenty-six model
   * calls would put a minute of latency in front of the first viewer and cost
   * real money on every cold start, for prose that is scrolled past on the way
   * to the live events. Narration is spent where it is read.
   */
  /**
   * Why this runs on every process start rather than checking for history
   * first.
   *
   * The instinct is to skip seeding when the index already holds releases,
   * because every seeded record is a permanent write to a real repository.
   * That guard was here and it was wrong, in the way that matters: it asks
   * whether *records* exist when the thing that has to exist is *inspectable*
   * stock, and inspectable is in-memory.
   *
   * A verdict needs to know which operator received the part, and that is not
   * on the certificate — an 8130-3 names the issuer and never the recipient.
   * So the generator can only inspect parts it handed over itself, in this
   * process, and that queue is empty at boot however much history the database
   * holds. Consulting the index meant that in the one deployment with real
   * history — production — seeding was skipped, the queue stayed empty, and
   * every verdict landed on a release from minutes earlier. Which is the
   * complaint this whole mechanism exists to answer.
   *
   * The cost it was guarding against is not real at this scale. A watched feed
   * writes a record every twelve to forty-five seconds, so a session produces
   * a few hundred an hour; thirty-four at the start of one is noise. And
   * seeding is behind `viewerJoined`, so a container that restarts with nobody
   * watching writes nothing at all.
   */
  private async seedBacklog(): Promise<void> {
    if (this.seeded) return
    this.seeded = true

    const size = this.opts.backlogSize ?? BACKLOG_SIZE
    const span = this.opts.backlogDays ?? BACKLOG_DAYS
    if (size <= 0) return

    // The schedule first, then the writes in date order.
    //
    // Seeding releases in one pass and then settling a fraction in a second
    // put every receipt above every release in the feed, because the feed
    // orders on the observer's clock and the second pass was written second.
    // The dates said one thing and the column said another. Planning both
    // kinds together and running the plan oldest-first makes write order and
    // claimed order the same order, which is the only reason the column reads
    // as a timeline at all.
    type Step = { agedDays: number; kind: 'release' | 'attestation'; n: number }
    const steps: Step[] = []
    for (let n = 0; n < size; n++) {
      const agedDays =
        BACKLOG_MIN_DAYS + Math.round(((span - BACKLOG_MIN_DAYS) * (size - n)) / size)
      steps.push({ agedDays, kind: 'release', n })

      // Some of this stock has already been checked by whoever received it.
      // Without it the feed opens as an unbroken wall of releases, which is
      // the complaint the backlog exists to answer, pointed the other way.
      if (this.rand() >= BACKLOG_SETTLED) continue
      const arrived = agedDays - this.transitDays()
      // A shipment that would land today or later belongs to the live feed,
      // not to history.
      if (arrived >= 1) steps.push({ agedDays: arrived, kind: 'attestation', n })
    }
    steps.sort((a, b) => b.agedDays - a.agedDays)

    const issued = new Map<number, Pending>()
    for (const step of steps) {
      if (this.viewers === 0) return
      try {
        if (step.kind === 'release') {
          const pending = await this.issue({ agedDays: step.agedDays, narrate: false })
          if (pending) issued.set(step.n, pending)
          continue
        }
        const item = issued.get(step.n)
        if (!item || !this.known(item.operatorHandle)) continue
        await this.attest(item, new Date(this.now() - step.agedDays * 86_400_000))
      } catch (err) {
        this.stats.errors++
        this.opts.onError?.(err)
      }
    }
  }

  /** A repair station or manufacturer releases a part to an operator. */
  private async issue(
    opts: { agedDays?: number; narrate?: boolean } = {},
  ): Promise<Pending | null> {
    const cast = this.cast()
    const issuers = cast.filter(
      (o) => (o.kind === 'mro' || o.kind === 'oem') && this.known(o.handle),
    )
    const operators = cast.filter(
      (o) => (o.kind === 'operator' || o.kind === 'lessor') && this.known(o.handle),
    )
    const issuer = this.pickOne(issuers)
    const operator = this.pickOne(operators)
    if (!issuer || !operator) return null

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
      // The generator's clock, not the wall clock. They are the same in
      // production and were not in a test, which is how a certificate ended up
      // signed after the inspection that received it — the injected clock is
      // worthless if the one date that matters is built behind its back.
      now: new Date(this.now()),
      // A live release claims to have been signed today, because it is being
      // published today. Only the backlog claims the past, and it says how
      // far back rather than leaving it to a hash of the seed — an arbitrary
      // date is what made a part released one minute ago quote as having been
      // released sixty-eight days ago.
      agedDays: opts.agedDays ?? 0,
      narrator: opts.narrate === false ? null : (this.opts.narrator ?? null),
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

    // Decide now whether anybody will ever vouch for this one, rather than
    // rolling at inspection time. Most releases are checked by somebody; a
    // proportion simply never are, because the operator did not get round to
    // it or did not publish. A release nobody will attest is never queued, so
    // it just sits in the feed unaccompanied — which is exactly what an
    // unattested release looks like from outside.
    const coverage = THIN_STATIONS.has(issuer.handle.split('.')[0] ?? '')
      ? THIN_COVERAGE
      : COVERAGE
    if (this.rand() >= coverage) return null

    const queued: Pending = {
      subject: { uri: written.uri, cid: written.cid },
      issuerHandle: issuer.handle,
      partNumber: String(form.partNumber),
      serialNumber: String(form.serialNumber),
      description: String(form.description ?? ''),
      // Who received the part is NOT on the form — an 8130-3 says who issued
      // it, not who it went to. The generator remembers so it can have the
      // right operator publish the attestation, which is how the protocol
      // expresses that somebody checked.
      operatorHandle: operator.handle,
      completedAt: new Date(String(form.completedAt)),
      at: this.now(),
    }
    this.pending.push(queued)

    // Bounded, but generously: the queue is stock in transit, and the seeded
    // history is most of it. Trimming to twenty would throw away the aged
    // parts that make an inspection read as an inspection.
    if (this.pending.length > 80) this.pending.shift()

    return queued
  }
}
