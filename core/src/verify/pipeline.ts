/**
 * The verification pipeline (§4.4). This is the product.
 *
 * Stateless: given a bundle and a way to reach the network, it decides whether
 * a release certificate is what it claims to be, and says so one stage at a
 * time. No database is consulted, and none is needed — the chain is walked by
 * following strong references from one issuer's repository to the next.
 */

import { verifyRecords } from '@atproto/repo'
import { cidForLex } from '@atproto/lex-cbor'
import {
  bundleMatchesCommitment,
  commitmentFromBundle,
  parseAtUri,
  SYNTHETIC_MARKER,
  type Bundle,
} from '../bundle.js'
import { normalizeIdentifier } from '../canonical.js'
import { toHex } from '../commitment.js'
import { PUBLIC_FIELDS } from '../fields.js'
import type { IdentityResolver, RepoClient } from './ports.js'
import {
  stageTitles,
  type ChainLink,
  type Stage,
  type StageName,
  type StageStatus,
  type VerificationReport,
} from './types.js'

const RELEASE_NSID = 'dev.cldixon.f8130.release'

/** Guard against a maliciously long or circular chain. */
const MAX_CHAIN_DEPTH = 100

export type VerifyOptions = {
  bundle: Bundle
  /** Serial number read off the physical part, if the operator has it in hand. */
  stampedSerial?: string
  resolver: IdentityResolver
  repo: RepoClient
  /**
   * The instant to judge key validity against.
   *
   * Defaults to now. An AppView that has independently observed the record
   * should pass its own observation time instead: the record's own
   * `completedAt` is written by whoever made the record and is precisely what
   * a backdating fraudster controls.
   */
  keyValidityAnchor?: Date
}

class Report {
  readonly stages: Stage[] = []

  add(
    name: StageName,
    status: StageStatus,
    detail: string,
    data?: Record<string, unknown>,
  ): Stage {
    const stage: Stage = { name, title: stageTitles[name], status, detail, data }
    this.stages.push(stage)
    return stage
  }

  skipRest(from: StageName[], detail: string) {
    for (const name of from) this.add(name, 'skipped', detail)
  }

  get failed(): boolean {
    return this.stages.some((s) => s.status === 'fail')
  }
}

/** A release record as it appears once decoded from the repository. */
type ReleaseRecord = {
  commitment?: unknown
  issuerDid?: unknown
  prev?: { uri?: unknown; cid?: unknown }
  formNumber?: unknown
  partNumber?: unknown
  serialNumber?: unknown
  status?: unknown
  signerCert?: unknown
  completedAt?: unknown
}

/**
 * The CID of a record as the repository stores it.
 *
 * verifyRecords returns the decoded record but not its CID, so it is
 * recomputed here. That is not a workaround — re-deriving the CID from the
 * bytes is what makes a strong reference meaningful, since it proves the
 * predecessor is byte-for-byte the document that was referenced rather than
 * whatever currently sits at that address.
 */
async function recordCid(record: unknown): Promise<string> {
  return (await cidForLex(record as any)).toString()
}

function asBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v
  return null
}

export async function verifyBundle(
  opts: VerifyOptions,
): Promise<VerificationReport> {
  const { bundle, resolver, repo } = opts
  const report = new Report()
  const chain: ChainLink[] = []
  let reachedBirth = false
  let issuer: VerificationReport['issuer']

  // ------------------------------------------------------------- 1. resolve
  let uriParts: ReturnType<typeof parseAtUri>
  try {
    uriParts = parseAtUri(bundle.uri)
  } catch (err) {
    report.add('resolve', 'fail', `The bundle's record URI is malformed.`, {
      uri: bundle.uri,
    })
    report.skipRest(
      ['fetch', 'signature', 'recompute', 'agree', 'physical', 'chain'],
      'The record could not be located.',
    )
    return finish(report, chain, reachedBirth, issuer)
  }

  const resolvedDid = await resolver.resolveHandle(bundle.issuerHandle)
  if (!resolvedDid) {
    report.add(
      'resolve',
      'fail',
      `The handle ${bundle.issuerHandle} does not resolve to any identity. Nobody controlling that domain has claimed it.`,
      { handle: bundle.issuerHandle },
    )
    report.skipRest(
      ['fetch', 'signature', 'recompute', 'agree', 'physical', 'chain'],
      'The issuer could not be identified.',
    )
    return finish(report, chain, reachedBirth, issuer)
  }

  if (resolvedDid !== uriParts.did) {
    report.add(
      'resolve',
      'fail',
      `The handle ${bundle.issuerHandle} resolves to ${resolvedDid}, but the bundle claims a record belonging to ${uriParts.did}. The document names an issuer it does not actually come from.`,
      { handle: bundle.issuerHandle, resolvedDid, claimedDid: uriParts.did },
    )
    report.skipRest(
      ['fetch', 'signature', 'recompute', 'agree', 'physical', 'chain'],
      'The issuer identity is inconsistent.',
    )
    return finish(report, chain, reachedBirth, issuer)
  }

  const identity = await resolver.resolveDid(resolvedDid)
  if (!identity) {
    report.add(
      'resolve',
      'fail',
      `${resolvedDid} has no published identity document, so there is no key to check a signature against.`,
      { did: resolvedDid },
    )
    report.skipRest(
      ['fetch', 'signature', 'recompute', 'agree', 'physical', 'chain'],
      'The issuer has no resolvable identity document.',
    )
    return finish(report, chain, reachedBirth, issuer)
  }

  issuer = { handle: bundle.issuerHandle, did: identity.did, pds: identity.pds }
  report.add(
    'resolve',
    'pass',
    `${bundle.issuerHandle} is ${identity.did}, verified through the domain's own DNS.`,
    { handle: bundle.issuerHandle, did: identity.did, pds: identity.pds },
  )

  // ------------------------------------------ 2 & 3. fetch and signature
  //
  // One call backs both stages. verifyRecords checks the commit signature and
  // the MST inclusion path together, because in atproto a record is not
  // individually signed — it is covered by a signed commit. Splitting the
  // reporting keeps the UI honest about which property actually failed.
  const anchor = opts.keyValidityAnchor ?? new Date()
  const candidateKeys = await resolver.signingKeysAt(identity.did, anchor)
  const keys = candidateKeys ?? [identity.signingKey]
  const keyHistoryKnown = candidateKeys !== null

  let proof: Uint8Array
  try {
    proof = await repo.getRecordProof({
      pds: identity.pds,
      did: identity.did,
      collection: uriParts.collection,
      rkey: uriParts.rkey,
    })
  } catch (err) {
    report.add(
      'fetch',
      'fail',
      `The issuer's server could not be reached, so the record could not be checked.`,
      { error: err instanceof Error ? err.message : String(err) },
    )
    report.skipRest(
      ['signature', 'recompute', 'agree', 'physical', 'chain'],
      'The record was never retrieved.',
    )
    return finish(report, chain, reachedBirth, issuer)
  }

  const verified = await verifyWithAnyKey(proof, identity.did, keys)
  if (!verified.ok) {
    report.add(
      'fetch',
      'fail',
      `The issuer's server returned data that does not verify against its own signing key.`,
      { error: verified.error },
    )
    report.add(
      'signature',
      'fail',
      keyHistoryKnown
        ? `No key the issuer published at ${anchor.toISOString()} signs this data.`
        : `The issuer's current key does not sign this data.`,
      { error: verified.error },
    )
    report.skipRest(
      ['recompute', 'agree', 'physical', 'chain'],
      'Nothing about this record can be trusted.',
    )
    return finish(report, chain, reachedBirth, issuer)
  }

  const claim = verified.records.find(
    (r: any) => r.collection === uriParts.collection && r.rkey === uriParts.rkey,
  )

  if (!claim || claim.record === null || claim.record === undefined) {
    // The signature verified, which means this proof of *absence* is itself
    // signed by the issuer. This is the forgery case, and it is a much
    // stronger result than a missing HTTP response: the issuer's own
    // repository cryptographically attests that it never published this.
    report.add(
      'fetch',
      'fail',
      `${bundle.issuerHandle} has never published this record. Their own repository proves its absence — this document was not issued by them.`,
      { uri: bundle.uri, proofOfAbsence: true },
    )
    report.add(
      'signature',
      'pass',
      `The proof of absence is itself signed by ${bundle.issuerHandle}, so the answer comes from the issuer rather than from their server.`,
    )
    report.skipRest(
      ['recompute', 'agree', 'physical', 'chain'],
      'There is no record to check the document against.',
    )
    return finish(report, chain, reachedBirth, issuer)
  }

  const record = claim.record as ReleaseRecord
  report.add(
    'fetch',
    'pass',
    `The record exists in ${bundle.issuerHandle}'s own repository.`,
    { uri: bundle.uri },
  )

  report.add(
    'signature',
    keyHistoryKnown ? 'pass' : 'warn',
    keyHistoryKnown
      ? `Signed by a key ${bundle.issuerHandle} published at ${anchor.toISOString()}.`
      : `Signed by ${bundle.issuerHandle}'s current key. Key history was unavailable, so a signature made before a past key rotation cannot be distinguished from one made after.`,
    { keyHistoryKnown, anchor: anchor.toISOString(), keysConsidered: keys.length },
  )

  // ----------------------------------------------------------- 4. recompute
  const commitment = asBytes(record.commitment)
  if (!commitment) {
    report.add(
      'recompute',
      'fail',
      'The record carries no commitment, so there is nothing for the document to open.',
    )
  } else if (bundleMatchesCommitment(bundle, commitment)) {
    report.add(
      'recompute',
      'pass',
      'Every field of this document is covered by the commitment the issuer published.',
      { commitment: toHex(commitment) },
    )
  } else {
    // The instructive failure. The signature above still passed.
    report.add(
      'recompute',
      'fail',
      `The issuer really did sign a record for this part — but not this document. At least one field has been altered since it was issued.`,
      {
        published: toHex(commitment),
        recomputed: toHex(commitmentFromBundle(bundle).root),
      },
    )
  }

  // --------------------------------------------------------------- 5. agree
  const disagreements: string[] = []
  for (const field of PUBLIC_FIELDS) {
    const onRecord = (record as Record<string, unknown>)[field]
    const inBundle = bundle.values[field]
    if (onRecord !== inBundle) {
      disagreements.push(field)
    }
  }
  if (disagreements.length === 0) {
    report.add(
      'agree',
      'pass',
      'The publicly listed fields match the document exactly.',
      { fields: PUBLIC_FIELDS },
    )
  } else {
    report.add(
      'agree',
      'fail',
      `The record's public fields disagree with the document: ${disagreements.join(', ')}. The issuer published one thing and delivered another.`,
      {
        fields: disagreements,
        record: Object.fromEntries(
          disagreements.map((f) => [f, (record as Record<string, unknown>)[f]]),
        ),
        bundle: Object.fromEntries(
          disagreements.map((f) => [f, bundle.values[f]]),
        ),
      },
    )
  }

  // ------------------------------------------------------------ 6. physical
  if (opts.stampedSerial === undefined) {
    report.add(
      'physical',
      'skipped',
      'No serial number was read off the part, so the document was not tied to physical hardware.',
    )
  } else {
    const stamped = normalizeIdentifier(opts.stampedSerial)
    const onRecord = String(record.serialNumber ?? '')
    if (stamped === onRecord) {
      report.add(
        'physical',
        'pass',
        `The serial stamped on the part matches the record.`,
        { stamped, record: onRecord },
      )
    } else {
      report.add(
        'physical',
        'fail',
        `The part in hand is serial ${stamped}, but this document is for ${onRecord}. The paperwork belongs to a different part.`,
        { stamped, record: onRecord },
      )
    }
  }

  // --------------------------------------------------------------- 7. chain
  const chainResult = await walkChain({
    record,
    uri: bundle.uri,
    cid: await recordCid(record),
    resolver,
    repo,
    anchor,
  })
  chain.push(...chainResult.links)
  reachedBirth = chainResult.reachedBirth

  if (chainResult.reachedBirth) {
    report.add(
      'chain',
      'pass',
      `Traceable through ${chain.length} shop visit${chain.length === 1 ? '' : 's'} back to the part's original manufacture.`,
      { links: chain.length },
    )
  } else {
    report.add(
      'chain',
      'fail',
      chainResult.reason ??
        'The history stops before reaching the part’s original manufacture.',
      { links: chain.length, missing: chainResult.missing },
    )
  }

  return finish(report, chain, reachedBirth, issuer)
}

function finish(
  report: Report,
  chain: ChainLink[],
  reachedBirth: boolean,
  issuer: VerificationReport['issuer'],
): VerificationReport {
  return {
    synthetic: SYNTHETIC_MARKER,
    verified: !report.failed,
    stages: report.stages,
    issuer,
    chain,
    reachedBirth,
  }
}

/**
 * Tries each candidate signing key in turn.
 *
 * More than one key can be legitimately valid at a single instant — during a
 * rotation the old and new keys overlap — so a single-key check would reject
 * perfectly good history.
 */
async function verifyWithAnyKey(
  proof: Uint8Array,
  did: string,
  keys: string[],
): Promise<
  { ok: true; records: any[] } | { ok: false; error: string }
> {
  let lastError = 'no signing key was available'
  for (const key of keys) {
    try {
      const records = await verifyRecords(proof, did, key)
      return { ok: true, records }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  return { ok: false, error: lastError }
}

/**
 * Walks `prev` strong references back toward birth.
 *
 * Each hop re-resolves the issuer and re-verifies from that issuer's own
 * server, so a chain crossing four organizations on four different hosts is
 * checked exactly as rigorously as one that never leaves home. A gap is
 * reported rather than treated as an error: a missing predecessor is a fact
 * about the part's history, and it is the fact a buyer most needs.
 */
async function walkChain(params: {
  record: ReleaseRecord
  uri: string
  cid: string
  resolver: IdentityResolver
  repo: RepoClient
  anchor: Date
}): Promise<{
  links: ChainLink[]
  reachedBirth: boolean
  reason?: string
  missing?: string
}> {
  const links: ChainLink[] = []
  let current: ReleaseRecord | null = params.record
  let currentUri = params.uri
  let currentCid = params.cid
  let depth = 0

  while (current) {
    links.push({
      uri: currentUri,
      cid: currentCid,
      issuerDid: String(current.issuerDid ?? ''),
      partNumber: String(current.partNumber ?? ''),
      serialNumber: String(current.serialNumber ?? ''),
      status: String(current.status ?? ''),
      completedAt: String(current.completedAt ?? ''),
      verified: true,
    })

    const prev = current.prev
    if (!prev || typeof prev.uri !== 'string') {
      return { links, reachedBirth: true }
    }

    if (++depth > MAX_CHAIN_DEPTH) {
      return {
        links,
        reachedBirth: false,
        reason: `The history is longer than ${MAX_CHAIN_DEPTH} shop visits, which is not plausible for a real part.`,
      }
    }

    const prevUri: string = prev.uri
    const prevCid = prev.cid?.toString?.() ?? ''

    let parts: ReturnType<typeof parseAtUri>
    try {
      parts = parseAtUri(prevUri)
    } catch {
      return {
        links,
        reachedBirth: false,
        reason: `The previous shop visit is referenced by a malformed link.`,
        missing: prevUri,
      }
    }

    if (parts.collection !== RELEASE_NSID) {
      return {
        links,
        reachedBirth: false,
        reason: `The previous shop visit points at something that is not a release certificate.`,
        missing: prevUri,
      }
    }

    const identity = await params.resolver.resolveDid(parts.did)
    if (!identity) {
      return {
        links,
        reachedBirth: false,
        reason: `The previous issuer ${parts.did} has no resolvable identity, so that shop visit cannot be checked.`,
        missing: prevUri,
      }
    }

    let proof: Uint8Array
    try {
      proof = await params.repo.getRecordProof({
        pds: identity.pds,
        did: parts.did,
        collection: parts.collection,
        rkey: parts.rkey,
      })
    } catch {
      return {
        links,
        reachedBirth: false,
        reason: `The previous shop visit could not be retrieved from its issuer's server.`,
        missing: prevUri,
      }
    }

    const keys =
      (await params.resolver.signingKeysAt(parts.did, params.anchor)) ?? [
        identity.signingKey,
      ]
    const verified = await verifyWithAnyKey(proof, parts.did, keys)
    if (!verified.ok) {
      return {
        links,
        reachedBirth: false,
        reason: `The previous shop visit does not verify against its issuer's key.`,
        missing: prevUri,
      }
    }

    const claim = verified.records.find(
      (r: any) => r.collection === parts.collection && r.rkey === parts.rkey,
    )
    if (!claim || !claim.record) {
      return {
        links,
        reachedBirth: false,
        reason: `The record for the previous shop visit was never published — the history has a hole in it exactly where the part's earlier life should be.`,
        missing: prevUri,
      }
    }

    // The strong reference pins content as well as location. A predecessor
    // that has been rewritten since it was referenced is not the document
    // this certificate was built on.
    const actualCid = await recordCid(claim.record)
    if (prevCid && actualCid && prevCid !== actualCid) {
      return {
        links,
        reachedBirth: false,
        reason: `The previous shop visit has been altered since this certificate referenced it.`,
        missing: prevUri,
      }
    }

    const next = claim.record as ReleaseRecord

    // A chain assembled from unrelated parts is not a chain. Without this the
    // "traceable to birth" claim can be satisfied by pointing at any record
    // that happens to exist.
    const prevLink = links[links.length - 1]!
    if (
      normalizeIdentifier(String(next.partNumber ?? '')) !==
        normalizeIdentifier(prevLink.partNumber) ||
      normalizeIdentifier(String(next.serialNumber ?? '')) !==
        normalizeIdentifier(prevLink.serialNumber)
    ) {
      return {
        links,
        reachedBirth: false,
        reason: `The previous shop visit is for a different part (${next.partNumber} / ${next.serialNumber}), so this history has been stitched together from unrelated records.`,
        missing: prevUri,
      }
    }

    current = next
    currentUri = prevUri
    currentCid = actualCid
  }

  return { links, reachedBirth: false, reason: 'The history is incomplete.' }
}
