import { Pool } from 'pg'

import type {
  ActorRow,
  FeedEvent,
  AcceptanceRow,
  DisputeRow,
  IssuerStat,
  ReadIndex,
  ReleaseRow,
} from './index-port.js'

/**
 * A timestamp from either shape of row.
 *
 * `SELECT *` yields a Date, because node-postgres parses timestamptz. The feed
 * wraps its rows in `to_jsonb` so both record kinds can be merged in one
 * query, and JSON has no date type, so the same column arrives as an ISO
 * string. These mappers declared Date and passed either through untouched,
 * which held for exactly as long as nothing called a Date method on the
 * result — until a feed card started showing the date on the document rather
 * than the moment the row was observed, and the front page threw
 * "at.getTime is not a function".
 *
 * Coercing at the boundary that asserts the type, rather than at each call
 * site. `new Date(aDate)` is a clone, so the column path is unaffected.
 */
function at(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v))
}

export function toRelease(r: Record<string, any>): ReleaseRow {
  return {
    cid: r.cid,
    uri: r.uri,
    issuerDid: r.issuer_did,
    prevUri: r.prev_uri,
    prevCid: r.prev_cid,
    approvingAuthority: r.approving_authority,
    formNumber: r.form_number,
    organizationName: r.organization_name,
    organizationAddress: r.organization_address,
    description: r.description,
    partNumber: r.part_number,
    serialNumber: r.serial_number,
    signerCert: r.signer_cert,
    completedAt: at(r.completed_at),
    observedAt: at(r.observed_at),
  }
}

export function toAcceptance(r: Record<string, any>): AcceptanceRow {
  return {
    cid: r.cid,
    uri: r.uri,
    subjectUri: r.subject_uri,
    subjectCid: r.subject_cid,
    issuerDid: r.issuer_did,
    verifierDid: r.verifier_did,
    partNumber: r.part_number,
    serialNumber: r.serial_number,
    outcome: r.outcome,
    note: r.note,
    receivedAt: at(r.received_at),
    observedAt: at(r.observed_at),
  }
}

export function toDispute(r: Record<string, any>): DisputeRow {
  return {
    cid: r.cid,
    uri: r.uri,
    subjectUri: r.subject_uri,
    subjectCid: r.subject_cid,
    authorDid: r.author_did,
    response: r.response,
    disputedAt: at(r.disputed_at),
    observedAt: at(r.observed_at),
  }
}

/**
 * The read side of the index maintained by the Go ingest service.
 *
 * Strictly read-only. The web tier never writes to this database: everything in
 * it is derived from the firehose, and anything the web tier wanted to add
 * would be, by definition, not derived.
 */
export class PostgresIndex implements ReadIndex {
  constructor(private readonly pool: Pool) {}

  static fromUrl(connectionString: string): PostgresIndex {
    // Pooled connection: the web tier is many short queries across replicas,
    // unlike ingest's single long-lived stream.
    return new PostgresIndex(new Pool({ connectionString, max: 10 }))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /**
   * The two record kinds, merged on the observer's own clock.
   *
   * A UNION rather than two queries the caller interleaves, so `limit` means
   * the newest N events rather than the newest N of each — otherwise a burst
   * of releases would push every verdict off the page.
   */
  async feed(params: { limit: number; since?: Date }): Promise<FeedEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT kind, observed_at, payload FROM (
         SELECT 'release'    AS kind, observed_at, to_jsonb(r) AS payload FROM release r
         UNION ALL
         SELECT 'acceptance' AS kind, observed_at, to_jsonb(a) AS payload FROM acceptance a
       ) events
       WHERE $2::timestamptz IS NULL OR observed_at > $2
       ORDER BY observed_at DESC, kind
       LIMIT $1`,
      [params.limit, params.since ?? null],
    )
    return rows.map((r: any) =>
      r.kind === 'release'
        ? {
            kind: 'release' as const,
            at: at(r.observed_at),
            release: toRelease(r.payload),
          }
        : {
            kind: 'verdict' as const,
            at: at(r.observed_at),
            verdict: toAcceptance(r.payload),
          },
    )
  }

  async recentReleases(limit: number): Promise<ReleaseRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM release ORDER BY observed_at DESC LIMIT $1`,
      [limit],
    )
    return rows.map(toRelease)
  }

  async releasesForPart(
    partNumber: string,
    serialNumber: string,
  ): Promise<ReleaseRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM release
       WHERE part_number = $1 AND serial_number = $2
       ORDER BY completed_at DESC`,
      [partNumber, serialNumber],
    )
    return rows.map(toRelease)
  }

  async chain(cid: string, maxDepth: number): Promise<ReleaseRow[]> {
    const { rows } = await this.pool.query(
      `WITH RECURSIVE chain AS (
         SELECT r.*, 1 AS depth FROM release r WHERE r.cid = $1
         UNION ALL
         SELECT r.*, c.depth + 1
         FROM release r JOIN chain c ON r.cid = c.prev_cid
         WHERE c.depth < $2
       )
       SELECT * FROM chain ORDER BY depth`,
      [cid, maxDepth],
    )
    return rows.map(toRelease)
  }

  async acceptancesForSubjects(cids: string[]): Promise<AcceptanceRow[]> {
    if (cids.length === 0) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM acceptance WHERE subject_cid = ANY($1) ORDER BY received_at DESC`,
      [cids],
    )
    return rows.map(toAcceptance)
  }

  async disputesForSubjects(cids: string[]): Promise<DisputeRow[]> {
    if (cids.length === 0) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM dispute WHERE subject_cid = ANY($1) ORDER BY disputed_at ASC`,
      [cids],
    )
    return rows.map(toDispute)
  }

  async releaseByUri(uri: string): Promise<ReleaseRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM release WHERE uri = $1`, [uri])
    return rows[0] ? toRelease(rows[0]) : null
  }

  async releasesByUris(uris: string[]): Promise<Map<string, ReleaseRow>> {
    const out = new Map<string, ReleaseRow>()
    if (uris.length === 0) return out
    const { rows } = await this.pool.query(
      `SELECT * FROM release WHERE uri = ANY($1)`,
      [uris],
    )
    for (const r of rows) out.set(r.uri, toRelease(r))
    return out
  }

  async issuerStats(): Promise<IssuerStat[]> {
    const { rows } = await this.pool.query(
      `SELECT a.did,
              COALESCE(r.releases, 0)          AS releases,
              COALESCE(x.distinct_rejectors, 0) AS distinct_rejectors
       FROM actor a
       LEFT JOIN (
         SELECT issuer_did, COUNT(*) AS releases
         FROM release GROUP BY issuer_did
       ) r ON r.issuer_did = a.did
       LEFT JOIN (
         SELECT issuer_did, COUNT(DISTINCT verifier_did) AS distinct_rejectors
         FROM acceptance WHERE outcome = 'rejected' GROUP BY issuer_did
       ) x ON x.issuer_did = a.did
       WHERE COALESCE(r.releases, 0) > 0 OR COALESCE(x.distinct_rejectors, 0) > 0
       ORDER BY distinct_rejectors DESC, releases DESC`,
    )
    return rows.map((r) => ({
      did: r.did,
      releases: Number(r.releases),
      distinctRejectors: Number(r.distinct_rejectors),
    }))
  }

  async actorsFor(dids: string[]): Promise<Map<string, ActorRow>> {
    const out = new Map<string, ActorRow>()
    if (dids.length === 0) return out
    const { rows } = await this.pool.query(
      `SELECT did, org_name, kind FROM actor WHERE did = ANY($1)`,
      [dids],
    )
    for (const r of rows) {
      out.set(r.did, { did: r.did, displayName: r.org_name, kind: r.kind })
    }
    return out
  }

  async handleFor(did: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT handle FROM actor WHERE did = $1`,
      [did],
    )
    return rows[0]?.handle ?? null
  }
}
