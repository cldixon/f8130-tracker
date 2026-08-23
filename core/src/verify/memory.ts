/**
 * An in-memory atproto network.
 *
 * Real repositories, real signing keys, real signed commits, real MST
 * inclusion and exclusion proofs — the same @atproto/repo code a live PDS runs
 * — with the sockets removed.
 *
 * This lives in src rather than in the tests because it has two jobs. It backs
 * the adversarial test cases, where being able to forge, tamper, stitch a
 * chain and rotate a key on demand beats pointing at one live server and
 * hoping it misbehaves. And it lets the whole application run with no
 * infrastructure at all, which is how the demo is developed and how anyone
 * cloning the repository can see it work before standing anything up.
 */

import { createHash } from 'node:crypto'

import { Secp256k1Keypair } from '@atproto/crypto'
import { TID } from '@atproto/common'
import { cidForLex } from '@atproto/lex-cbor'
import {
  getRecords,
  MemoryBlockstore,
  Repo,
  WriteOpAction,
} from '@atproto/repo'

import { buildBundle } from '../bundle.js'
import { commitForm } from '../commitment.js'
import { PUBLIC_FIELDS, type RawForm } from '../fields.js'
import { orgs } from '../roster.js'
import type {
  IdentityResolver,
  RecordLocation,
  RepoClient,
  ResolvedIdentity,
  SigningKey,
} from './ports.js'
import { RepoFetchError } from './ports.js'
import type { Bundle } from '../bundle.js'

export const ACCEPTANCE_NSID = 'dev.cldixon.f8130.acceptance'
export const RELEASE_NSID = 'dev.cldixon.f8130.release'

type KeyEpoch = { key: SigningKey; from: Date }

type Org = {
  handle: string
  did: string
  pds: string
  storage: MemoryBlockstore
  repo: Repo
  keypair: Secp256k1Keypair
  keyHistory: KeyEpoch[]
}

export type Issued = {
  uri: string
  cid: any
  bundle: Bundle
  root: Uint8Array
}

export class MemoryNetwork implements IdentityResolver, RepoClient {
  private byDid = new Map<string, Org>()
  private byHandle = new Map<string, string>()

  /** Handles that resolve to nothing, for the unclaimed-domain case. */
  private unresolvable = new Set<string>()

  /** DIDs whose key history cannot be reconstructed, for the warn path. */
  private opaqueHistory = new Set<string>()

  /** PDS endpoints that refuse connections, for the unreachable case. */
  offline = new Set<string>()

  async createOrg(params: {
    handle: string
    did: string
    pds?: string
  }): Promise<Org> {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const storage = new MemoryBlockstore()
    const repo = await Repo.create(storage, params.did, keypair)
    const org: Org = {
      handle: params.handle,
      did: params.did,
      pds: params.pds ?? `https://pds.f8130.cldixon.dev`,
      storage,
      repo,
      keypair,
      keyHistory: [{ key: keypair.did(), from: new Date('2000-01-01T00:00:00Z') }],
    }
    this.byDid.set(params.did, org)
    this.byHandle.set(params.handle, params.did)
    return org
  }

  org(handle: string): Org {
    const did = this.byHandle.get(handle)
    const org = did ? this.byDid.get(did) : undefined
    if (!org) throw new Error(`no such org: ${handle}`)
    return org
  }

  /** Points a handle at a DID it does not actually own. */
  repointHandle(handle: string, did: string) {
    this.byHandle.set(handle, did)
  }

  makeUnresolvable(handle: string) {
    this.unresolvable.add(handle)
  }

  hideKeyHistory(did: string) {
    this.opaqueHistory.add(did)
  }

  /** DIDs whose published key does not match the key their data is signed by. */
  private wrongKey = new Map<string, SigningKey>()

  /**
   * Publishes a signing key the organization does not actually sign with.
   *
   * Models a compromised or malicious server serving fabricated records: the
   * bytes are well-formed and the MST is intact, but nothing traces back to
   * the key the issuer's identity document actually names.
   */
  async publishWrongKey(did: string): Promise<void> {
    const impostor = await Secp256k1Keypair.create()
    this.wrongKey.set(did, impostor.did())
  }

  /**
   * Rotates an organization's signing key, the way a PDS actually does it.
   *
   * The repository head is re-signed with the new key, so a live fetch keeps
   * verifying against whatever the identity document currently publishes.
   * Modelling this faithfully matters: without the re-signing step a rotation
   * would appear to invalidate all of an issuer's history, and a test built on
   * that misunderstanding would pass for the wrong reason.
   */
  async rotateKey(handle: string, at: Date): Promise<void> {
    const org = this.org(handle)
    const next = await Secp256k1Keypair.create({ exportable: true })
    org.repo = await org.repo.resignCommit(TID.nextStr(), next)
    org.keypair = next
    org.keyHistory.push({ key: next.did(), from: at })
  }

  /** Issues a release certificate into an organization's own repository. */
  async issue(params: {
    handle: string
    form: RawForm
    prev?: { uri: string; cid: any }
  }): Promise<Issued> {
    const org = this.org(params.handle)
    const commitment = commitForm(params.form)

    const record: Record<string, unknown> = {
      $type: RELEASE_NSID,
      commitment: commitment.root,
      fieldSetVersion: commitment.version,
      issuerDid: org.did,
    }
    for (const field of PUBLIC_FIELDS) {
      record[field] = commitment.values[field]
    }
    if (params.prev) {
      record.prev = { uri: params.prev.uri, cid: params.prev.cid }
    }

    const rkey = TID.nextStr()
    org.repo = await org.repo.applyWrites(
      [
        {
          action: WriteOpAction.Create,
          collection: RELEASE_NSID as any,
          rkey: rkey as any,
          record: record as any,
        },
      ],
      org.keypair,
    )

    const uri = `at://${org.did}/${RELEASE_NSID}/${rkey}`
    return {
      uri,
      cid: await cidForLex(record as any),
      root: commitment.root,
      bundle: buildBundle({
        uri,
        issuerHandle: org.handle,
        commitment,
      }),
    }
  }

  /**
   * Publishes a verdict into the *verifier's* repository.
   *
   * The asymmetry is the point and it survives into the in-memory network: an
   * acceptance is written by the operator who received the part, in their own
   * repo, under their own key. The issuer cannot delete it. They can only
   * answer it.
   */
  async accept(params: {
    handle: string
    subject: { uri: string; cid: any }
    issuerDid: string
    partNumber: string
    serialNumber: string
    outcome: 'accepted' | 'rejected' | 'discrepancy'
    note?: string
    receivedAt?: string
  }): Promise<{ uri: string; cid: any }> {
    const org = this.org(params.handle)

    const record: Record<string, unknown> = {
      $type: ACCEPTANCE_NSID,
      subject: { uri: params.subject.uri, cid: params.subject.cid },
      issuerDid: params.issuerDid,
      verifierDid: org.did,
      partNumber: params.partNumber,
      serialNumber: params.serialNumber,
      outcome: params.outcome,
      ...(params.note ? { note: params.note } : {}),
      receivedAt:
        params.receivedAt ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    }

    const rkey = TID.nextStr()
    org.repo = await org.repo.applyWrites(
      [
        {
          action: WriteOpAction.Create,
          collection: ACCEPTANCE_NSID as any,
          rkey: rkey as any,
          record: record as any,
        },
      ],
      org.keypair,
    )

    return {
      uri: `at://${org.did}/${ACCEPTANCE_NSID}/${rkey}`,
      cid: await cidForLex(record as any),
    }
  }

  // ------------------------------------------------------- IdentityResolver

  async resolveHandle(handle: string): Promise<string | null> {
    if (this.unresolvable.has(handle)) return null
    return this.byHandle.get(handle) ?? null
  }

  async resolveDid(did: string): Promise<ResolvedIdentity | null> {
    const org = this.byDid.get(did)
    if (!org) return null
    return { did, pds: org.pds, signingKey: this.wrongKey.get(did) ?? org.keypair.did() }
  }

  async signingKeysAt(did: string, at: Date): Promise<SigningKey[] | null> {
    if (this.opaqueHistory.has(did)) return null
    const org = this.byDid.get(did)
    if (!org) return null
    const wrong = this.wrongKey.get(did)
    if (wrong) return [wrong]
    // A point query, not a cumulative one: the key valid at an instant is the
    // one from the most recent rotation at or before it. Returning every key
    // ever published would make the check almost impossible to fail.
    const epochs = org.keyHistory.filter((e) => e.from <= at)
    const active = epochs.length > 0 ? epochs[epochs.length - 1]! : org.keyHistory[0]!
    return [active.key]
  }

  // ------------------------------------------------------------- RepoClient

  async getRecordProof(location: RecordLocation): Promise<Uint8Array> {
    if (this.offline.has(location.pds)) {
      throw new RepoFetchError(`connection refused: ${location.pds}`)
    }
    const org = this.byDid.get(location.did)
    if (!org) throw new RepoFetchError(`unknown repo: ${location.did}`)

    const chunks: Uint8Array[] = []
    for await (const chunk of getRecords(org.storage, org.repo.cid, [
      { collection: location.collection, rkey: location.rkey },
    ])) {
      chunks.push(chunk)
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
}

/**
 * A realistic return-to-service form, used as the base for most cases.
 *
 * Block 14 is the certifying column, so the approval basis is one of the two
 * legal under it. Block 12 carries what the shop found, which is where the
 * commercially sensitive detail of a real 8130-3 actually lives.
 */
export const overhaulForm: RawForm = {
  approvingAuthority: 'FAA/United States',
  formNumber: 'SYNTHETIC-8130-0002',
  organizationName: 'Cascadia MRO',
  organizationAddress: '4400 Airport Way, Everett, WA 98204',
  workOrder: 'WO/2026/0042',
  item: 1,
  description: 'Fuel control unit',
  partNumber: 'NT-8821-04',
  quantity: 1,
  serialNumber: 'SN-000417',
  status: 'OVERHAULED',
  remarks: 'Metering valve wear beyond limits. Full overhaul per CMM 73-21-05.',
  certifyingBlock: 'RETURN_TO_SERVICE',
  approvalBasis: 'PART_43_RETURN_TO_SERVICE',
  signerCert: 'SYNTHETIC-CERT-12345',
  signerName: 'A. Technician',
  completedAt: '2026-01-22T09:30:00Z',
}

/** New manufacture, so Block 13 certifies conformity instead. */
export const birthForm: RawForm = {
  approvingAuthority: 'FAA/United States',
  formNumber: 'SYNTHETIC-8130-0001',
  organizationName: 'Northwind Turbine',
  organizationAddress: '1200 Industrial Loop, Wichita, KS 67209',
  workOrder: 'WO/2019/1180',
  item: 1,
  description: 'Fuel control unit',
  partNumber: 'NT-8821-04',
  quantity: 1,
  serialNumber: 'SN-000417',
  status: 'NEW',
  remarks: 'Production acceptance test complete.',
  certifyingBlock: 'CONFORMITY',
  approvalBasis: 'APPROVED_DESIGN_DATA',
  signerCert: 'SYNTHETIC-CERT-00081',
  signerName: 'R. Inspector',
  completedAt: '2019-03-11T14:02:00Z',
}

export const NORTHWIND = {
  handle: 'northwind-turbine.f8130.cldixon.dev',
  did: 'did:plc:nw7hd3kq2xr5mabcdefghijk',
  pds: 'https://pds.f8130.cldixon.dev',
}

export const CASCADIA = {
  handle: 'cascadia-mro.f8130.cldixon.dev',
  did: 'did:plc:cs4gk2mp7yv6nbcdefghijkl',
  // deliberately a different host: the chain must cross an infrastructure
  // boundary, not merely a repository boundary
  pds: 'https://pds2.f8130.cldixon.dev',
}

export const MERIDIAN = {
  handle: 'meridian-aeroparts.f8130.cldixon.dev',
  did: 'did:plc:mr5jq8tn3wz7pbcdefghijkm',
  pds: 'https://pds.f8130.cldixon.dev',
}

/** Convenience: a two-org network with a birth and an overhaul chained to it. */
export async function standardNetwork() {
  const net = new MemoryNetwork()
  await net.createOrg(NORTHWIND)
  await net.createOrg(CASCADIA)
  await net.createOrg(MERIDIAN)

  const birth = await net.issue({ handle: NORTHWIND.handle, form: birthForm })
  const overhaul = await net.issue({
    handle: CASCADIA.handle,
    form: overhaulForm,
    prev: { uri: birth.uri, cid: birth.cid },
  })

  return { net, birth, overhaul }
}


/**
 * A DID for an organization that exists only in memory.
 *
 * Deterministic in the slug so a demo instance is stable across restarts, and
 * it never touches plc.directory — nothing here is registered anywhere. The
 * `dm` prefix inside the identifier is a further guard: a real did:plc
 * identifier is the base32 of a genesis-operation hash, so one beginning with
 * a fixed marker cannot be mistaken for a registered identity.
 */
function demoDid(slug: string): string {
  const digest = createHash('sha256').update(slug).digest()
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let out = 'dm'
  for (let i = 0; out.length < 24; i++) out += alphabet[digest[i]! % 32]
  return `did:plc:${out}`
}

/**
 * The whole demonstration cast, in memory.
 *
 * Demo mode used to hold three organizations, which was enough to verify a
 * chain and far too few to watch a system work: an activity feed drawn from
 * three parties reads as three parties talking to themselves. This builds every
 * organization on the roster, keeping the three pinned DIDs for the ones whose
 * fixtures and sample bundles name them.
 */
export async function demoNetwork(domain = 'f8130.cldixon.dev') {
  const net = new MemoryNetwork()
  const pinned = new Map(
    [NORTHWIND, CASCADIA, MERIDIAN].map((o) => [o.handle, o] as const),
  )

  for (const org of orgs(domain)) {
    const fixed = pinned.get(org.handle)
    await net.createOrg(fixed ?? { handle: org.handle, did: demoDid(org.slug) })
  }

  const birth = await net.issue({ handle: NORTHWIND.handle, form: birthForm })
  const overhaul = await net.issue({
    handle: CASCADIA.handle,
    form: overhaulForm,
    prev: { uri: birth.uri, cid: birth.cid },
  })

  return { net, birth, overhaul }
}
