/**
 * Spike part 2 — identity resolution (§4.4 stage 1).
 *
 * Split into the two halves that fail independently:
 *   a) handle -> DID   via DNS TXT `_atproto.<handle>`   (UDP/53)
 *   b) DID -> DID doc  via plc.directory                 (HTTPS)
 *
 * (b) is subject to this environment's egress policy; (a) is not.
 */

import { HandleResolver, DidResolver } from '@atproto/identity'

const HANDLES = ['bsky.app', 'jay.bsky.team']

async function main() {
  console.log('\n\x1b[1mf8130 spike — identity resolution\x1b[0m\n')

  console.log('\x1b[1ma) handle → DID (DNS TXT)\x1b[0m')
  const handleResolver = new HandleResolver()
  const dids: string[] = []
  for (const handle of HANDLES) {
    try {
      const did = await handleResolver.resolve(handle)
      if (did) dids.push(did)
      console.log(`  \x1b[32mPASS\x1b[0m  ${handle} → ${did}`)
    } catch (err: any) {
      console.log(`  \x1b[31mFAIL\x1b[0m  ${handle} → ${err.code ?? err.message}`)
    }
  }

  console.log('\n\x1b[1mb) DID → DID document (plc.directory over HTTPS)\x1b[0m')
  const didResolver = new DidResolver({})
  for (const did of dids) {
    try {
      const doc = await didResolver.resolve(did)
      const pds = doc?.service?.find((s: any) => s.id === '#atproto_pds')
      const key = doc?.verificationMethod?.find((v: any) =>
        v.id.endsWith('#atproto'),
      )
      console.log(
        `  \x1b[32mPASS\x1b[0m  ${did}\n         pds=${(pds as any)?.serviceEndpoint}\n         key=${(key as any)?.publicKeyMultibase?.slice(0, 20)}…`,
      )
    } catch (err: any) {
      const msg = String(err?.cause?.message ?? err?.message ?? err)
      console.log(`  \x1b[33mBLOCKED\x1b[0m  ${did} → ${msg.slice(0, 90)}`)
    }
  }
  console.log()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
