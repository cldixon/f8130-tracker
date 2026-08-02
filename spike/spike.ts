/**
 * f8130 spike — validate the atproto verification primitives in TypeScript.
 *
 * Goal: prove that the §4.4 verification pipeline is buildable before writing
 * ingest, the AppViews, or any Railway infrastructure. Specifically:
 *
 *   1. a signed commit can be verified against a signing key
 *   2. a single record's inclusion under that commit can be proven (sync.getRecord)
 *   3. a record's *non*-existence can be proven (demo scenario 3: forgery)
 *   4. the whole-repo CAR fallback works (sync.getRepo)
 *   5. a `prev` chain can cross a repo/PDS boundary and still verify
 *
 * Runs fully offline: @atproto/repo ships both the provider side (what a PDS
 * emits) and the consumer side (what our verifier runs), so we generate real
 * proofs locally rather than fetching them over XRPC.
 */

import { MemoryBlockstore, Repo, WriteOpAction } from '@atproto/repo'
import { getRecords, getFullRepo } from '@atproto/repo'
import { verifyProofs, verifyRecords, verifyRepoCar } from '@atproto/repo'
import { Secp256k1Keypair } from '@atproto/crypto'
import { TID } from '@atproto/common'
import { CID } from 'multiformats'

const NSID = 'dev.cldixon.f8130.release'
const NORTHWIND_DID = 'did:plc:nw7hd3kq2xr5mabcdefghijk'
const CASCADIA_DID = 'did:plc:cs4gk2mp7yv6nbcdefghijkl'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? `  — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `  — ${detail}` : ''}`)
  }
}

async function collect(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const c of iter) chunks.push(c)
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** A release record shaped like the real lexicon, incl. a 32-byte commitment. */
function releaseRecord(opts: {
  commitment: Uint8Array
  issuerDid: string
  partNumber: string
  serialNumber: string
  status: string
  completedAt: string
  prev?: { uri: string; cid: CID }
}) {
  const rec: Record<string, unknown> = {
    $type: NSID,
    commitment: opts.commitment,
    issuerDid: opts.issuerDid,
    formNumber: 'SYNTHETIC-8130-0001',
    partNumber: opts.partNumber,
    serialNumber: opts.serialNumber,
    status: opts.status,
    signerCert: 'SYNTHETICCERT12345',
    completedAt: opts.completedAt,
  }
  if (opts.prev) rec.prev = { uri: opts.prev.uri, cid: opts.prev.cid }
  return rec as any
}

async function main() {
  console.log('\n\x1b[1mf8130 spike — atproto verification primitives\x1b[0m\n')

  // ---------------------------------------------------------------- setup
  const northwindKey = await Secp256k1Keypair.create({ exportable: true })
  const cascadiaKey = await Secp256k1Keypair.create({ exportable: true })
  const northwindStorage = new MemoryBlockstore()
  const cascadiaStorage = new MemoryBlockstore()

  const birthRkey = TID.nextStr()
  const commitmentA = new Uint8Array(32).fill(0xa1)

  let northwind = await Repo.create(northwindStorage, NORTHWIND_DID, northwindKey)
  northwind = await northwind.applyWrites(
    [
      {
        action: WriteOpAction.Create,
        collection: NSID as any,
        rkey: birthRkey as any,
        record: releaseRecord({
          commitment: commitmentA,
          issuerDid: NORTHWIND_DID,
          partNumber: 'NT-8821-04',
          serialNumber: 'SN-000417',
          status: 'NEW',
          completedAt: '2019-03-11T14:02:00Z',
        }),
      },
    ],
    northwindKey,
  )

  const birthCid = await northwind.data.get(`${NSID}/${birthRkey}`)
  if (!birthCid) throw new Error('birth record not found in MST')

  console.log('\x1b[1m1. Commit signature + record inclusion proof\x1b[0m')

  // ------------------------------------------- inclusion proof (happy path)
  const proofCar = await collect(
    getRecords(northwindStorage, northwind.cid, [
      { collection: NSID, rkey: birthRkey },
    ]),
  )

  const res = await verifyProofs(
    proofCar,
    [{ collection: NSID, rkey: birthRkey, cid: birthCid }],
    NORTHWIND_DID,
    northwindKey.did(),
  )
  check(
    'inclusion proof verifies against signing key',
    res.verified.length === 1 && res.unverified.length === 0,
    `${proofCar.length} byte CAR`,
  )

  // record content survives the round trip, including `bytes`
  const records = await verifyRecords(proofCar, NORTHWIND_DID, northwindKey.did())
  const rec = records[0]?.record as any
  check('record content recovered from proof', records.length === 1)
  check(
    'commitment round-trips as 32 raw bytes',
    rec?.commitment instanceof Uint8Array &&
      rec.commitment.length === 32 &&
      rec.commitment[0] === 0xa1,
    `${rec?.commitment?.constructor?.name}(${rec?.commitment?.length})`,
  )
  check(
    'public lexicon fields intact',
    rec?.partNumber === 'NT-8821-04' && rec?.status === 'NEW',
  )

  // ---------------------------------------------------- tampering detection
  const wrongCid = CID.parse(
    'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a',
  )
  const tampered = await verifyProofs(
    proofCar,
    [{ collection: NSID, rkey: birthRkey, cid: wrongCid as any }],
    NORTHWIND_DID,
    northwindKey.did(),
  )
  check(
    'wrong record CID is rejected',
    tampered.verified.length === 0 && tampered.unverified.length === 1,
  )

  // ------------------------------------------------- wrong key is rejected
  const impostorKey = await Secp256k1Keypair.create()
  let sigRejected = false
  try {
    await verifyProofs(
      proofCar,
      [{ collection: NSID, rkey: birthRkey, cid: birthCid }],
      NORTHWIND_DID,
      impostorKey.did(),
    )
  } catch {
    sigRejected = true
  }
  check('commit signed by another key is rejected', sigRejected)

  // ------------------------------------------------------ non-existence
  console.log('\n\x1b[1m2. Proof of non-existence (forgery scenario)\x1b[0m')

  const ghostRkey = TID.nextStr()
  const exclusionCar = await collect(
    getRecords(northwindStorage, northwind.cid, [
      { collection: NSID, rkey: ghostRkey },
    ]),
  )
  const exclusion = await verifyProofs(
    exclusionCar,
    [{ collection: NSID, rkey: ghostRkey, cid: null }],
    NORTHWIND_DID,
    northwindKey.did(),
  )
  check(
    'absence of a record is cryptographically provable',
    exclusion.verified.length === 1,
    `${exclusionCar.length} byte CAR`,
  )

  const falseExclusion = await verifyProofs(
    proofCar,
    [{ collection: NSID, rkey: birthRkey, cid: null }],
    NORTHWIND_DID,
    northwindKey.did(),
  )
  check(
    'false claim of absence is rejected',
    falseExclusion.verified.length === 0 && falseExclusion.unverified.length === 1,
  )

  // ------------------------------------------------------ whole-repo CAR
  console.log('\n\x1b[1m3. Whole-repo CAR fallback (sync.getRepo)\x1b[0m')

  const fullCar = await collect(getFullRepo(northwindStorage, northwind.cid))
  const verifiedRepo = await verifyRepoCar(fullCar, NORTHWIND_DID, northwindKey.did())
  check(
    'full repo CAR verifies',
    verifiedRepo.commit.cid.toString() === northwind.cid.toString(),
    `${fullCar.length} byte CAR, rev ${verifiedRepo.commit.rev}`,
  )
  check(
    'record locatable inside verified repo',
    verifiedRepo.creates.some((c: any) => c.rkey === birthRkey),
  )

  // the signature check must actually be load-bearing
  let repoCarRejected = false
  try {
    await verifyRepoCar(fullCar, NORTHWIND_DID, impostorKey.did())
  } catch {
    repoCarRejected = true
  }
  check('full repo CAR under a foreign key is rejected', repoCarRejected)

  // --------------------------------------------- cross-repo `prev` chain
  console.log('\n\x1b[1m4. Chain crossing a repo (PDS) boundary\x1b[0m')

  const birthUri = `at://${NORTHWIND_DID}/${NSID}/${birthRkey}`
  const overhaulRkey = TID.nextStr()

  let cascadia = await Repo.create(cascadiaStorage, CASCADIA_DID, cascadiaKey)
  cascadia = await cascadia.applyWrites(
    [
      {
        action: WriteOpAction.Create,
        collection: NSID as any,
        rkey: overhaulRkey as any,
        record: releaseRecord({
          commitment: new Uint8Array(32).fill(0xb2),
          issuerDid: CASCADIA_DID,
          partNumber: 'NT-8821-04',
          serialNumber: 'SN-000417',
          status: 'OVERHAULED',
          completedAt: '2026-01-22T09:30:00Z',
          prev: { uri: birthUri, cid: birthCid as any },
        }),
      },
    ],
    cascadiaKey,
  )

  const overhaulCid = await cascadia.data.get(`${NSID}/${overhaulRkey}`)
  const overhaulProof = await collect(
    getRecords(cascadiaStorage, cascadia.cid, [
      { collection: NSID, rkey: overhaulRkey },
    ]),
  )
  const overhaulVerified = await verifyProofs(
    overhaulProof,
    [{ collection: NSID, rkey: overhaulRkey, cid: overhaulCid! }],
    CASCADIA_DID,
    cascadiaKey.did(),
  )
  check(
    'overhaul release verifies in its own repo',
    overhaulVerified.verified.length === 1,
  )

  // walk prev: parse the strongRef, then verify the predecessor independently
  const overhaulRecords = await verifyRecords(
    overhaulProof,
    CASCADIA_DID,
    cascadiaKey.did(),
  )
  const prevRef = (overhaulRecords[0]?.record as any)?.prev
  check(
    'strongRef prev survives DAG-CBOR round trip',
    prevRef?.uri === birthUri && prevRef?.cid?.toString() === birthCid.toString(),
    prevRef?.uri,
  )

  // the verifier now has enough to locate AND pin the predecessor
  const [, , prevDid, prevCollection, prevRkey] = prevRef.uri.split('/')
  const prevProof = await collect(
    getRecords(northwindStorage, northwind.cid, [
      { collection: prevCollection, rkey: prevRkey },
    ]),
  )
  const prevVerified = await verifyProofs(
    prevProof,
    [{ collection: prevCollection, rkey: prevRkey, cid: prevRef.cid }],
    prevDid,
    northwindKey.did(),
  )
  check(
    'predecessor verifies in a different repo under a different key',
    prevVerified.verified.length === 1,
    `${prevDid} ≠ ${CASCADIA_DID}`,
  )

  const isBirth = !(overhaulRecords[0]?.record as any)?.prev?.uri
    ? true
    : !(records[0]?.record as any)?.prev
  check('chain terminates at birth (no prev on oldest record)', isBirth)

  // ----------------------------------------------------------------- done
  console.log(
    `\n\x1b[1m${failed === 0 ? '\x1b[32mALL GREEN' : '\x1b[31mFAILURES'}\x1b[0m  ${passed} passed, ${failed} failed\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n\x1b[31mspike crashed\x1b[0m\n', err)
  process.exit(1)
})
