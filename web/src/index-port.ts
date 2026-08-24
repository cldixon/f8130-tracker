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

/**
 * Somebody checked a document against a release, and it held.
 *
 * There is no failed counterpart, here or in the lexicon. A party who cannot
 * verify a document cannot prove that to anyone — a document that fails to
 * recompute demonstrates only that some document fails, and anybody can make
 * one. So the network carries successes, and the absence of them is the
 * closest thing to a negative signal it can honestly offer.
 */
export type AttestationRow = {
  cid: string
  uri: string
  subjectUri: string
  subjectCid: string
  /** The repository it was found in, which is the whole of its authorship claim. */
  verifierDid: string
  /** Derived from the subject URI, not restated on the record. */
  issuerDid: string
  verifiedAt: Date
  observedAt: Date
}

/**
 * One thing that happened, as this observer saw it happen.
 *
 * Ordered by `observedAt` rather than by anything an author claimed. A feed
 * sorted on a claimed timestamp would let a backdating issuer choose where in
 * the timeline their record appears, which is the one thing an independent
 * observer's own clock is for.
 */
export type FeedEvent =
  | { kind: 'release'; at: Date; release: ReleaseRow }
  | { kind: 'attestation'; at: Date; attestation: AttestationRow }

/**
 * Who a DID is, as this observer learned it from the network.
 *
 * `displayName` comes from a station record the organization published in its
 * own repository. It is self-asserted and committed to by nothing, which is
 * the right strength for a name — but it is still a signed statement from the
 * party it describes rather than a table this service shipped, which is the
 * distinction the station lexicon exists to make.
 *
 * Null when the organization has never published a profile. An attestation
 * from an operator this observer has never seen publish one is exactly that
 * case, and the honest rendering is the DID.
 */
export type ActorRow = {
  did: string
  displayName: string | null
  kind: string | null
}

export type IssuerStat = {
  did: string
  releases: number
  /**
   * How many of this station's releases somebody independently checked.
   *
   * Not a score. A thin count can mean nobody bothered as easily as it can
   * mean something is wrong, which is why it is shown as a count against the
   * total rather than as a verdict.
   */
  attested: number
}

export interface ReadIndex {
  /**
   * Releases and attestations interleaved, newest first.
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
  attestationsForSubjects(cids: string[]): Promise<AttestationRow[]>
  /** One release by its at:// URI, which is what a permalink can rebuild. */
  releaseByUri(uri: string): Promise<ReleaseRow | null>
  /**
   * The releases a set of attestations are about, keyed by URI.
   *
   * An attestation card shows the release it covers rather than restating it, so
   * the feed needs the subject of everything on screen in one go. Missing
   * URIs are simply absent: an observer can see an attestation on a release it
   * never saw, and that is a fact about the feed rather than an error.
   */
  releasesByUris(uris: string[]): Promise<Map<string, ReleaseRow>>
  issuerStats(): Promise<IssuerStat[]>
  handleFor(did: string): Promise<string | null>
  /** Profiles for the DIDs on screen. Missing DIDs are simply absent. */
  actorsFor(dids: string[]): Promise<Map<string, ActorRow>>
}
