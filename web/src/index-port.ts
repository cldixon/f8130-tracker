/**
 * The AppView's read model.
 *
 * Note what is NOT here: nothing the verification pipeline needs. Verifying a
 * certificate consults no database at all — it asks the issuer's own server for
 * signed bytes and follows strong references from there. This index exists for
 * *discovery* (what parts exist, which issuers are accumulating rejections),
 * which is a genuinely different job, and the application is arranged so that
 * losing the database degrades browsing without weakening verification.
 */

/**
 * A release as this observer indexed it.
 *
 * No status and no remarks: Blocks 11 and 12 are committed but not published,
 * so an index built from the firehose cannot say what was done to a part. A
 * browser learns who touched it and when; the rest requires a disclosure.
 */
export type ReleaseRow = {
  cid: string
  uri: string
  issuerDid: string
  prevUri: string | null
  prevCid: string | null
  approvingAuthority: string
  formNumber: string
  organizationName: string
  organizationAddress: string
  description: string
  partNumber: string
  serialNumber: string
  signerCert: string
  /** Claimed by the issuer, and forgeable by one. */
  completedAt: Date
  /** When this observer first saw it. Not forgeable by the issuer. */
  observedAt: Date
}

export type AcceptanceRow = {
  cid: string
  uri: string
  subjectUri: string
  subjectCid: string
  issuerDid: string
  verifierDid: string
  partNumber: string
  serialNumber: string
  outcome: 'accepted' | 'rejected' | 'discrepancy'
  note: string | null
  receivedAt: Date
  observedAt: Date
}

/**
 * One thing that happened, as this observer saw it happen.
 *
 * Ordered by `observedAt` rather than by anything the issuer claimed. A feed
 * sorted on `completedAt` would let a backdating issuer choose where in the
 * timeline their record appears, which is the one thing an independent
 * observer's own clock is for.
 */
export type FeedEvent =
  | { kind: 'release'; at: Date; release: ReleaseRow }
  | { kind: 'verdict'; at: Date; verdict: AcceptanceRow }

/**
 * An issuer answering a verdict published against them.
 *
 * They cannot delete or amend it — the verdict is a record in the verifier's
 * repository — so replying is the whole of what they can do. Indexing that
 * reply is what makes the limit visible rather than merely true.
 */
export type DisputeRow = {
  cid: string
  uri: string
  subjectUri: string
  subjectCid: string
  /** The repository it was found in, which is the only authorship claim here. */
  authorDid: string
  response: string
  disputedAt: Date
  observedAt: Date
}

export type IssuerStat = {
  did: string
  releases: number
  distinctRejectors: number
}

export interface ReadIndex {
  /**
   * Releases and verdicts interleaved, newest first.
   *
   * `since` returns only what arrived after that moment, which is how the live
   * stream stays incremental without the client re-reading the whole feed.
   */
  feed(params: { limit: number; since?: Date }): Promise<FeedEvent[]>
  recentReleases(limit: number): Promise<ReleaseRow[]>
  /** Newest first. An empty result means this observer has never seen the part. */
  releasesForPart(partNumber: string, serialNumber: string): Promise<ReleaseRow[]>
  /** Walks prev_cid back toward birth, newest first. */
  chain(cid: string, maxDepth: number): Promise<ReleaseRow[]>
  acceptancesForSubjects(cids: string[]): Promise<AcceptanceRow[]>
  /** Replies to verdicts, keyed by the acceptance CID each answers. */
  disputesForSubjects(cids: string[]): Promise<DisputeRow[]>
  /** One release by its at:// URI, which is what a permalink can rebuild. */
  releaseByUri(uri: string): Promise<ReleaseRow | null>
  issuerStats(): Promise<IssuerStat[]>
  handleFor(did: string): Promise<string | null>
}
