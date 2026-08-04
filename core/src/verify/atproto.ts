/**
 * The live implementations of the verifier's two ports.
 *
 * Everything here talks to the real network: DNS for handles, the PLC
 * directory for identity documents and key history, and an issuer's own PDS
 * over XRPC for signed record proofs. Nothing in this file has privileged
 * access to anything — it is exactly the view a stranger on the internet has,
 * which is the point.
 */

import { DidResolver, HandleResolver } from '@atproto/identity'
import { getPdsEndpoint, getSigningDidKey } from '@atproto/common'

import {
  RepoFetchError,
  type IdentityResolver,
  type RecordLocation,
  type RepoClient,
  type ResolvedIdentity,
  type SigningKey,
} from './ports.js'

export type AtprotoResolverOptions = {
  /** PLC directory base URL. */
  plcUrl?: string
  /** Timeout for identity lookups, in milliseconds. */
  timeout?: number
  fetch?: typeof globalThis.fetch
}

/** One entry of a did:plc audit log. */
type PlcAuditEntry = {
  createdAt?: string
  nullified?: boolean
  operation?: {
    verificationMethods?: Record<string, string>
    // Legacy create operations name the key directly.
    signingKey?: string
  }
}

export class AtprotoIdentityResolver implements IdentityResolver {
  private readonly handles: HandleResolver
  private readonly dids: DidResolver
  private readonly plcUrl: string
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: AtprotoResolverOptions = {}) {
    this.plcUrl = opts.plcUrl ?? 'https://plc.directory'
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.handles = new HandleResolver({ timeout: opts.timeout })
    this.dids = new DidResolver({ timeout: opts.timeout, plcUrl: this.plcUrl })
  }

  async resolveHandle(handle: string): Promise<string | null> {
    try {
      return (await this.handles.resolve(handle)) ?? null
    } catch {
      return null
    }
  }

  async resolveDid(did: string): Promise<ResolvedIdentity | null> {
    let doc
    try {
      doc = await this.dids.resolve(did)
    } catch {
      return null
    }
    if (!doc) return null

    const pds = getPdsEndpoint(doc)
    const signingKey = getSigningDidKey(doc)
    if (!pds || !signingKey) return null

    return { did, pds, signingKey }
  }

  /**
   * Reconstructs an issuer's signing key at an instant from the PLC audit log.
   *
   * Only did:plc publishes an operation history; did:web documents say what
   * they say today and nothing about what they said last year. Returning null
   * for those is deliberate — the pipeline downgrades to a warning, which is
   * honest, where inventing an answer would not be.
   *
   * Note that a PDS re-signs its repository head when a key rotates, so a
   * *live* proof normally verifies against the current key regardless. This
   * matters for archived commits, where the signature is frozen at the moment
   * it was made.
   */
  async signingKeysAt(did: string, at: Date): Promise<SigningKey[] | null> {
    if (!did.startsWith('did:plc:')) return null

    let entries: PlcAuditEntry[]
    try {
      const res = await this.fetchImpl(
        `${this.plcUrl}/${encodeURIComponent(did)}/log/audit`,
      )
      if (!res.ok) return null
      entries = (await res.json()) as PlcAuditEntry[]
    } catch {
      return null
    }
    if (!Array.isArray(entries) || entries.length === 0) return null

    const live = entries
      .filter((e) => !e.nullified && typeof e.createdAt === 'string')
      .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!))

    const keyOf = (e: PlcAuditEntry): string | undefined =>
      e.operation?.verificationMethods?.atproto ?? e.operation?.signingKey

    const applicable = live.filter((e) => Date.parse(e.createdAt!) <= at.getTime())
    // Before the first operation there was no identity at all; fall back to the
    // genesis key so callers get a definite answer rather than an empty set.
    const chosen = applicable.length > 0 ? applicable[applicable.length - 1]! : live[0]!

    const key = keyOf(chosen)
    return key ? [key] : null
  }
}

export type XrpcRepoClientOptions = {
  timeout?: number
  fetch?: typeof globalThis.fetch
}

export class XrpcRepoClient implements RepoClient {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeout: number

  constructor(opts: XrpcRepoClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.timeout = opts.timeout ?? 10_000
  }

  async getRecordProof(location: RecordLocation): Promise<Uint8Array> {
    const url = new URL('/xrpc/com.atproto.sync.getRecord', location.pds)
    url.searchParams.set('did', location.did)
    url.searchParams.set('collection', location.collection)
    url.searchParams.set('rkey', location.rkey)

    let res: Response
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: 'application/vnd.ipld.car' },
        signal: AbortSignal.timeout(this.timeout),
      })
    } catch (err) {
      throw new RepoFetchError(
        `could not reach ${location.pds}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    // A 404 here is not proof of anything. Only a signed exclusion proof is,
    // and that arrives as a 200 with a CAR that omits the record. Treating an
    // error status as "the record does not exist" would let any server deny a
    // certificate by simply refusing to answer.
    if (!res.ok) {
      throw new RepoFetchError(
        `${location.pds} returned ${res.status} ${res.statusText}`,
      )
    }

    return new Uint8Array(await res.arrayBuffer())
  }
}
