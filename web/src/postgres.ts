import { Pool } from 'pg'

import type {
  AcceptanceRow,
  IssuerStat,
  ReadIndex,
  ReleaseRow,
} from './index-port.js'

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

  private static toRelease(r: Record<string, any>): ReleaseRow {
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
      completedAt: r.completed_at,
      observedAt: r.observed_at,
    }
  }

  private static toAcceptance(r: Record<string, any>): AcceptanceRow {
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
      receivedAt: r.received_at,
      observedAt: r.observed_at,
    }
  }

  async recentReleases(limit: number): Promise<ReleaseRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM release ORDER BY observed_at DESC LIMIT $1`,
      [limit],
    )
    return rows.map(PostgresIndex.toRelease)
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
    return rows.map(PostgresIndex.toRelease)
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
    return rows.map(PostgresIndex.toRelease)
  }

  async acceptancesForSubjects(cids: string[]): Promise<AcceptanceRow[]> {
    if (cids.length === 0) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM acceptance WHERE subject_cid = ANY($1) ORDER BY received_at DESC`,
      [cids],
    )
    return rows.map(PostgresIndex.toAcceptance)
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

  async handleFor(did: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT handle FROM actor WHERE did = $1`,
      [did],
    )
    return rows[0]?.handle ?? null
  }
}
