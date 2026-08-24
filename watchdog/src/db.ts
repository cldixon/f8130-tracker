import { Pool } from 'pg'

/**
 * The watchdog's own read model.
 *
 * Written from scratch rather than imported from the other AppView. The two
 * services share the record schemas — that is the protocol, and the whole
 * point is that anyone can read it — but they share no interpretation. This
 * one asks questions the other never asks, and gets to answer them however it
 * likes without anyone's agreement.
 *
 * Every question here is answered from public records alone. Nothing depends
 * on a party volunteering an opinion, which matters because the network
 * carries no negative claims and never will: a party who cannot verify a
 * document cannot prove that to anybody, so there is no rejection to count.
 * What is left is arithmetic over what issuers themselves published, and it
 * turns out to be the stronger material — a station cannot decline to
 * participate in a check it is not being asked to make.
 */

export type IssuerRow = {
  did: string
  handle: string | null
  releases: number
  /** How many of those releases somebody publicly said they had checked. */
  attested: number
  firstSeen: Date | null
}

/**
 * One serial claiming more than one origin.
 *
 * A part legitimately passes through many shops, so several releases naming
 * one serial is ordinary — that is a service history. What is not ordinary is
 * more than one release for that serial claiming to be the *first*: a record
 * with no predecessor asserts that the part began there. Two such claims for
 * one part number and serial cannot both be true, and serial cloning is a
 * documented way bogus parts enter the system.
 *
 * No party is accused of anything by this. It is a contradiction between
 * published records, and the reader can go and look at both.
 */
export type ClonedSerial = {
  partNumber: string
  serialNumber: string
  births: number
  releases: number
  stations: number
  issuers: string[]
}

/**
 * A release whose predecessor this observer has never seen.
 *
 * Weaker than it looks, and the wording matters. It can mean the record was
 * never published, which is a real problem — a history that references a shop
 * visit nobody can produce. It can equally mean this observer has not caught
 * up, or was not subscribed when it went by. The honest claim is about what
 * this index holds, not about what exists.
 */
export type DanglingLink = {
  cid: string
  uri: string
  issuerDid: string
  partNumber: string
  serialNumber: string
  prevUri: string | null
  prevCid: string | null
  completedAt: Date
}

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
   * Every issuer, with how much of its output anybody has vouched for.
   *
   * Reported as two numbers rather than a rate or a score, because the ratio
   * invites a reading the data cannot support. Thin coverage most often means
   * nobody got round to publishing a check; it is a shape that makes a reader
   * go and look, not a finding. The ordering puts the largest publishers
   * first — volume is the thing worth reading down from.
   */
  async issuers(): Promise<IssuerRow[]> {
    const { rows } = await this.pool.query(`
      SELECT
        a.did,
        a.handle,
        COALESCE(r.releases, 0) AS releases,
        COALESCE(t.attested, 0) AS attested,
        a.first_seen
      FROM actor a
      LEFT JOIN (
        SELECT issuer_did, COUNT(*) AS releases
        FROM release GROUP BY issuer_did
      ) r ON r.issuer_did = a.did
      LEFT JOIN (
        SELECT rel.issuer_did, COUNT(DISTINCT att.cid) AS attested
        FROM attestation att
        JOIN release rel ON rel.cid = att.subject_cid
        GROUP BY rel.issuer_did
      ) t ON t.issuer_did = a.did
      WHERE COALESCE(r.releases, 0) > 0
      ORDER BY releases DESC, attested ASC
    `)
    return rows.map((r) => ({
      did: r.did,
      handle: r.handle === r.did ? null : r.handle,
      releases: Number(r.releases),
      attested: Number(r.attested),
      firstSeen: r.first_seen,
    }))
  }

  /** Serials with more than one release claiming to be the part's first. */
  async clonedSerials(): Promise<ClonedSerial[]> {
    const { rows } = await this.pool.query(`
      SELECT part_number, serial_number,
             COUNT(*) FILTER (WHERE prev_cid IS NULL) AS births,
             COUNT(*)                                 AS releases,
             COUNT(DISTINCT issuer_did)               AS stations,
             ARRAY_AGG(DISTINCT issuer_did)           AS issuers
      FROM release
      GROUP BY part_number, serial_number
      HAVING COUNT(*) FILTER (WHERE prev_cid IS NULL) > 1
      ORDER BY births DESC, releases DESC
    `)
    return rows.map((r) => ({
      partNumber: r.part_number,
      serialNumber: r.serial_number,
      births: Number(r.births),
      releases: Number(r.releases),
      stations: Number(r.stations),
      issuers: r.issuers ?? [],
    }))
  }

  /** Releases pointing back at a record this index does not hold. */
  async danglingLinks(): Promise<DanglingLink[]> {
    const { rows } = await this.pool.query(`
      SELECT r.cid, r.uri, r.issuer_did, r.part_number, r.serial_number,
             r.prev_uri, r.prev_cid, r.completed_at
      FROM release r
      LEFT JOIN release p ON p.cid = r.prev_cid
      WHERE r.prev_cid IS NOT NULL AND p.cid IS NULL
      ORDER BY r.completed_at DESC
    `)
    return rows.map((r) => ({
      cid: r.cid,
      uri: r.uri,
      issuerDid: r.issuer_did,
      partNumber: r.part_number,
      serialNumber: r.serial_number,
      prevUri: r.prev_uri,
      prevCid: r.prev_cid,
      completedAt: r.completed_at,
    }))
  }

  async issuer(did: string): Promise<IssuerRow | null> {
    const all = await this.issuers()
    return all.find((i) => i.did === did) ?? null
  }

  /** The releases one issuer published, with whether anybody vouched. */
  async releasesFor(issuerDid: string): Promise<
    {
      cid: string
      partNumber: string
      serialNumber: string
      description: string
      completedAt: Date
      attested: number
    }[]
  > {
    const { rows } = await this.pool.query(
      `SELECT r.cid, r.part_number, r.serial_number, r.description,
              r.completed_at, COUNT(att.cid) AS attested
       FROM release r
       LEFT JOIN attestation att ON att.subject_cid = r.cid
       WHERE r.issuer_did = $1
       GROUP BY r.cid, r.part_number, r.serial_number, r.description, r.completed_at
       ORDER BY r.completed_at DESC`,
      [issuerDid],
    )
    return rows.map((r) => ({
      cid: r.cid,
      partNumber: r.part_number,
      serialNumber: r.serial_number,
      description: r.description,
      completedAt: r.completed_at,
      attested: Number(r.attested),
    }))
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
