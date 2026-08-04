/**
 * The pipeline's contact with the outside world, as two narrow interfaces.
 *
 * Everything the verifier learns about the network arrives through these, for
 * two reasons. The obvious one is testability: the whole pipeline, including
 * the forgery and key-rotation paths, runs against in-memory repositories with
 * no sockets involved. The less obvious one is that it forces the verifier to
 * be explicit about what it trusts — there is no ambient way to reach a
 * database, only a way to ask an issuer's own server for signed bytes.
 */

/** An atproto signing key in did:key form. */
export type SigningKey = string

export type ResolvedIdentity = {
  did: string
  /** The issuer's PDS service endpoint. */
  pds: string
  /** The signing key currently listed in the DID document. */
  signingKey: SigningKey
}

export interface IdentityResolver {
  /**
   * Resolves a handle to a DID via DNS TXT `_atproto.<handle>` or the HTTP
   * well-known fallback. This is the step that carries the security argument:
   * the handle is the organization's domain, and only the domain's controller
   * can point it at a DID.
   */
  resolveHandle(handle: string): Promise<string | null>

  /** Resolves a DID to its service endpoint and current signing key. */
  resolveDid(did: string): Promise<ResolvedIdentity | null>

  /**
   * Every signing key the DID document listed at the given instant.
   *
   * Checking only the *current* key silently invalidates all history the
   * moment an issuer rotates, which is a routine operational event and not a
   * fraud signal. Resolvers that cannot reconstruct history return null, and
   * the pipeline degrades to a warning rather than pretending to know.
   */
  signingKeysAt(did: string, at: Date): Promise<SigningKey[] | null>
}

export type RecordLocation = {
  pds: string
  did: string
  collection: string
  rkey: string
}

export interface RepoClient {
  /**
   * Fetches the proof CAR for a single record — `com.atproto.sync.getRecord`.
   *
   * Deliberately not `com.atproto.repo.getRecord`, which returns unsigned JSON
   * and would reduce the entire security argument to trusting the PDS's TLS
   * certificate. The CAR carries the signed commit and the MST path, so the
   * verifier checks the issuer's signature rather than the server's word. It
   * also proves *absence*, which is how a forged document is caught.
   */
  getRecordProof(location: RecordLocation): Promise<Uint8Array>
}

export class RepoFetchError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RepoFetchError'
  }
}
