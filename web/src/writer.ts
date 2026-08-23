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
  orgs,
  publicValues,
  type Bundle,
  type OrgKind,
  type RawForm,
} from '@f8130/core'

import { releaseRow } from './memory-index.js'

export const RELEASE_NSID = 'dev.cldixon.f8130.release'
export const ACCEPTANCE_NSID = 'dev.cldixon.f8130.acceptance'
export const DISPUTE_NSID = 'dev.cldixon.f8130.dispute'

export type StrongRef = { uri: string; cid: string }

export type Actor = {
  handle: string
  displayName: string
  kind: OrgKind
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
      ...publicValues(commitment.values),
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

/**
 * The seeded cast, for the persona picker.
 *
 * Derived from the shared roster rather than restated here. The previous
 * hand-copied list was correct exactly as long as the roster never changed.
 */
export function demoActors(domain: string): Actor[] {
  return orgs(domain).map((org) => ({
    handle: org.handle,
    displayName: org.displayName,
    kind: org.kind,
  }))
}

/**
 * Writes into the in-memory network, and tells an in-memory index about it.
 *
 * Demo mode has real signing keys and real inclusion proofs but no firehose and
 * no Postgres, so the observation step that a live deployment gets for free has
 * to be short-circuited: this appends the indexed row itself. The signatures a
 * visitor checks are genuine; the independence of the observer is not. That is
 * the same simplification demo mode already makes about hosting, and it is why
 * a demo instance says so on every page.
 */
export class MemoryRecordWriter implements RecordWriter {
  constructor(
    private readonly net: {
      issue(p: { handle: string; form: RawForm; prev?: StrongRef }): Promise<{
        uri: string
        cid: unknown
        bundle: Bundle
      }>
      accept(p: {
        handle: string
        subject: StrongRef
        issuerDid: string
        partNumber: string
        serialNumber: string
        outcome: 'accepted' | 'rejected' | 'discrepancy'
        note?: string
      }): Promise<{ uri: string; cid: unknown }>
      dispute(p: {
        handle: string
        subject: StrongRef
        response: string
      }): Promise<{ uri: string; cid: unknown }>
      resolveHandle(handle: string): Promise<string | null>
    },
    private readonly index: {
      addRelease(row: any): void
      addVerdict(row: any): void
      addDispute(row: any): void
      setHandle(did: string, handle: string): void
      setActor(row: { did: string; displayName: string | null; kind: string | null }): void
    },
    private readonly cast: Actor[],
  ) {}

  actors(): Actor[] {
    return this.cast
  }

  /**
   * Records who a DID is, standing in for the station record the live path
   * indexes off the firehose.
   *
   * The same short-circuit demo mode already makes about observation: the
   * signatures are real, the independence of the observer is not.
   */
  private profile(did: string, handle: string): void {
    const actor = this.cast.find((a) => a.handle === handle)
    if (!actor) return
    this.index.setActor({ did, displayName: actor.displayName, kind: actor.kind })
  }

  async createRelease(params: {
    handle: string
    form: RawForm
    prev?: StrongRef
  }): Promise<Written & { bundle: Bundle }> {
    const issued = await this.net.issue(params)
    const cid = String(issued.cid)
    this.index.setHandle(issued.uri.split('/')[2]!, params.handle)
    this.profile(issued.uri.split('/')[2]!, params.handle)
    this.index.addRelease(
      releaseRow({
        uri: issued.uri,
        cid,
        bundle: issued.bundle,
        prev: params.prev,
        observedAt: new Date(),
      }),
    )
    return { uri: issued.uri, cid, bundle: issued.bundle }
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
    const written = await this.net.accept(params)
    const did = written.uri.split('/')[2]!
    const now = new Date()
    this.index.setHandle(did, params.handle)
    this.profile(did, params.handle)
    this.index.addVerdict({
      cid: String(written.cid),
      uri: written.uri,
      subjectUri: params.subject.uri,
      subjectCid: params.subject.cid,
      issuerDid: params.issuerDid,
      verifierDid: did,
      partNumber: params.partNumber,
      serialNumber: params.serialNumber,
      outcome: params.outcome,
      note: params.note ?? null,
      receivedAt: now,
      observedAt: now,
    })
    return { uri: written.uri, cid: String(written.cid) }
  }

  async createDispute(params: {
    handle: string
    subject: StrongRef
    response: string
  }): Promise<Written> {
    const written = await this.net.dispute(params)
    const did = written.uri.split('/')[2]!
    const now = new Date()
    this.index.setHandle(did, params.handle)
    this.profile(did, params.handle)
    this.index.addDispute({
      cid: String(written.cid),
      uri: written.uri,
      subjectUri: params.subject.uri,
      subjectCid: params.subject.cid,
      authorDid: did,
      response: params.response,
      disputedAt: now,
      observedAt: now,
    })
    return { uri: written.uri, cid: String(written.cid) }
  }
}
