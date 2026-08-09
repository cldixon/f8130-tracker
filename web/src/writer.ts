/**
 * Writing records.
 *
 * The one invariant that matters here: this service never holds a signing key.
 * It builds a record, hands it to the issuer's own PDS over an authenticated
 * session, and the PDS signs. If the AppView signed anything itself it would
 * have rebuilt the trusted intermediary the whole design exists to remove.
 *
 * Authentication is app passwords rather than OAuth, the fallback the handoff
 * document allows. OAuth would look more like production but changes nothing
 * about who holds the keys, and half its failure modes are DPoP nonce
 * plumbing — a large cost for no movement on the property being demonstrated.
 */

import { AtpAgent } from '@atproto/api'
import {
  buildBundle,
  commitForm,
  type Bundle,
  type RawForm,
} from '@f8130/core'

export const RELEASE_NSID = 'dev.cldixon.f8130.release'
export const ACCEPTANCE_NSID = 'dev.cldixon.f8130.acceptance'
export const DISPUTE_NSID = 'dev.cldixon.f8130.dispute'

export type StrongRef = { uri: string; cid: string }

export type Actor = {
  handle: string
  displayName: string
  kind: 'oem' | 'mro' | 'operator' | 'broker'
}

export type Written = { uri: string; cid: string }

export interface RecordWriter {
  /** The personas a visitor may act as. */
  actors(): Actor[]
  createRelease(params: {
    handle: string
    form: RawForm
    prev?: StrongRef
  }): Promise<Written & { bundle: Bundle }>
  createAcceptance(params: {
    handle: string
    subject: StrongRef
    issuerDid: string
    partNumber: string
    serialNumber: string
    outcome: 'accepted' | 'rejected' | 'discrepancy'
    note?: string
  }): Promise<Written>
  createDispute(params: {
    handle: string
    subject: StrongRef
    response: string
  }): Promise<Written>
}

export class WriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WriteError'
  }
}

export type AtpWriterOptions = {
  service: string
  /** Shared password for the seeded demonstration accounts. */
  password: string
  actors: Actor[]
}

/**
 * Writes through a live PDS.
 *
 * A fresh login per write, deliberately. Holding sessions would mean a session
 * store, and the alternative — keeping them in process memory — is the classic
 * way an atproto deployment breaks the moment it runs more than one replica.
 * At demonstration volume the extra round trip costs nothing and removes a
 * whole category of bug.
 */
export class AtpRecordWriter implements RecordWriter {
  constructor(private readonly opts: AtpWriterOptions) {}

  actors(): Actor[] {
    return this.opts.actors
  }

  private async session(handle: string): Promise<AtpAgent> {
    const known = this.opts.actors.some((a) => a.handle === handle)
    if (!known) throw new WriteError(`${handle} is not a demonstration account`)

    const agent = new AtpAgent({ service: this.opts.service })
    try {
      await agent.login({ identifier: handle, password: this.opts.password })
    } catch (err) {
      throw new WriteError(
        `could not sign in as ${handle}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return agent
  }

  async createRelease(params: {
    handle: string
    form: RawForm
    prev?: StrongRef
  }): Promise<Written & { bundle: Bundle }> {
    const agent = await this.session(params.handle)
    const did = agent.session!.did

    // Canonicalize and commit before writing. If the form is malformed this
    // throws here, and nothing reaches the repository — a record with a
    // commitment nobody can reopen would be worse than no record.
    const commitment = commitForm(params.form)

    const record: Record<string, unknown> = {
      $type: RELEASE_NSID,
      commitment: commitment.root,
      fieldSetVersion: commitment.version,
      issuerDid: did,
      formNumber: commitment.values.formNumber,
      partNumber: commitment.values.partNumber,
      serialNumber: commitment.values.serialNumber,
      status: commitment.values.status,
      signerCert: commitment.values.signerCert,
      completedAt: commitment.values.completedAt,
    }
    if (params.prev) record.prev = params.prev

    const res = await agent.com.atproto.repo.createRecord({
      repo: did,
      collection: RELEASE_NSID,
      record,
    })

    return {
      uri: res.data.uri,
      cid: res.data.cid,
      bundle: buildBundle({
        uri: res.data.uri,
        issuerHandle: params.handle,
        commitment,
      }),
    }
  }

  async createAcceptance(params: {
    handle: string
    subject: StrongRef
    issuerDid: string
    partNumber: string
    serialNumber: string
    outcome: 'accepted' | 'rejected' | 'discrepancy'
    note?: string
  }): Promise<Written> {
    const agent = await this.session(params.handle)
    const did = agent.session!.did

    const res = await agent.com.atproto.repo.createRecord({
      repo: did,
      collection: ACCEPTANCE_NSID,
      record: {
        $type: ACCEPTANCE_NSID,
        subject: params.subject,
        issuerDid: params.issuerDid,
        verifierDid: did,
        partNumber: params.partNumber,
        serialNumber: params.serialNumber,
        outcome: params.outcome,
        ...(params.note ? { note: params.note } : {}),
        receivedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      },
    })
    return { uri: res.data.uri, cid: res.data.cid }
  }

  /**
   * The issuer's right of reply.
   *
   * It cannot delete or amend the verdict — that record lives in the
   * operator's repository, not theirs. All it can do is answer, publicly and
   * under its own signature, which is the most a fair system should offer.
   */
  async createDispute(params: {
    handle: string
    subject: StrongRef
    response: string
  }): Promise<Written> {
    const agent = await this.session(params.handle)
    const did = agent.session!.did

    const res = await agent.com.atproto.repo.createRecord({
      repo: did,
      collection: DISPUTE_NSID,
      record: {
        $type: DISPUTE_NSID,
        subject: params.subject,
        response: params.response,
        disputedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      },
    })
    return { uri: res.data.uri, cid: res.data.cid }
  }
}

/** The seeded cast, for the persona picker. */
export function demoActors(domain: string): Actor[] {
  return [
    { handle: `northwind-turbine.${domain}`, displayName: 'Northwind Turbine', kind: 'oem' },
    { handle: `cascadia-mro.${domain}`, displayName: 'Cascadia MRO', kind: 'mro' },
    { handle: `example-air.${domain}`, displayName: 'Example Air', kind: 'operator' },
    { handle: `southpoint-air.${domain}`, displayName: 'Southpoint Air', kind: 'operator' },
    { handle: `meridian-aeroparts.${domain}`, displayName: 'Meridian Aeroparts', kind: 'broker' },
  ]
}
