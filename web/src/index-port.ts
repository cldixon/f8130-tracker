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
  /**
   * The domain the organization proved control of.
   *
   * Falls back to the DID when this observer never resolved one, which is why
   * every reader of this field guards against the two being equal rather than
   * treating a handle as necessarily friendlier than an identifier.
   */
  handle: string
  displayName: string | null
  kind: string | null
  /** Fictional commercial identifier, self-asserted on the station record. */
  cage: string | null
  /** Fictional repair-station certificate number, where the kind implies one. */
  certificate: string | null
  /**
   * When this observer first saw the DID publish anything at all.
   *
   * Not a joining date and not a claim by the organization: it is a fact about
   * this index, and it moves if the index is rebuilt. Labelled as such
   * wherever it is shown.
   */
  firstSeen: Date | null
}

/**
 * What one account has published, counted.
 *
 * Separate from the lists it accompanies because the lists are paged and the
 * counts are not: a profile that says "showing 40" over a shop with 300
 * releases is worse than useless. All three are counts over this observer's
 * index and none is a claim anybody made.
 */
export type AccountStats = {
  /** Certificates issued from this repository. */
  releases: number
  /**
   * How many of those somebody else has published a check on.
   *
   * Counted as releases with at least one attestation, not as attestations:
   * two operators checking the same certificate is one release covered, and
   * counting the records would let the number exceed the total it is shown
   * against.
   */
  attested: number
  /** Checks this account published on other organizations' releases. */
  checks: number
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

/**
 * How two organizations came to be on the same page as each other.
 *
 * Four relationships, and they are not the same kind of fact.
 *
 * The two attestation directions are as solid as anything here: an
 * attestation is a signed record in the checker's own repository carrying a
 * strong reference to a release in the issuer's, so both ends of the link are
 * authored by the party they are attributed to.
 *
 * The two chain directions are weaker on purpose. A release names its
 * predecessor, so a chain says who certified a part before and after whom —
 * which is the closest this network comes to a supply chain, and is genuinely
 * what a buyer wants. But `prev` is a claim by the issuer that wrote it, and
 * the part may have changed hands more than once between two certificates. So
 * they are labelled as what the records say rather than as trade.
 */
export type RelationKind =
  /** Published attestations on this account's releases. */
  | 'vouchedFor'
  /** This account published attestations on theirs. */
  | 'vouchedBy'
  /** Certified a part before this account did. */
  | 'earlier'
  /** Certified a part after this account did. */
  | 'later'

export type Relation = {
  kind: RelationKind
  did: string
  /** How many records support the link. Never a strength, only a count. */
  count: number
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

  /**
   * One account, addressed by either name it has.
   *
   * A handle and a DID are both accepted because both are in circulation: the
   * links in this application are built from handles, which read as domains
   * and are what anybody would type, while a record only ever carries a DID.
   * Resolving them in one place means a profile URL survives an organization
   * that has published nothing but a DID.
   *
   * Null when this observer has never seen the account at all, which is a
   * different answer from an account that has published no profile — that one
   * returns a row with a null display name.
   */
  accountFor(handleOrDid: string): Promise<ActorRow | null>
  /** What this account issued, newest observation first. */
  releasesByIssuer(did: string, limit: number): Promise<ReleaseRow[]>
  /** What this account vouched for, newest observation first. */
  attestationsByVerifier(did: string, limit: number): Promise<AttestationRow[]>
  accountStats(did: string): Promise<AccountStats>
  /**
   * The organizations this account is on the record with.
   *
   * `limit` applies per relationship rather than overall, so a shop with two
   * hundred checkers cannot push every supply-chain link off the page.
   * Self-links are excluded: a station that certified a part twice is a fact
   * about the part, not a relationship with itself.
   */
  relatedAccounts(did: string, limit: number): Promise<Relation[]>
}
