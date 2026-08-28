import { Pool } from 'pg'

import type {
  AccountStats,
  ActorRow,
  FeedEvent,
  AttestationRow,
  IssuerStat,
  ReadIndex,
  Relation,
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

export function toAttestation(r: Record<string, any>): AttestationRow {
  return {
    cid: r.cid,
    uri: r.uri,
    subjectUri: r.subject_uri,
    subjectCid: r.subject_cid,
    verifierDid: r.verifier_did,
    // at://<did>/<collection>/<rkey>. Derived rather than read off the record,
    // because the record does not carry it: who issued the release is a fact
    // about the release's own repository, and restating it on the attestation
    // would only create a second place for it to disagree.
    issuerDid: String(r.subject_uri ?? '').split('/')[2] ?? '',
    verifiedAt: at(r.verified_at),
    observedAt: at(r.observed_at),
  }
}

/**
 * The actor columns, named once.
 *
 * Three statements read this table and they used to select different subsets,
 * which is how the profile page nearly shipped with a CAGE code the feed's
 * lookup did not return.
 */
const ACTOR_COLUMNS =
  `SELECT did, handle, org_name, kind, cage, cert_number, first_seen FROM actor`

export function toActor(r: Record<string, any>): ActorRow {
  return {
    did: r.did,
    handle: r.handle,
    displayName: r.org_name ?? null,
    kind: r.kind ?? null,
    cage: r.cage ?? null,
    certificate: r.cert_number ?? null,
    firstSeen: r.first_seen ? at(r.first_seen) : null,
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
         SELECT 'attestation' AS kind, observed_at, to_jsonb(a) AS payload FROM attestation a
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
            kind: 'attestation' as const,
            at: at(r.observed_at),
            attestation: toAttestation(r.payload),
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

  async attestationsForSubjects(cids: string[]): Promise<AttestationRow[]> {
    if (cids.length === 0) return []
    const { rows } = await this.pool.query(
      `SELECT * FROM attestation WHERE subject_cid = ANY($1) ORDER BY verified_at DESC`,
      [cids],
    )
    return rows.map(toAttestation)
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
    // Attestations join back to the release rather than carrying an issuer of
    // their own, so the issuer counted here is always the one on the record in
    // the issuer's own repository — never a claim the attesting party made
    // about who they were dealing with.
    const { rows } = await this.pool.query(
      `SELECT a.did,
              COALESCE(r.releases, 0) AS releases,
              COALESCE(t.attested, 0) AS attested
       FROM actor a
       LEFT JOIN (
         SELECT issuer_did, COUNT(*) AS releases
         FROM release GROUP BY issuer_did
       ) r ON r.issuer_did = a.did
       LEFT JOIN (
         -- Distinct releases, not distinct attestations. Two operators
         -- checking the same certificate is one release covered, and counting
         -- the records let this column read "4 of 3".
         SELECT rel.issuer_did, COUNT(DISTINCT rel.cid) AS attested
         FROM attestation att
         JOIN release rel ON rel.cid = att.subject_cid
         GROUP BY rel.issuer_did
       ) t ON t.issuer_did = a.did
       WHERE COALESCE(r.releases, 0) > 0
       ORDER BY releases DESC`,
    )
    return rows.map((r) => ({
      did: r.did,
      releases: Number(r.releases),
      attested: Number(r.attested),
    }))
  }

  /**
   * All four relationships in one statement.
   *
   * A UNION of four aggregates rather than four round trips, ranked per kind
   * so `limit` bounds each relationship instead of letting the largest one
   * consume the whole budget. Every branch joins through `release`, so the
   * organization on the far end is always the one on the record in its own
   * repository rather than a name somebody else wrote down.
   *
   * The two chain branches are the reason `release_prev_cid_idx` exists;
   * without it the "later" direction is a sequential scan of every release.
   */
  async relatedAccounts(did: string, limit: number): Promise<Relation[]> {
    const { rows } = await this.pool.query(
      `WITH rel AS (
         SELECT 'vouchedFor' AS kind, a.verifier_did AS did, COUNT(*) AS n
           FROM attestation a JOIN release r ON r.cid = a.subject_cid
          WHERE r.issuer_did = $1 AND a.verifier_did <> $1
          GROUP BY 1, 2
         UNION ALL
         SELECT 'vouchedBy', r.issuer_did, COUNT(*)
           FROM attestation a JOIN release r ON r.cid = a.subject_cid
          WHERE a.verifier_did = $1 AND r.issuer_did <> $1
          GROUP BY 1, 2
         UNION ALL
         SELECT 'earlier', prev.issuer_did, COUNT(*)
           FROM release r JOIN release prev ON prev.cid = r.prev_cid
          WHERE r.issuer_did = $1 AND prev.issuer_did <> $1
          GROUP BY 1, 2
         UNION ALL
         SELECT 'later', next.issuer_did, COUNT(*)
           FROM release r JOIN release next ON next.prev_cid = r.cid
          WHERE r.issuer_did = $1 AND next.issuer_did <> $1
          GROUP BY 1, 2
       )
       SELECT kind, did, n FROM (
         SELECT rel.*, ROW_NUMBER() OVER (
           PARTITION BY kind ORDER BY n DESC, did
         ) AS rn FROM rel
       ) ranked
       WHERE rn <= $2
       ORDER BY kind, n DESC, did`,
      [did, limit],
    )
    return rows.map((r: any) => ({
      kind: r.kind,
      did: r.did,
      count: Number(r.n),
    }))
  }

  async actorsFor(dids: string[]): Promise<Map<string, ActorRow>> {
    const out = new Map<string, ActorRow>()
    if (dids.length === 0) return out
    const { rows } = await this.pool.query(
      `${ACTOR_COLUMNS} WHERE did = ANY($1)`,
      [dids],
    )
    for (const r of rows) out.set(r.did, toActor(r))
    return out
  }

  /**
   * One account by handle or by DID, whichever the caller has.
   *
   * Both in a single statement rather than a lookup and a fallback, because
   * the two are not distinguishable without parsing: the handle column holds
   * the DID for any organization whose handle this observer never resolved, so
   * a DID really can be the correct answer to a handle query.
   */
  async accountFor(handleOrDid: string): Promise<ActorRow | null> {
    const { rows } = await this.pool.query(
      `${ACTOR_COLUMNS} WHERE did = $1 OR handle = $1 LIMIT 1`,
      [handleOrDid],
    )
    return rows[0] ? toActor(rows[0]) : null
  }

  async releasesByIssuer(did: string, limit: number): Promise<ReleaseRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM release WHERE issuer_did = $1
       ORDER BY observed_at DESC LIMIT $2`,
      [did, limit],
    )
    return rows.map(toRelease)
  }

  async attestationsByVerifier(
    did: string,
    limit: number,
  ): Promise<AttestationRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM attestation WHERE verifier_did = $1
       ORDER BY observed_at DESC LIMIT $2`,
      [did, limit],
    )
    return rows.map(toAttestation)
  }

  /**
   * Three counts for one account, in one round trip.
   *
   * Scalar subqueries rather than joins: the three count different things over
   * different tables, and a join would either multiply rows or need a
   * DISTINCT on each aggregate to undo the multiplication.
   */
  async accountStats(did: string): Promise<AccountStats> {
    const { rows } = await this.pool.query(
      `SELECT
         (SELECT COUNT(*) FROM release WHERE issuer_did = $1) AS releases,
         (SELECT COUNT(DISTINCT r.cid)
            FROM release r JOIN attestation a ON a.subject_cid = r.cid
           WHERE r.issuer_did = $1) AS attested,
         (SELECT COUNT(*) FROM attestation WHERE verifier_did = $1) AS checks`,
      [did],
    )
    const r = rows[0] ?? {}
    return {
      releases: Number(r.releases ?? 0),
      attested: Number(r.attested ?? 0),
      checks: Number(r.checks ?? 0),
    }
  }

  async handleFor(did: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT handle FROM actor WHERE did = $1`,
      [did],
    )
    return rows[0]?.handle ?? null
  }
}
