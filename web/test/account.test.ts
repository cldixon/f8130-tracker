/**
 * Account pages: one organization's repository, drawn as a profile.
 *
 * The claims worth holding honest here are not about layout.
 *
 *   - Both tabs exist because a repository holds two kinds of record, and
 *     eleven of the twenty-nine organizations in this demonstration issue
 *     nothing at all. A profile that showed only releases would tell a reader
 *     that every operator, broker and lessor does nothing.
 *   - The counts are arithmetic over this observer's index, and one of them
 *     used to be able to exceed the total it is shown against.
 *   - A handle and a DID address the same account, because the links in this
 *     application are built from handles and the records only carry DIDs.
 *   - Nothing on the page is a verdict, and the page says out loud that the
 *     profile is self-asserted.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { demoNetwork } from '@f8130/core'

import { createApp } from '../src/app.js'
import { MemoryIndex } from '../src/memory-index.js'
import type { AttestationRow, ReleaseRow } from '../src/index-port.js'

const DOMAIN = 'f8130.cldixon.dev'

const MRO = 'did:plc:issuer'
const OPERATOR = 'did:plc:operator'

const release = (over: Partial<ReleaseRow> = {}): ReleaseRow => ({
  cid: 'bafyrel',
  uri: `at://${MRO}/dev.cldixon.f8130.release/3a`,
  issuerDid: MRO,
  prevUri: null,
  prevCid: null,
  approvingAuthority: 'FAA/United States',
  formNumber: 'SYNTHETIC-8130-0001',
  organizationName: 'Cascadia MRO',
  organizationAddress: '4400 Airport Way, Everett, WA 98204',
  description: 'Fuel control unit',
  partNumber: 'NT882104',
  serialNumber: 'SN000417',
  signerCert: 'SYNTHETIC-CERT-1',
  completedAt: new Date('2026-01-22T09:30:00Z'),
  observedAt: new Date('2026-01-22T10:00:00Z'),
  ...over,
})

const attestation = (over: Partial<AttestationRow> = {}): AttestationRow => ({
  cid: 'bafyatt',
  uri: `at://${OPERATOR}/dev.cldixon.f8130.attestation/3b`,
  subjectUri: `at://${MRO}/dev.cldixon.f8130.release/3a`,
  subjectCid: 'bafyrel',
  verifierDid: OPERATOR,
  issuerDid: MRO,
  verifiedAt: new Date('2026-01-23T08:00:00Z'),
  observedAt: new Date('2026-01-23T08:05:00Z'),
  ...over,
})

async function accountApp(seed: (index: MemoryIndex) => void = () => {}) {
  const { net } = await demoNetwork(DOMAIN)
  const index = new MemoryIndex()
  seed(index)
  return { app: createApp({ resolver: net, repo: net, index, mode: 'live' }), index }
}

/** The station record a repair station published about itself. */
const shopProfile = (i: MemoryIndex) => {
  i.setHandle(MRO, `cascadia-mro.${DOMAIN}`)
  i.setActor({
    did: MRO,
    displayName: 'Cascadia MRO',
    kind: 'mro',
    cage: 'SYN0004',
    certificate: 'SYNTHETIC-CERT-12345',
  })
}

/** An operator: no releases, ever. It receives parts and checks paperwork. */
const operatorProfile = (i: MemoryIndex) => {
  i.setHandle(OPERATOR, `example-air.${DOMAIN}`)
  i.setActor({
    did: OPERATOR,
    displayName: 'Example Air',
    kind: 'operator',
    cage: 'SYN0017',
  })
}

describe('the account header', () => {
  test('names the organization from the profile it published itself', async () => {
    const { app } = await accountApp(shopProfile)
    const body = await (await app.request(`/profile/cascadia-mro.${DOMAIN}`)).text()

    assert.match(body, /Cascadia MRO/)
    assert.match(body, /Repair station/, 'the role was not spelled out')
    assert.match(body, /SYN0004/, 'the CAGE code is missing')
    assert.match(body, /SYNTHETIC-CERT-12345/, 'the certificate number is missing')
    assert.match(body, new RegExp(MRO), 'the DID is not reachable from the page')
  })

  /**
   * The handle is a domain the organization proved control of, and it is the
   * load-bearing half of the identity: issuing under this name means holding
   * this domain and the signing key its DID document declares.
   */
  test('shows the handle, which is the name that was verified', async () => {
    const { app } = await accountApp(shopProfile)
    const body = await (await app.request(`/profile/cascadia-mro.${DOMAIN}`)).text()
    assert.match(body, new RegExp(`cascadia-mro\\.${DOMAIN.replace(/\./g, '\\.')}`))
  })

  /**
   * The one thing this page must never do is present a self-asserted claim as
   * something the network established. Nothing binds a DID to a certificated
   * repair station, so a certificate number here is a string an organization
   * typed about itself.
   */
  test('says the profile is self-asserted rather than established', async () => {
    const { app } = await accountApp(shopProfile)
    const body = await (await app.request(`/profile/cascadia-mro.${DOMAIN}`)).text()
    assert.match(body, /[Ss]elf-asserted/)
    assert.match(body, /certificate number/, 'the list of self-asserted fields is wrong')
  })

  /**
   * An organization that never published a profile has no name to show, and
   * inventing one would be worse than the identifier. The honest page is one
   * that says what it does not know.
   */
  test('an account with no published profile says so', async () => {
    const { app } = await accountApp((i) => {
      i.setHandle(MRO, `cascadia-mro.${DOMAIN}`)
      i.addRelease(release())
    })
    const body = await (await app.request(`/profile/cascadia-mro.${DOMAIN}`)).text()
    assert.match(body, /never published a profile/)
    assert.ok(!body.includes('Self-asserted'), 'claimed a profile that does not exist')
  })
})

describe('addressing an account', () => {
  /**
   * Both names are in circulation and neither can be assumed: the links in
   * this application are built from handles, and a record only ever carries a
   * DID.
   */
  test('a DID and a handle reach the same page', async () => {
    const { app } = await accountApp(shopProfile)
    const byHandle = await (await app.request(`/profile/cascadia-mro.${DOMAIN}`)).text()
    const byDid = await (await app.request(`/profile/${MRO}`)).text()
    assert.match(byDid, /Cascadia MRO/)
    assert.match(byHandle, /Cascadia MRO/)
  })

  test('an organization this observer has never seen is a 404, not an empty profile', async () => {
    const { app } = await accountApp(shopProfile)
    const res = await app.request(`/profile/nobody.${DOMAIN}`)
    assert.equal(res.status, 404)
  })

  /**
   * Browsing needs the index and verification does not, which is the division
   * the whole application is arranged around. An account page is browsing.
   */
  test('without an index the page declines rather than inventing one', async () => {
    const { net } = await demoNetwork(DOMAIN)
    const app = createApp({ resolver: net, repo: net, index: null, mode: 'live' })
    assert.equal((await app.request(`/profile/cascadia-mro.${DOMAIN}`)).status, 503)
  })
})

describe('the two tabs', () => {
  test('the releases tab shows this account and nobody else', async () => {
    const { app } = await accountApp((i) => {
      shopProfile(i)
      i.addRelease(release({ cid: 'mine', description: 'Fuel control unit' }))
      i.addRelease(
        release({
          cid: 'theirs',
          uri: 'at://did:plc:other/dev.cldixon.f8130.release/9z',
          issuerDid: 'did:plc:other',
          description: 'Cabin pressure controller',
        }),
      )
    })
    const body = await (await app.request(`/profile/cascadia-mro.${DOMAIN}`)).text()

    assert.match(body, /Fuel control unit/)
    assert.ok(
      !body.includes('Cabin pressure controller'),
      'another issuer’s release appeared on this account',
    )
  })

  /**
   * The case the tabs exist for. Eight operators, three brokers and two
   * lessors issue nothing by design — they receive parts and check the
   * paperwork — so a releases-only profile is blank for eleven of the
   * twenty-nine organizations here and says, wrongly, that they do nothing.
   */
  test('an account that issues nothing still has something to show', async () => {
    const { app } = await accountApp((i) => {
      shopProfile(i)
      operatorProfile(i)
      i.addRelease(release())
      i.addAttestation(attestation())
    })
    const url = `/profile/example-air.${DOMAIN}`

    const releases = await (await app.request(url)).text()
    assert.match(releases, /Operators, brokers and lessors issue none/)

    const checks = await (await app.request(`${url}?tab=checks`)).text()
    assert.match(checks, /accepted this certificate/)
    // A check quotes the release it covers rather than describing it, so the
    // reader learns what was actually vouched for.
    assert.match(checks, /Fuel control unit/)
  })

  /**
   * A check is a record in the checker's repository about somebody else's
   * record. It belongs to the checker's account, and to nobody else's.
   */
  test('a check appears on its publisher’s account, not the issuer’s', async () => {
    const { app } = await accountApp((i) => {
      shopProfile(i)
      operatorProfile(i)
      i.addRelease(release())
      i.addAttestation(attestation())
    })
    const shopChecks = await (
      await app.request(`/profile/cascadia-mro.${DOMAIN}?tab=checks`)
    ).text()
    assert.match(shopChecks, /has published no checks/)
  })

  test('an unrecognised tab falls back to releases rather than an empty page', async () => {
    const { app } = await accountApp((i) => {
      shopProfile(i)
      i.addRelease(release())
    })
    const body = await (
      await app.request(`/profile/cascadia-mro.${DOMAIN}?tab=nonsense`)
    ).text()
    assert.match(body, /Fuel control unit/)
  })
})

describe('the counts', () => {
  /**
   * The regression this test exists for. Coverage counted attestations, so two
   * operators checking the same certificate made a shop with three releases
   * read "4 of 3" — a number that cannot be true and that overstates coverage,
   * which is the direction that matters when the whole argument is that thin
   * coverage is weak evidence and nothing more.
   */
  test('two checks on one release is one release covered, never two', async () => {
    const { index } = await accountApp((i) => {
      shopProfile(i)
      i.addRelease(release({ cid: 'r1' }))
      i.addAttestation(attestation({ cid: 'a1', subjectCid: 'r1' }))
      i.addAttestation(
        attestation({
          cid: 'a2',
          subjectCid: 'r1',
          uri: 'at://did:plc:second/dev.cldixon.f8130.attestation/2',
          verifierDid: 'did:plc:second',
        }),
      )
    })

    const stats = await index.accountStats(MRO)
    assert.equal(stats.releases, 1)
    assert.equal(stats.attested, 1, 'coverage exceeded the total it is shown against')

    const [issuer] = await index.issuerStats()
    assert.ok(
      issuer!.attested <= issuer!.releases,
      'the issuers table can still report more coverage than releases',
    )
  })

  test('checks published are counted against the account that published them', async () => {
    const { index } = await accountApp((i) => {
      shopProfile(i)
      operatorProfile(i)
      i.addRelease(release())
      i.addAttestation(attestation())
    })

    assert.equal((await index.accountStats(OPERATOR)).checks, 1)
    assert.equal((await index.accountStats(MRO)).checks, 0)
    assert.equal((await index.accountStats(OPERATOR)).releases, 0)
  })
})

describe('getting there', () => {
  /**
   * A feed of documents with no way into the parties behind them is a list.
   * The byline is the way in, and it is the only one most readers will find.
   */
  test('a byline in the feed leads to the account page', async () => {
    const { app } = await accountApp((i) => {
      shopProfile(i)
      i.addRelease(release())
    })
    const body = await (await app.request('/')).text()
    assert.match(body, new RegExp(`href="/profile/cascadia-mro\\.${DOMAIN.replace(/\./g, '\\.')}"`))
  })

  test('the issuers table leads to the account page', async () => {
    const { app } = await accountApp((i) => {
      shopProfile(i)
      i.addRelease(release())
    })
    const body = await (await app.request('/parts')).text()
    assert.match(body, /href="\/profile\/cascadia-mro/)
  })

  /**
   * An organization whose handle this observer never resolved still needs a
   * working link. The index stores the DID in the handle column in that case,
   * so the link is built from the DID and the route accepts it.
   */
  test('an account with no resolved handle is still reachable', async () => {
    const { app } = await accountApp((i) => {
      i.setActor({ did: MRO, displayName: 'Cascadia MRO', kind: 'mro' })
      i.addRelease(release())
    })
    const feed = await (await app.request('/')).text()
    assert.match(feed, new RegExp(`href="/profile/${MRO.replace(/:/g, '%3A')}"`))
    assert.equal((await app.request(`/profile/${MRO}`)).status, 200)
  })
})
