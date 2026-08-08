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
import type {
  IdentityResolver,
  RecordLocation,
  RepoClient,
  ResolvedIdentity,
  SigningKey,
} from './ports.js'
import { RepoFetchError } from './ports.js'
import type { Bundle } from '../bundle.js'

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

/** A realistic overhaul form, used as the base for most cases. */
export const overhaulForm: RawForm = {
  formNumber: 'SYNTHETIC-8130-0002',
  partNumber: 'NT-8821-04',
  serialNumber: 'SN-000417',
  description: 'Fuel control unit',
  status: 'OVERHAULED',
  quantity: 1,
  workOrder: 'WO/2026/0042',
  findings: 'Metering valve wear beyond limits',
  workscope: 'Full overhaul per CMM 73-21-05',
  costCents: 1_284_500,
  customer: 'Example Air',
  signerCert: 'SYNTHETIC-CERT-12345',
  signerName: 'A. Technician',
  remarks: 'Returned to service',
  completedAt: '2026-01-22T09:30:00Z',
}

export const birthForm: RawForm = {
  formNumber: 'SYNTHETIC-8130-0001',
  partNumber: 'NT-8821-04',
  serialNumber: 'SN-000417',
  description: 'Fuel control unit',
  status: 'NEW',
  quantity: 1,
  workOrder: 'WO/2019/1180',
  findings: 'None; new manufacture',
  workscope: 'Production acceptance test',
  costCents: 4_250_000,
  customer: 'Cascadia MRO',
  signerCert: 'SYNTHETIC-CERT-00081',
  signerName: 'R. Inspector',
  remarks: '',
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

