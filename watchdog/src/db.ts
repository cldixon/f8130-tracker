import { Pool } from 'pg'

/**
 * The watchdog's own read model.
 *
 * Written from scratch rather than imported from the other AppView. The two
 * services share the record schemas — that is the protocol, and the whole
 * point is that anyone can read it — but they share no interpretation. This
 * one asks a question the other never asks, and gets to answer it however it
 * likes without anyone's agreement.
 */

export type IssuerRow = {
  did: string
  handle: string | null
  releases: number
  /** Distinct operators who rejected. One operator rejecting twice is one voice. */
  distinctRejectors: number
  totalRejections: number
  firstSeen: Date | null
}

export type RejectionRow = {
  verifierDid: string
  partNumber: string
  serialNumber: string
  outcome: string
  note: string | null
  receivedAt: Date
  observedAt: Date
}

/** The threshold at which this AppView considers a pattern worth naming. */
export const FLAG_THRESHOLD = 2

export class WatchdogIndex {
  constructor(private readonly pool: Pool) {}

  static fromUrl(connectionString: string): WatchdogIndex {
    return new WatchdogIndex(new Pool({ connectionString, max: 5 }))
  }

  async ready(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1 FROM release LIMIT 1')
      return true
    } catch {
      // The Go ingest owns the schema; until it has run there is nothing here.
      return false
    }
  }

  /**
   * Issuers ranked by how many independent operators refused their parts.
   *
   * Counting *distinct* verifiers is the entire scoring rule. A single
   * disgruntled customer rejecting ten parts is a commercial dispute; three
   * unrelated operators independently refusing is a pattern, and it is a
   * pattern no one of them could see on their own.
   */
  async issuers(): Promise<IssuerRow[]> {
    const { rows } = await this.pool.query(`
      SELECT
        a.did,
        a.handle,
        COALESCE(r.releases, 0)            AS releases,
        COALESCE(x.distinct_rejectors, 0)  AS distinct_rejectors,
        COALESCE(x.total_rejections, 0)    AS total_rejections,
        a.first_seen
      FROM actor a
      LEFT JOIN (
        SELECT issuer_did, COUNT(*) AS releases
        FROM release GROUP BY issuer_did
      ) r ON r.issuer_did = a.did
      LEFT JOIN (
        SELECT issuer_did,
               COUNT(DISTINCT verifier_did) AS distinct_rejectors,
               COUNT(*)                     AS total_rejections
        FROM acceptance
        WHERE outcome = 'rejected'
        GROUP BY issuer_did
      ) x ON x.issuer_did = a.did
      WHERE COALESCE(r.releases, 0) > 0 OR COALESCE(x.distinct_rejectors, 0) > 0
      ORDER BY distinct_rejectors DESC, total_rejections DESC, releases DESC
    `)
    return rows.map((r) => ({
      did: r.did,
      handle: r.handle === r.did ? null : r.handle,
      releases: Number(r.releases),
      distinctRejectors: Number(r.distinct_rejectors),
      totalRejections: Number(r.total_rejections),
      firstSeen: r.first_seen,
    }))
  }

  async rejectionsFor(issuerDid: string): Promise<RejectionRow[]> {
    const { rows } = await this.pool.query(
      `SELECT verifier_did, part_number, serial_number, outcome, note,
              received_at, observed_at
       FROM acceptance
       WHERE issuer_did = $1 AND outcome IN ('rejected', 'discrepancy')
       ORDER BY received_at DESC`,
      [issuerDid],
    )
    return rows.map((r) => ({
      verifierDid: r.verifier_did,
      partNumber: r.part_number,
      serialNumber: r.serial_number,
      outcome: r.outcome,
      note: r.note,
      receivedAt: r.received_at,
      observedAt: r.observed_at,
    }))
  }

  async issuer(did: string): Promise<IssuerRow | null> {
    const all = await this.issuers()
    return all.find((i) => i.did === did) ?? null
  }

  async cursor(): Promise<number | null> {
    try {
      const { rows } = await this.pool.query('SELECT seq FROM ingest_cursor WHERE id = 1')
      return rows[0] ? Number(rows[0].seq) : null
    } catch {
      return null
    }
  }
}
