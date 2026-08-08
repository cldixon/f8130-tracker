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

export type ReleaseRow = {
  cid: string
  uri: string
  issuerDid: string
  prevUri: string | null
  prevCid: string | null
  partNumber: string
  serialNumber: string
  status: string
  signerCert: string
  formNumber: string
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

export type IssuerStat = {
  did: string
  releases: number
  distinctRejectors: number
}

export interface ReadIndex {
  recentReleases(limit: number): Promise<ReleaseRow[]>
  /** Newest first. An empty result means this observer has never seen the part. */
  releasesForPart(partNumber: string, serialNumber: string): Promise<ReleaseRow[]>
  /** Walks prev_cid back toward birth, newest first. */
  chain(cid: string, maxDepth: number): Promise<ReleaseRow[]>
  acceptancesForSubjects(cids: string[]): Promise<AcceptanceRow[]>
  issuerStats(): Promise<IssuerStat[]>
  handleFor(did: string): Promise<string | null>
}
