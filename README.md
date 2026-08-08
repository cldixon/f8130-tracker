# f8130 — verifiable release certificates on AT Protocol

> ## ⚠️ ALL DATA IN THIS REPOSITORY IS SYNTHETIC
>
> Fictional organizations, fictional CAGE codes, non-existent part numbers.
> Nothing here is an airworthiness record, and nothing here is an accepted
> scheme for one. FAA AC 120-78A permits electronic records and signatures,
> but a DID-signed record is **not** an approved method. This is a protocol
> demonstration and must never be presented as an airworthiness system.

A demonstration that FAA 8130-3 Authorized Release Certificates, and the
back-to-birth traceability behind them, can be made cryptographically
verifiable using AT Protocol as the identity, storage, and distribution
layer — while disclosing none of the commercially sensitive contents.

## The idea

**Publish a commitment, deliver the document.**

The real failure mode in aviation parts fraud is not tampering with shared
records. It is forgery at the source: documents attributed to real, reputable
repair stations that never issued them. So a repair station's atproto handle
*is* its domain, DNS-verified, and its records are signed by keys in its DID
document. A release certificate is valid only if a matching commitment record
exists in the issuer's own repo. Forging one requires compromising the
station's domain *and* its signing key, not editing a PDF.

The public record carries only identifiers and a Merkle root over the form's
fields. The document itself — findings, cost, customer — travels bilaterally
as a "bundle," exactly as paperwork moves today. Anyone can verify authorship
and integrity; nobody learns the commercial content.

Completeness stays public even when contents are not. Each release links its
predecessor, so a seller can withhold a document but cannot hide that the
chain fails to reach birth.

## Status

Early. Built so far:

| | |
|---|---|
| `lexicons/` | `release`, `acceptance`, `dispute` record schemas |
| `core/` | TypeScript commitment core and the seven-stage verification pipeline |
| `commitment/` | Go implementation of the same commitment scheme |
| `ingest/` | firehose consumer, signature verification, derived Postgres index |
| `cmd/ingest/` | `run` and `reindex` commands |
| `web/` | the AppView — verify page, part timeline, dashboard, JSON API |
| `testdata/vectors.json` | the cross-language contract both cores must satisfy |
| `spike/` | validation that the atproto verification primitives hold up |

Not yet built: the PDS deployment, record issuance, and the second AppView.

Run it now, with nothing installed and nothing deployed:

```bash
npm install
F8130_DEMO_MODE=1 npm run dev     # http://localhost:3000
curl localhost:3000/demo/bundles.json   # genuine, tampered, forged
```

Demo mode serves an in-memory network of real repositories with real signing
keys and real inclusion proofs. Paste the `tampered` bundle into the verify
page to see the moment the design is built around: a genuine signature beside
a commitment that no longer matches.

```bash
npm install && npm test        # TypeScript: commitment core + verification pipeline
go test ./commitment/          # Go core, against the same vectors

# Database tests need a live PostgreSQL; without the variable they skip.
F8130_TEST_DSN='postgres://...' go test ./ingest/
```

## Deployment

A demo-mode instance of the web service runs on Railway:

**https://web-production-287a3.up.railway.app**

Configuration that matters, recorded because it was not obvious:

- **`RAILWAY_DOCKERFILE_PATH=web/Dockerfile`.** This repository holds a Node
  workspace and a Go module side by side, and Railway's build detection finds
  `go.mod` at the root first — the first deploy attempt built the Go service by
  mistake and failed fetching a Go toolchain. Each service declares its own
  Dockerfile rather than relying on detection.
- **`F8130_DEMO_MODE=1`.** No PDS or database is attached yet, so the service
  runs against the in-memory network and serves sample bundles at
  `/demo/bundles.json`.
- Pushing to the branch does not appear to trigger a rebuild on its own;
  changing any service variable does.

## Two implementations on purpose

The commitment scheme is meant to be implementable from its specification
alone. The only way to know whether it actually is — rather than having
quietly encoded a JavaScript quirk — is to write it twice and make both agree
byte for byte.

That has already earned its keep. JavaScript's `\s` matches non-breaking
spaces, Unicode space separators, and the BOM; Go's matches five ASCII
characters. A form pasted out of a spreadsheet would have canonicalized
differently in the two languages, and the disagreement would have surfaced
much later as an unverifiable document rather than as an error.

## Design notes

- **Field order is schema.** Changing the order, membership, or normalization
  of the committed field set changes every root ever produced. Versioned,
  never edited.
- **Nonces are non-negotiable.** 8130-3 fields are extremely low entropy — a
  status is one of five values. An unsalted commitment is brute-forced
  instantly by anyone holding the root.
- **Domain separation prefixes are mandatory.** Without them an internal node
  can be presented as a leaf.
- **Null and absent are identical; an empty string is neither.** A shop that
  wrote nothing in the remarks box committed to an empty remarks box, which is
  a different claim from having no remarks field.
- **Bundles never touch server storage.** Holding them would rebuild the
  central repository of sensitive data the design exists to avoid.

## Known gaps

Stated rather than silently fixed:

- **Nonce custody is unsolved.** Lose the bundle and the part becomes
  unverifiable even though the commitment stands. Production would need
  escrow or deterministic nonce derivation from a station-held secret.
- **Timestamps are claims.** `completedAt` is attacker-controlled; a
  self-hosted PDS can backdate. Only an independent observer's recorded time
  means anything, and one observer is a partial defense at best.
- **No revocation flow** for a release whose issuer is later decertified.
- **`signerCert` is a string**, not a DID reference. Individual
  counter-signing and aircraft logbooks are documented extensions,
  deliberately not built.

## Credits

Design and specification by [@cldixon](https://github.com/cldixon).
