/**
 * A read model held in memory.
 *
 * Demo mode has no Postgres, and a front page that says "browsing needs a
 * database" is a poor way to demonstrate a feed. This is the same ReadIndex
 * interface backed by arrays, so the feed, the dashboard and the part timeline
 * run identically with or without infrastructure.
 *
 * One honest difference from the live path, worth stating rather than hiding:
 * a record reaches Postgres by way of the firehose, verified commit by
 * verified commit, whereas here the writer appends directly. The signing and
 * the proofs in demo mode are real; the observation is not independent. That is
 * the same simplification demo mode already makes about hosting.
 */

import { PUBLIC_FIELDS, type Bundle } from '@f8130/core'

import type {
  AccountStats,
  ActorRow,
  AttestationRow,
  FeedEvent,
  IssuerStat,
  ReadIndex,
  Relation,
  RelationKind,
  ReleaseRow,
} from './index-port.js'

/**
 * Turns a freshly written release into the row an observer would have indexed.
 *
 * Shared by the demo writer and by the bootstrap that pre-loads the two
 * fixture certificates, so there is one place that knows which nine blocks
 * survive the trip to a public index.
 */
export function releaseRow(params: {
  uri: string
  cid: string
  bundle: Bundle
  prev?: { uri: string; cid: string }
  observedAt: Date
}): ReleaseRow {
  const v = params.bundle.values
  return {
    cid: params.cid,
    uri: params.uri,
    // at://<did>/<collection>/<rkey>
    issuerDid: params.uri.split('/')[2] ?? '',
    prevUri: params.prev?.uri ?? null,
    prevCid: params.prev?.cid ?? null,
    ...(Object.fromEntries(
      PUBLIC_FIELDS.map((f) => [f, String(v[f] ?? '')]),
    ) as Omit<ReleaseRow, 'cid' | 'uri' | 'issuerDid' | 'prevUri' | 'prevCid' | 'completedAt' | 'observedAt'>),
    completedAt: new Date(String(v.completedAt)),
    observedAt: params.observedAt,
  }
}

export class MemoryIndex implements ReadIndex {
  private readonly releases: ReleaseRow[] = []
  private readonly attestations: AttestationRow[] = []
  private readonly handles = new Map<string, string>()
  private readonly actors = new Map<string, ActorRow>()

  addRelease(row: ReleaseRow): void {
    if (this.releases.some((r) => r.cid === row.cid)) return
    this.releases.push(row)
  }

  addAttestation(row: AttestationRow): void {
    if (this.attestations.some((a) => a.cid === row.cid)) return
    this.attestations.push(row)
  }

  setHandle(did: string, handle: string): void {
    this.handles.set(did, handle)
  }

  /**
   * What a station record would have told an observer on the live path.
   *
   * Takes a partial row and fills the rest in, because most callers know a
   * name and a role and nothing else. The handle defaults to the DID for the
   * same reason ensureActor's does: an unresolved handle is the DID, and every
   * reader already guards for that.
   */
  setActor(row: Partial<ActorRow> & { did: string }): void {
    const held = this.actors.get(row.did)
    this.actors.set(row.did, {
      handle: this.handles.get(row.did) ?? row.did,
      displayName: null,
      kind: null,
      cage: null,
      certificate: null,
      ...held,
      ...row,
      // First sight, and it stays first sight. On the live path first_seen is
      // written once by ensureActor and left alone by every later station
      // record; here the writer calls this on every single write, so without
      // the pin an account's tenure would restart at its most recent record —
      // which is the opposite of what the field means.
      firstSeen: held?.firstSeen ?? row.firstSeen ?? new Date(),
    })
  }

  /** Every release, newest observation first. Used by tests and the dashboard. */
  get size(): { releases: number; attestations: number } {
    return {
      releases: this.releases.length,
      attestations: this.attestations.length,
    }
  }

  async feed(params: { limit: number; since?: Date }): Promise<FeedEvent[]> {
    const events: FeedEvent[] = [
      ...this.releases.map((r) => ({ kind: 'release' as const, at: r.observedAt, release: r })),
      ...this.attestations.map((a) => ({
        kind: 'attestation' as const,
        at: a.observedAt,
        attestation: a,
      })),
    ]
    return events
      .filter((e) => !params.since || e.at.getTime() > params.since.getTime())
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, params.limit)
  }

  async recentReleases(limit: number): Promise<ReleaseRow[]> {
    return [...this.releases]
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
      .slice(0, limit)
  }

  async releasesForPart(partNumber: string, serialNumber: string): Promise<ReleaseRow[]> {
    return this.releases
      .filter((r) => r.partNumber === partNumber && r.serialNumber === serialNumber)
      .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime())
  }

  async chain(cid: string, maxDepth: number): Promise<ReleaseRow[]> {
    const byCid = new Map(this.releases.map((r) => [r.cid, r]))
    const out: ReleaseRow[] = []
    let cursor: string | null = cid
    while (cursor && out.length < maxDepth) {
      const row: ReleaseRow | undefined = byCid.get(cursor)
      if (!row) break
      out.push(row)
      // Follows prev_cid, so a predecessor rewritten since it was referenced
      // simply fails to join and shows up as a gap — same as the SQL.
      cursor = row.prevCid
    }
    return out
  }

  async attestationsForSubjects(cids: string[]): Promise<AttestationRow[]> {
    const wanted = new Set(cids)
    return this.attestations
      .filter((a) => wanted.has(a.subjectCid))
      .sort((a, b) => b.verifiedAt.getTime() - a.verifiedAt.getTime())
  }

  async releaseByUri(uri: string): Promise<ReleaseRow | null> {
    return this.releases.find((r) => r.uri === uri) ?? null
  }

  async releasesByUris(uris: string[]): Promise<Map<string, ReleaseRow>> {
    const wanted = new Set(uris)
    const out = new Map<string, ReleaseRow>()
    for (const r of this.releases) if (wanted.has(r.uri)) out.set(r.uri, r)
    return out
  }

  async issuerStats(): Promise<IssuerStat[]> {
    // An attestation names no issuer, so the count comes from joining back to
    // the release it covers. That keeps the issuer the one on the record in
    // the issuer's own repository rather than a claim somebody else made.
    const byCid = new Map(this.releases.map((r) => [r.cid, r]))
    const dids = new Set(this.releases.map((r) => r.issuerDid))
    return [...dids]
      .map((did) => ({
        did,
        releases: this.releases.filter((r) => r.issuerDid === did).length,
        // Distinct releases covered, not attestations counted, so this can
        // never exceed the total it is shown against.
        attested: new Set(
          this.attestations
            .filter((a) => byCid.get(a.subjectCid)?.issuerDid === did)
            .map((a) => a.subjectCid),
        ).size,
      }))
      .sort((a, b) => b.releases - a.releases)
  }

  async actorsFor(dids: string[]): Promise<Map<string, ActorRow>> {
    const out = new Map<string, ActorRow>()
    for (const did of dids) {
      const a = this.actors.get(did)
      if (a) out.set(did, this.withHandle(a))
    }
    return out
  }

  async handleFor(did: string): Promise<string | null> {
    return this.handles.get(did) ?? null
  }

  async accountFor(handleOrDid: string): Promise<ActorRow | null> {
    const known = this.actors.get(handleOrDid)
    if (known) return this.withHandle(known)

    for (const [did, handle] of this.handles) {
      if (handle !== handleOrDid && did !== handleOrDid) continue
      const row = this.actors.get(did)
      return row
        ? this.withHandle(row)
        : // Publishing without a profile is a real state and the page says so,
          // so it answers with a row rather than with nothing.
          {
            did,
            handle,
            displayName: null,
            kind: null,
            cage: null,
            certificate: null,
            firstSeen: null,
          }
    }
    return null
  }

  async releasesByIssuer(did: string, limit: number): Promise<ReleaseRow[]> {
    return this.releases
      .filter((r) => r.issuerDid === did)
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
      .slice(0, limit)
  }

  async attestationsByVerifier(
    did: string,
    limit: number,
  ): Promise<AttestationRow[]> {
    return this.attestations
      .filter((a) => a.verifierDid === did)
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
      .slice(0, limit)
  }

  async accountStats(did: string): Promise<AccountStats> {
    const mine = this.releases.filter((r) => r.issuerDid === did)
    const covered = new Set(this.attestations.map((a) => a.subjectCid))
    return {
      releases: mine.length,
      attested: mine.filter((r) => covered.has(r.cid)).length,
      checks: this.attestations.filter((a) => a.verifierDid === did).length,
    }
  }

  async relatedAccounts(did: string, limit: number): Promise<Relation[]> {
    const byCid = new Map(this.releases.map((r) => [r.cid, r]))
    const mine = this.releases.filter((r) => r.issuerDid === did)
    const mineCids = new Set(mine.map((r) => r.cid))

    // Counted per kind and per counterparty, the same shape the SQL produces.
    const tally = new Map<string, number>()
    const add = (kind: RelationKind, other: string) => {
      // A station that certified the same part twice is a fact about the part,
      // not a relationship with itself.
      if (!other || other === did) return
      const key = `${kind}\u0000${other}`
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }

    for (const a of this.attestations) {
      const subject = byCid.get(a.subjectCid)
      if (!subject) continue
      if (subject.issuerDid === did) add('vouchedFor', a.verifierDid)
      if (a.verifierDid === did) add('vouchedBy', subject.issuerDid)
    }

    for (const r of this.releases) {
      // The predecessor of one of this account's releases: whoever certified
      // the part before it did.
      if (r.issuerDid === did && r.prevCid) {
        add('earlier', byCid.get(r.prevCid)?.issuerDid ?? '')
      }
      // And the mirror: a release naming one of this account's as its
      // predecessor is whoever certified the part next.
      if (r.prevCid && mineCids.has(r.prevCid)) add('later', r.issuerDid)
    }

    const all: Relation[] = [...tally].map(([key, count]) => {
      const [kind, other] = key.split('\u0000')
      return { kind: kind as RelationKind, did: other!, count }
    })

    // Ranked within each kind, so `limit` bounds every relationship rather
    // than letting the largest one consume the whole budget.
    const out: Relation[] = []
    for (const kind of ['earlier', 'later', 'vouchedBy', 'vouchedFor'] as const) {
      out.push(
        ...all
          .filter((r) => r.kind === kind)
          .sort((x, y) => y.count - x.count || x.did.localeCompare(y.did))
          .slice(0, limit),
      )
    }
    return out
  }

  /**
   * The handle as most recently resolved, rather than as it was when the
   * profile was recorded.
   *
   * The two arrive separately — setHandle from the writer, setActor from a
   * station record — and in either order, so pinning the handle onto the
   * profile row at write time left whichever came second unused.
   */
  private withHandle(row: ActorRow): ActorRow {
    return { ...row, handle: this.handles.get(row.did) ?? row.handle }
  }
}
