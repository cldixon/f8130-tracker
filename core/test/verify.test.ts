import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseBundle } from '../src/bundle.js'
import { verifyBundle } from '../src/verify/pipeline.js'
import {
  birthForm,
  CASCADIA,
  FakeNetwork,
  MERIDIAN,
  NORTHWIND,
  overhaulForm,
  stage,
  standardNetwork,
} from './fixture.js'

describe('happy path', () => {
  test('a genuine certificate passes every stage', async () => {
    const { net, overhaul } = await standardNetwork()
    const report = await verifyBundle({
      bundle: overhaul.bundle,
      stampedSerial: 'SN-000417',
      resolver: net,
      repo: net,
    })

    assert.equal(report.verified, true, JSON.stringify(report.stages, null, 2))
    for (const s of report.stages) {
      assert.ok(
        s.status === 'pass',
        `${s.name} was ${s.status}: ${s.detail}`,
      )
    }
    assert.equal(report.reachedBirth, true)
    assert.equal(report.chain.length, 2)
    assert.equal(report.issuer?.handle, CASCADIA.handle)
  })

  test('the chain crosses an infrastructure boundary', async () => {
    const { net, overhaul } = await standardNetwork()
    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
    })
    const issuers = report.chain.map((l) => l.issuerDid)
    assert.deepEqual(issuers, [CASCADIA.did, NORTHWIND.did])
    assert.notEqual(CASCADIA.pds, NORTHWIND.pds)
  })

  test('the physical stage is skipped when no serial is supplied', async () => {
    const { net, overhaul } = await standardNetwork()
    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
    })
    assert.equal(stage(report, 'physical').status, 'skipped')
    assert.equal(report.verified, true)
  })
})

describe('tampering — the instructive failure', () => {
  test('signature passes and commitment fails', async () => {
    const { net, overhaul } = await standardNetwork()

    const tampered = parseBundle({
      ...JSON.parse(JSON.stringify(overhaul.bundle)),
      values: {
        ...overhaul.bundle.values,
        remarks: 'No defects found.',
      },
    })

    const report = await verifyBundle({
      bundle: tampered,
      resolver: net,
      repo: net,
    })

    assert.equal(stage(report, 'resolve').status, 'pass')
    assert.equal(stage(report, 'fetch').status, 'pass')
    // the station really did sign a record for this part...
    assert.equal(stage(report, 'signature').status, 'pass')
    // ...but not this document
    assert.equal(stage(report, 'recompute').status, 'fail')
    assert.equal(report.verified, false)
    assert.match(stage(report, 'recompute').detail, /altered/)
  })

  test('altering a private field is caught even though it is never published', async () => {
    const { net, overhaul } = await standardNetwork()
    const tampered = parseBundle({
      ...JSON.parse(JSON.stringify(overhaul.bundle)),
      values: { ...overhaul.bundle.values, workOrder: 'WO/2026/9999' },
    })
    const report = await verifyBundle({ bundle: tampered, resolver: net, repo: net })
    assert.equal(stage(report, 'recompute').status, 'fail')
    // the public fields still agree — only the commitment catches this
    assert.equal(stage(report, 'agree').status, 'pass')
  })

  test('swapping a nonce breaks the commitment', async () => {
    const { net, overhaul } = await standardNetwork()
    const nonces = [...overhaul.bundle.nonces]
    nonces[7] = 'ab'.repeat(32)
    const tampered = parseBundle({
      ...JSON.parse(JSON.stringify(overhaul.bundle)),
      nonces,
    })
    const report = await verifyBundle({ bundle: tampered, resolver: net, repo: net })
    assert.equal(stage(report, 'recompute').status, 'fail')
  })
})

describe('forgery', () => {
  test('a document naming an issuer who never published it dies with a proof of absence', async () => {
    const { net, overhaul } = await standardNetwork()

    // A broker fabricates paperwork attributed to a real, reputable station:
    // the AOG Technics pattern.
    const forged = parseBundle({
      ...JSON.parse(JSON.stringify(overhaul.bundle)),
      uri: `at://${CASCADIA.did}/dev.cldixon.f8130.release/3mzzzzzzzzz2z`,
    })

    const report = await verifyBundle({ bundle: forged, resolver: net, repo: net })

    assert.equal(stage(report, 'resolve').status, 'pass')
    assert.equal(stage(report, 'fetch').status, 'fail')
    assert.equal(stage(report, 'fetch').data?.proofOfAbsence, true)
    // the absence is itself signed — this is stronger than a 404
    assert.equal(stage(report, 'signature').status, 'pass')
    assert.equal(report.verified, false)
    assert.match(stage(report, 'fetch').detail, /never published/)
  })

  test('a handle pointed at someone else’s record fails at resolve', async () => {
    const { net, overhaul } = await standardNetwork()
    const forged = parseBundle({
      ...JSON.parse(JSON.stringify(overhaul.bundle)),
      issuerHandle: MERIDIAN.handle,
    })
    const report = await verifyBundle({ bundle: forged, resolver: net, repo: net })
    assert.equal(stage(report, 'resolve').status, 'fail')
    assert.equal(stage(report, 'fetch').status, 'skipped')
    assert.match(stage(report, 'resolve').detail, /does not actually come from/)
  })

  test('an unclaimed domain fails at resolve', async () => {
    const { net, overhaul } = await standardNetwork()
    net.makeUnresolvable(CASCADIA.handle)
    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
    })
    assert.equal(stage(report, 'resolve').status, 'fail')
    assert.match(stage(report, 'resolve').detail, /does not resolve/)
  })

  test('an unreachable server fails at fetch without claiming forgery', async () => {
    const { net, overhaul } = await standardNetwork()
    net.offline.add(CASCADIA.pds)
    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
    })
    assert.equal(stage(report, 'fetch').status, 'fail')
    assert.equal(stage(report, 'fetch').data?.proofOfAbsence, undefined)
    assert.match(stage(report, 'fetch').detail, /could not be reached/)
  })
})

describe('key validity in time', () => {
  test('a record stays valid after its issuer rotates keys', async () => {
    const { net, overhaul } = await standardNetwork()

    // The record was signed in January; the station rotates in March. A PDS
    // re-signs the repository head on rotation, so the certificate keeps
    // verifying — a rotation is routine maintenance, not a fraud signal.
    await net.rotateKey(CASCADIA.handle, new Date('2026-03-01T00:00:00Z'))

    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
      keyValidityAnchor: new Date('2026-06-01T00:00:00Z'),
    })

    assert.equal(stage(report, 'signature').status, 'pass')
    assert.equal(report.verified, true)
  })

  test('unknown key history degrades to a warning, not a pass in disguise', async () => {
    const { net, overhaul } = await standardNetwork()
    net.hideKeyHistory(CASCADIA.did)

    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
    })

    const sig = stage(report, 'signature')
    assert.equal(sig.status, 'warn')
    assert.match(sig.detail, /key rotation/)
    // a warning is not a failure — the document still verifies
    assert.equal(report.verified, true)
  })
})

describe('physical part', () => {
  test('a matching stamped serial passes', async () => {
    const { net, overhaul } = await standardNetwork()
    const report = await verifyBundle({
      bundle: overhaul.bundle,
      stampedSerial: 'sn 000417',
      resolver: net,
      repo: net,
    })
    assert.equal(stage(report, 'physical').status, 'pass')
  })

  test('paperwork for a different part fails', async () => {
    const { net, overhaul } = await standardNetwork()
    const report = await verifyBundle({
      bundle: overhaul.bundle,
      stampedSerial: 'SN-000999',
      resolver: net,
      repo: net,
    })
    assert.equal(stage(report, 'physical').status, 'fail')
    assert.match(stage(report, 'physical').detail, /different part/)
    assert.equal(report.verified, false)
  })
})

describe('back to birth', () => {
  test('a release with no predecessor is itself birth', async () => {
    const { net, birth } = await standardNetwork()
    const report = await verifyBundle({
      bundle: birth.bundle,
      resolver: net,
      repo: net,
    })
    assert.equal(stage(report, 'chain').status, 'pass')
    assert.equal(report.chain.length, 1)
    assert.equal(report.reachedBirth, true)
  })

  test('a chain whose predecessor was never published is reported as a hole', async () => {
    const net = new FakeNetwork()
    await net.createOrg(CASCADIA)

    const orphan = await net.issue({
      handle: CASCADIA.handle,
      form: overhaulForm,
      prev: {
        uri: `at://${CASCADIA.did}/dev.cldixon.f8130.release/3mmissing0000`,
        cid: (await net.issue({ handle: CASCADIA.handle, form: birthForm })).cid,
      },
    })

    const report = await verifyBundle({
      bundle: orphan.bundle,
      resolver: net,
      repo: net,
    })

    assert.equal(stage(report, 'chain').status, 'fail')
    assert.equal(report.reachedBirth, false)
    assert.match(stage(report, 'chain').detail, /hole in it/)
    // everything else about the document is fine — only its history is not
    assert.equal(stage(report, 'signature').status, 'pass')
    assert.equal(stage(report, 'recompute').status, 'pass')
  })

  test('a chain stitched from an unrelated part is rejected', async () => {
    const net = new FakeNetwork()
    await net.createOrg(NORTHWIND)
    await net.createOrg(CASCADIA)

    // A genuine birth record — for a completely different part.
    const otherPart = await net.issue({
      handle: NORTHWIND.handle,
      form: { ...birthForm, partNumber: 'NT-9999-01', serialNumber: 'SN-888888' },
    })

    const stitched = await net.issue({
      handle: CASCADIA.handle,
      form: overhaulForm,
      prev: { uri: otherPart.uri, cid: otherPart.cid },
    })

    const report = await verifyBundle({
      bundle: stitched.bundle,
      resolver: net,
      repo: net,
    })

    assert.equal(stage(report, 'chain').status, 'fail')
    assert.match(stage(report, 'chain').detail, /different part/)
  })

  test('a predecessor rewritten since it was referenced is rejected', async () => {
    const net = new FakeNetwork()
    await net.createOrg(NORTHWIND)
    await net.createOrg(CASCADIA)

    const birth = await net.issue({ handle: NORTHWIND.handle, form: birthForm })

    // Reference it by a CID that does not match its contents: the location is
    // right, the content is not.
    const wrongCid = (
      await net.issue({
        handle: NORTHWIND.handle,
        form: { ...birthForm, remarks: 'different' },
      })
    ).cid

    const overhaul = await net.issue({
      handle: CASCADIA.handle,
      form: overhaulForm,
      prev: { uri: birth.uri, cid: wrongCid },
    })

    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
    })

    assert.equal(stage(report, 'chain').status, 'fail')
    assert.match(stage(report, 'chain').detail, /altered since/)
  })
})

describe('public fields', () => {
  test('a record whose plaintext disagrees with the document is caught', async () => {
    const { net, overhaul } = await standardNetwork()

    // The bundle claims a different description than the issuer published in
    // plaintext. Block 7 is on the public record; Block 11 is not, which is
    // why status cannot carry this test any more.
    const mismatched = parseBundle({
      ...JSON.parse(JSON.stringify(overhaul.bundle)),
      values: { ...overhaul.bundle.values, description: 'Bleed air valve' },
    })

    const report = await verifyBundle({
      bundle: mismatched,
      resolver: net,
      repo: net,
    })

    assert.equal(stage(report, 'agree').status, 'fail')
    assert.match(stage(report, 'agree').detail, /description/)
  })
})

describe('report shape', () => {
  test('always carries the synthetic marker and all seven stages', async () => {
    const { net, overhaul } = await standardNetwork()
    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
    })
    assert.match(report.synthetic, /SYNTHETIC/)
    assert.deepEqual(
      report.stages.map((s) => s.name),
      ['resolve', 'fetch', 'signature', 'recompute', 'agree', 'physical', 'chain'],
    )
  })

  test('a malformed URI fails closed with every later stage skipped', async () => {
    const { net, overhaul } = await standardNetwork()
    const bad = { ...overhaul.bundle, uri: 'at://nope' }
    const report = await verifyBundle({
      bundle: bad as any,
      resolver: net,
      repo: net,
    })
    assert.equal(report.verified, false)
    assert.equal(report.stages.filter((s) => s.status === 'skipped').length, 6)
  })
})

describe('signature is load-bearing', () => {
  test('a record not signed by the key the issuer publishes is rejected', async () => {
    const { net, overhaul } = await standardNetwork()

    // Same well-formed repository, same intact MST — but the identity
    // document now names a key that did not sign any of it.
    await net.publishWrongKey(CASCADIA.did)

    const report = await verifyBundle({
      bundle: overhaul.bundle,
      resolver: net,
      repo: net,
    })

    assert.equal(stage(report, 'signature').status, 'fail')
    assert.equal(stage(report, 'fetch').status, 'fail')
    assert.equal(stage(report, 'recompute').status, 'skipped')
    assert.equal(report.verified, false)
  })
})
