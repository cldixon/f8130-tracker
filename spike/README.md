# Spike — atproto verification primitives

Throwaway validation run **before** committing to the architecture in the
handoff doc. The question it answers: *can the §4.4 verification pipeline
actually be built on the official TypeScript SDKs, or does it need
hand-rolled CAR/MST code?*

Answer: it can. `@atproto/repo` ships both halves — the provider side a PDS
uses to emit proofs, and the consumer side our verifier runs. Because both
are in the same package, the whole spike runs **offline**, generating real
proofs locally instead of fetching them over XRPC.

```
npm install
npx tsx spike.ts      # 15 assertions, all green
npx tsx resolve.ts    # identity resolution, network-dependent
```

## What was proven

| Pipeline stage | Result |
|---|---|
| Commit signature verifies against a signing key | works (`verifyProofs`, `verifyRepoCar`) |
| Signature under a foreign key is rejected | works — both proof and whole-repo paths |
| Single-record inclusion proof | works (`getRecords` → `verifyProofs`), ~734 byte CAR |
| Wrong record CID rejected | works |
| **Proof of non-existence** | works — `cid: null` claim, ~423 byte CAR |
| False claim of absence rejected | works |
| Whole-repo CAR fallback | works (`getFullRepo` → `verifyRepoCar`) |
| `commitment` as 32 raw bytes round-trips | works — stays a `Uint8Array` through DAG-CBOR |
| `prev` strongRef round-trips | works — `{uri, cid}` survives intact |
| Chain across a repo/PDS boundary | works — predecessor verified in a different repo under a different key |

## Findings that change the build

1. **`com.atproto.sync.getRecord` gives exclusion proofs, not just 404s.**
   `RecordCidClaim.cid` is nullable, and a `null` claim verifies as a proof
   the record is absent. Demo scenario 3 (forged bundle naming an issuer that
   never published) gets a cryptographic answer rather than a missing-response
   answer. Worth surfacing explicitly in the verify UI.

2. **The whole-repo fallback is not a downgrade.** `verifyRepoCar` performs
   the same signature check and returns every record. For repos this size the
   CARs are within a few hundred bytes of each other. Keep per-record proofs
   as the default, but the fallback costs nothing.

3. **`strongRef` for `prev` is confirmed necessary and sufficient.** A bare
   CID cannot be fetched; `{uri, cid}` lets the verifier both locate the
   predecessor and pin its content. The cross-repo test is the one that
   matters — the chain is walkable with no shared index and no shared
   infrastructure.

4. **ESM only.** `multiformats` is ESM-only; anything resolving these
   packages through CJS fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` on
   `multiformats/cid`. `"type": "module"` everywhere, and don't pin
   `multiformats` directly — let the atproto packages bring their own.

## Environment limitation

`resolve.ts` splits identity resolution into its two failure modes:

- **handle → DID via DNS TXT** — works against the real network, verified
  with live Bluesky handles.
- **DID → DID document via plc.directory** — **blocked**, HTTPS egress policy
  returns 403.

So the signing key and PDS endpoint can't be fetched from this session yet.
Nothing about the design depends on that being resolved right now, but live
integration testing will need `plc.directory` (and later the PDS hosts)
allowed in the environment's network policy.

## Not covered

XRPC transport shape (real PDS responses), OAuth/DPoP, firehose framing, and
the Go side of the crypto core. Those come with M1/M2.
