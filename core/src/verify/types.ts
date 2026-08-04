/**
 * The verification report (§4.4).
 *
 * Every stage reports independently and the pipeline never short-circuits on a
 * failure it can survive. That is deliberate: the most instructive result in
 * the whole demonstration is a bundle whose signature passes and whose
 * commitment fails, which says the station really did sign something — just
 * not this. Collapsing the report to a single boolean would destroy exactly
 * the distinction worth teaching.
 */

export type StageName =
  | 'resolve'
  | 'fetch'
  | 'signature'
  | 'recompute'
  | 'agree'
  | 'physical'
  | 'chain'

export type StageStatus =
  /** The check ran and held. */
  | 'pass'
  /** The check ran and did not hold. */
  | 'fail'
  /** The check could not run, usually because an earlier stage failed. */
  | 'skipped'
  /** The check held, but something about it is weaker than it looks. */
  | 'warn'

export type Stage = {
  name: StageName
  /** Human-readable label, for the UI. */
  title: string
  status: StageStatus
  /** One sentence a non-cryptographer can act on. */
  detail: string
  /** Structured supporting evidence, safe to render. */
  data?: Record<string, unknown>
}

/** One shop visit along the back-to-birth chain. */
export type ChainLink = {
  uri: string
  cid: string
  issuerDid: string
  issuerHandle?: string
  partNumber: string
  serialNumber: string
  status: string
  /** Claimed by the issuer. Attacker-controlled. */
  completedAt: string
  /** Whether this link's own signature and inclusion proof verified. */
  verified: boolean
  note?: string
}

export type VerificationReport = {
  synthetic: string
  /** True when no stage failed. Warnings do not clear this flag. */
  verified: boolean
  stages: Stage[]
  /** Resolved identity of the issuer, when it got that far. */
  issuer?: {
    handle: string
    did: string
    pds?: string
  }
  /** The chain as walked, newest first. Empty when the chain stage did not run. */
  chain: ChainLink[]
  /** True when the chain reached a record with no predecessor. */
  reachedBirth: boolean
}

export const stageTitles: Record<StageName, string> = {
  resolve: 'Issuer identity',
  fetch: 'Record exists in the issuer’s repo',
  signature: 'Signed by the issuer’s key',
  recompute: 'Document matches the commitment',
  agree: 'Public fields agree',
  physical: 'Matches the physical part',
  chain: 'Traceable to birth',
}
