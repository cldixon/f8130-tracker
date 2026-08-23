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
  ActorRow,
  AcceptanceRow,
  DisputeRow,
  FeedEvent,
  IssuerStat,
  ReadIndex,
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
  private readonly verdicts: AcceptanceRow[] = []
  private readonly disputes: DisputeRow[] = []
  private readonly handles = new Map<string, string>()
  private readonly actors = new Map<string, ActorRow>()

  addRelease(row: ReleaseRow): void {
    if (this.releases.some((r) => r.cid === row.cid)) return
    this.releases.push(row)
  }

  addVerdict(row: AcceptanceRow): void {
    if (this.verdicts.some((v) => v.cid === row.cid)) return
    this.verdicts.push(row)
  }

  addDispute(row: DisputeRow): void {
    if (this.disputes.some((d) => d.cid === row.cid)) return
    this.disputes.push(row)
  }

  setHandle(did: string, handle: string): void {
    this.handles.set(did, handle)
  }

  /** What a station record would have told an observer on the live path. */
  setActor(row: ActorRow): void {
    this.actors.set(row.did, row)
  }

  /** Every release, newest observation first. Used by tests and the dashboard. */
  get size(): { releases: number; verdicts: number; disputes: number } {
    return {
      releases: this.releases.length,
      verdicts: this.verdicts.length,
      disputes: this.disputes.length,
    }
  }

  async feed(params: { limit: number; since?: Date }): Promise<FeedEvent[]> {
    const events: FeedEvent[] = [
      ...this.releases.map((r) => ({ kind: 'release' as const, at: r.observedAt, release: r })),
      ...this.verdicts.map((v) => ({ kind: 'verdict' as const, at: v.observedAt, verdict: v })),
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

  async acceptancesForSubjects(cids: string[]): Promise<AcceptanceRow[]> {
    const wanted = new Set(cids)
    return this.verdicts
      .filter((v) => wanted.has(v.subjectCid))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
  }

  async disputesForSubjects(cids: string[]): Promise<DisputeRow[]> {
    const wanted = new Set(cids)
    return this.disputes
      .filter((d) => wanted.has(d.subjectCid))
      .sort((a, b) => a.disputedAt.getTime() - b.disputedAt.getTime())
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
    const dids = new Set([
      ...this.releases.map((r) => r.issuerDid),
      ...this.verdicts.map((v) => v.issuerDid),
    ])
    return [...dids]
      .map((did) => ({
        did,
        releases: this.releases.filter((r) => r.issuerDid === did).length,
        // Distinct verifiers, not distinct rejections: one disgruntled operator
        // rejecting ten parts is a commercial dispute, not a pattern.
        distinctRejectors: new Set(
          this.verdicts
            .filter((v) => v.issuerDid === did && v.outcome === 'rejected')
            .map((v) => v.verifierDid),
        ).size,
      }))
      .sort((a, b) => b.distinctRejectors - a.distinctRejectors)
  }

  async actorsFor(dids: string[]): Promise<Map<string, ActorRow>> {
    const out = new Map<string, ActorRow>()
    for (const did of dids) {
      const a = this.actors.get(did)
      if (a) out.set(did, a)
    }
    return out
  }

  async handleFor(did: string): Promise<string | null> {
    return this.handles.get(did) ?? null
  }
}
