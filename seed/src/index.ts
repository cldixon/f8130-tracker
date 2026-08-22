/**
 * Seeds the demonstration: provisions the fictional organizations on the PDS
 * and writes the scenarios into their own repositories.
 *
 * Runs as a Railway service rather than from a developer's laptop, and reaches
 * the PDS over private networking. That is not just convenience — it means the
 * demonstration can be rebuilt by anyone with the project, with no credentials
 * on any workstation and no dependence on a particular egress policy.
 *
 * Idempotent. Re-running logs in to accounts that already exist rather than
 * failing, so it is safe to redeploy.
 *
 * EVERY ORGANIZATION AND PART NUMBER HERE IS FICTIONAL. did:plc registrations
 * are permanent and public, which makes that a hard constraint rather than a
 * matter of taste.
 */

import { AtpAgent } from '@atproto/api'
import {
  buildBundle,
  commitForm,
  commitmentFromBundle,
  toHex,
  type Bundle,
  type RawForm,
} from '@f8130/core'

import {
  birthForm,
  brokerForms,
  deepLineage,
  orphanForm,
  orgs,
  overhaulForm,
  rejectionNotes,
  routineLineages,
  vanishedLineage,
  visitForm,
  SYNTHETIC_ORG_MARKER,
  VANISHED_STATION_DID,
  VANISHED_STATION_RKEY,
  type Org,
  type PartLineage,
} from './scenarios.js'

const RELEASE = 'dev.cldixon.f8130.release'
const ACCEPTANCE = 'dev.cldixon.f8130.acceptance'
const STATION = 'dev.cldixon.f8130.station'

const PDS_URL = process.env.PDS_INTERNAL_URL ?? 'http://pds.railway.internal:3000'
const PDS_HOSTNAME = process.env.PDS_HOSTNAME ?? 'f8130.cldixon.dev'
const ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD ?? ''
const ACCOUNT_PASSWORD = process.env.SEED_ACCOUNT_PASSWORD ?? 'synthetic-demo-password'

/** Delete this org's existing f8130 records before writing, then write. */
const RESET = process.env.SEED_RESET === '1'
/** Write again even though records already exist. Produces duplicates. */
const FORCE = process.env.SEED_FORCE === '1'

type Session = { org: Org; agent: AtpAgent; did: string }

type StrongRef = { uri: string; cid: string }

async function waitForPds(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const res = await fetch(`${PDS_URL}/xrpc/_health`)
      if (res.ok) {
        console.log(`PDS reachable at ${PDS_URL}`)
        return
      }
    } catch {
      // not up yet
    }
    console.log(`waiting for PDS (${attempt}/30)…`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`PDS never became reachable at ${PDS_URL}`)
}

function adminHeaders(): Record<string, string> {
  const token = Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')
  return { authorization: `Basic ${token}`, 'content-type': 'application/json' }
}

async function createInviteCode(): Promise<string> {
  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createInviteCode`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ useCount: 1 }),
  })
  if (!res.ok) {
    throw new Error(`createInviteCode failed: ${res.status} ${await res.text()}`)
  }
  return ((await res.json()) as { code: string }).code
}

/**
 * Creates an account, or logs in if it already exists.
 *
 * The distinction matters for re-runs: an already-provisioned demo should be
 * refreshable without tearing down identities, because every did:plc created
 * here is permanent.
 */
async function provision(org: Org): Promise<Session> {
  const agent = new AtpAgent({ service: PDS_URL })

  try {
    await agent.login({ identifier: org.handle, password: ACCOUNT_PASSWORD })
    console.log(`  ${org.handle} — already exists, logged in (${agent.session!.did})`)
    return { org, agent, did: agent.session!.did }
  } catch {
    // fall through to creation
  }

  const inviteCode = await createInviteCode()
  await agent.createAccount({
    email: org.email,
    handle: org.handle,
    password: ACCOUNT_PASSWORD,
    inviteCode,
  })
  console.log(`  ${org.handle} — created (${agent.session!.did})`)
  return { org, agent, did: agent.session!.did }
}

/**
 * Whether this organization has already been seeded.
 *
 * Account creation was idempotent from the start, but record writing was not,
 * and the seed service redeploys on every push to the branch — so an unrelated
 * commit quietly wrote a second complete set of parts. Existence of prior
 * records is the only reliable signal, since records are keyed by TID and a
 * fresh run cannot recognise its own earlier output.
 */
async function alreadySeeded(session: Session): Promise<boolean> {
  const res = await session.agent.com.atproto.repo.listRecords({
    repo: session.did,
    collection: RELEASE,
    limit: 1,
  })
  return res.data.records.length > 0
}

/** Removes every f8130 record from an organization's repository. */
async function clearRecords(session: Session): Promise<number> {
  let removed = 0
  for (const collection of [RELEASE, ACCEPTANCE, STATION]) {
    for (;;) {
      const res = await session.agent.com.atproto.repo.listRecords({
        repo: session.did,
        collection,
        limit: 100,
      })
      if (res.data.records.length === 0) break
      for (const rec of res.data.records) {
        const rkey = rec.uri.split('/').pop()!
        await session.agent.com.atproto.repo.deleteRecord({
          repo: session.did,
          collection,
          rkey,
        })
        removed++
      }
      if (res.data.records.length < 100) break
    }
  }
  return removed
}

/** Publishes a release commitment and returns its reference plus the bundle. */
async function issueRelease(
  session: Session,
  form: RawForm,
  prev?: StrongRef,
): Promise<{ ref: StrongRef; bundle: Bundle }> {
  const commitment = commitForm(form)

  const record: Record<string, unknown> = {
    $type: RELEASE,
    commitment: commitment.root,
    fieldSetVersion: commitment.version,
    issuerDid: session.did,
    formNumber: commitment.values.formNumber,
    partNumber: commitment.values.partNumber,
    serialNumber: commitment.values.serialNumber,
    status: commitment.values.status,
    signerCert: commitment.values.signerCert,
    completedAt: commitment.values.completedAt,
  }
  if (prev) record.prev = prev

  const res = await session.agent.com.atproto.repo.createRecord({
    repo: session.did,
    collection: RELEASE,
    record,
  })

  const bundle = buildBundle({
    uri: res.data.uri,
    issuerHandle: session.org.handle,
    commitment,
  })

  console.log(
    `    ${commitment.values.partNumber}/${commitment.values.serialNumber} ` +
      `${commitment.values.status} → ${res.data.uri}`,
  )

  return { ref: { uri: res.data.uri, cid: res.data.cid }, bundle }
}

async function issueAcceptance(
  session: Session,
  params: {
    subject: StrongRef
    issuerDid: string
    partNumber: string
    serialNumber: string
    outcome: 'accepted' | 'rejected' | 'discrepancy'
    note?: string
    receivedAt: string
  },
): Promise<void> {
  await session.agent.com.atproto.repo.createRecord({
    repo: session.did,
    collection: ACCEPTANCE,
    record: {
      $type: ACCEPTANCE,
      subject: params.subject,
      issuerDid: params.issuerDid,
      verifierDid: session.did,
      partNumber: params.partNumber,
      serialNumber: params.serialNumber,
      outcome: params.outcome,
      ...(params.note ? { note: params.note } : {}),
      receivedAt: params.receivedAt,
    },
  })
  console.log(
    `    ${session.org.displayName} ${params.outcome} ${params.partNumber}/${params.serialNumber}`,
  )
}

/**
 * Publishes the organization's self-description.
 *
 * Role and display name are not part of the committed 8130 field set and never
 * will be — what a shop calls itself is not a property of the work it
 * certified. They live here, in the organization's own repo, so an AppView
 * learns the cast by reading the network rather than by shipping a table it
 * hardcoded.
 *
 * Keyed `self`, so re-running replaces rather than accumulates.
 */
async function writeStation(session: Session): Promise<void> {
  const { org } = session
  await session.agent.com.atproto.repo.putRecord({
    repo: session.did,
    collection: STATION,
    rkey: 'self',
    record: {
      $type: STATION,
      displayName: org.displayName,
      kind: org.kind,
      synthetic: SYNTHETIC_ORG_MARKER,
      cage: org.cage,
      ...(org.certificate ? { certificate: org.certificate } : {}),
    },
  })
}

/**
 * A signer for a given shop visit.
 *
 * Deterministic in the form sequence so a re-seed produces the same names, and
 * varied enough that every certificate in the demo is not signed by the same
 * person. Falls back to a generic certificate for organizations that hold none
 * — brokers issue releases in this demonstration, which is itself part of the
 * story scenario 5 tells.
 */
function signerFor(org: Org, formSeq: number): { cert: string; name: string } {
  const names = [
    'A. Technician',
    'R. Inspector',
    'J. Mercado',
    'K. Osei',
    'L. Fontaine',
    'D. Whitfield',
    'S. Nakamura',
    'P. Halloran',
  ]
  return {
    cert: org.certificate ?? `SYNTHETIC-CERT-9${String(formSeq).padStart(4, '0')}`,
    name: names[formSeq % names.length]!,
  }
}

/**
 * Publishes one part's whole life, oldest visit first.
 *
 * Each release links its predecessor, and each visit's customer publishes its
 * own verdict from its own repository — which is what makes the verdict
 * unsuppressable and, unavoidably, what makes the receiving operator identify
 * itself. Anonymity ends at the moment of acceptance, by design: a verdict
 * nobody can attribute is a verdict nobody can weigh.
 *
 * `startRef` seeds the chain with a predecessor that this run did not publish,
 * which is how the vanished-station case is built.
 */
async function publishLineage(params: {
  lineage: PartLineage
  sessions: Record<string, Session>
  formSeqStart: number
  startRef?: StrongRef
}): Promise<{ refs: StrongRef[]; bundles: Bundle[] }> {
  const { lineage, sessions } = params
  const refs: StrongRef[] = []
  const bundles: Bundle[] = []
  let prev: StrongRef | undefined = params.startRef

  for (let i = 0; i < lineage.visits.length; i++) {
    const visit = lineage.visits[i]!
    const issuer = sessions[visit.issuer]
    const customer = sessions[visit.customer]
    if (!issuer) throw new Error(`unknown issuer key ${visit.issuer}`)
    if (!customer) throw new Error(`unknown customer key ${visit.customer}`)

    const formSeq = params.formSeqStart + i
    const signer = signerFor(issuer.org, formSeq)
    const form = visitForm({
      lineage,
      visit,
      index: i,
      formSeq,
      signerCert: signer.cert,
      signerName: signer.name,
      customerName: customer.org.displayName,
    })

    const issued = await issueRelease(issuer, form, prev)
    refs.push(issued.ref)
    bundles.push(issued.bundle)
    prev = issued.ref

    if (visit.receivedAt) {
      await issueAcceptance(customer, {
        subject: issued.ref,
        issuerDid: issuer.did,
        partNumber: String(issued.bundle.values.partNumber),
        serialNumber: String(issued.bundle.values.serialNumber),
        outcome: visit.outcome ?? 'accepted',
        ...(visit.note ? { note: visit.note } : {}),
        receivedAt: visit.receivedAt,
      })
    }
  }

  return { refs, bundles }
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('PDS_ADMIN_PASSWORD is required')

  console.log('=== f8130 seed — SYNTHETIC DEMONSTRATION DATA ===\n')
  await waitForPds()

  console.log('\nProvisioning organizations:')
  const cast = orgs(PDS_HOSTNAME)
  const sessions: Record<string, Session> = {}
  for (const org of cast) {
    sessions[org.key] = await provision(org)
  }

  if (RESET) {
    console.log('\nSEED_RESET — clearing existing records:')
    for (const org of cast) {
      const n = await clearRecords(sessions[org.key]!)
      console.log(`  ${org.handle} — removed ${n} record(s)`)
    }
  } else if (!FORCE) {
    const seeded: string[] = []
    for (const org of cast) {
      if (await alreadySeeded(sessions[org.key]!)) seeded.push(org.handle)
    }
    if (seeded.length > 0) {
      console.log(
        `\nAlready seeded (${seeded.length} org(s) hold records). Doing nothing.\n` +
          'Set SEED_RESET=1 to clear and rewrite, or SEED_FORCE=1 to add another set.',
      )
      return
    }
  }

  console.log('\nPublishing station profiles:')
  for (const org of cast) {
    await writeStation(sessions[org.key]!)
  }
  console.log(`  ${cast.length} profiles written`)

  const northwind = sessions.northwind!
  const cascadia = sessions.cascadia!
  const exampleair = sessions.exampleair!
  const southpoint = sessions.southpoint!
  const meridian = sessions.meridian!

  const bundles: Record<string, unknown> = {}

  // ---------------------------------------------- 1. birth → overhaul → accept
  console.log('\nScenario 1 — a part with a complete history:')
  const birth = await issueRelease(northwind, birthForm)
  const overhaul = await issueRelease(cascadia, overhaulForm, birth.ref)
  await issueAcceptance(exampleair, {
    subject: overhaul.ref,
    issuerDid: cascadia.did,
    partNumber: 'NT882104',
    serialNumber: 'SN000417',
    outcome: 'accepted',
    receivedAt: '2026-01-29T15:00:00Z',
  })
  bundles.genuine = overhaul.bundle
  bundles.birth = birth.bundle

  // --------------------------------------------------------- 2 & 3. fixtures
  //
  // Derived from the genuine bundle rather than published: a tampered document
  // is by definition one that was never issued in that form, and a forged one
  // names a record that does not exist.
  console.log('\nScenarios 2 and 3 — tampered and forged fixtures (not published)')
  bundles.tampered = {
    ...overhaul.bundle,
    values: { ...overhaul.bundle.values, findings: 'No defects found' },
  }
  bundles.forged = {
    ...overhaul.bundle,
    uri: `at://${cascadia.did}/${RELEASE}/3mzzzzzzzzz2z`,
  }

  // ----------------------------------------------------------- 4. broken chain
  console.log('\nScenario 4 — a genuine release whose history stops short:')
  const orphan = await issueRelease(cascadia, orphanForm, {
    // Points at a record that was never published. Well-formed, and unresolvable.
    uri: `at://${northwind.did}/${RELEASE}/3mnevrpublishd`,
    cid: birth.ref.cid,
  })
  bundles.orphan = orphan.bundle

  // ------------------------------------------------- 5. the accumulating signal
  console.log('\nScenario 5 — three independent operators reject the same broker:')
  const rejectors = [exampleair, southpoint, cascadia]
  for (let i = 0; i < brokerForms.length; i++) {
    const issued = await issueRelease(meridian, brokerForms[i]!)
    await issueAcceptance(rejectors[i]!, {
      subject: issued.ref,
      issuerDid: meridian.did,
      partNumber: String(issued.bundle.values.partNumber),
      serialNumber: String(issued.bundle.values.serialNumber),
      outcome: 'rejected',
      note: rejectionNotes[i],
      receivedAt: `2026-03-1${i + 2}T10:00:00Z`,
    })
  }

  // ------------------------------------------------- 6. the deep, clean chain
  console.log('\nScenario 6 — seventeen years, seven visits, six organizations:')
  const deep = await publishLineage({
    lineage: deepLineage,
    sessions,
    formSeqStart: 200,
  })
  bundles.deepLatest = deep.bundles[deep.bundles.length - 1]
  bundles.deepBirth = deep.bundles[0]

  // ------------------------------------------------ 7. the vanished station
  //
  // The oldest published visit points at an issuer that never existed, so the
  // trace fails at identity resolution rather than at record retrieval. That
  // distinction is the whole point of seeding both this and scenario 4.
  console.log('\nScenario 7 — a chain that runs into a station nobody can find:')
  const vanished = await publishLineage({
    lineage: vanishedLineage,
    sessions,
    formSeqStart: 300,
    startRef: {
      uri: `at://${VANISHED_STATION_DID}/${RELEASE}/${VANISHED_STATION_RKEY}`,
      cid: birth.ref.cid,
    },
  })
  bundles.vanished = vanished.bundles[vanished.bundles.length - 1]

  // ------------------------------------------------------ 8. ordinary traffic
  console.log('\nScenario 8 — unremarkable parts moving between unremarkable shops:')
  let routineSeq = 400
  for (const lineage of routineLineages) {
    await publishLineage({ lineage, sessions, formSeqStart: routineSeq })
    routineSeq += lineage.visits.length
  }

  // ------------------------------------------------------------------ output
  //
  // Printed so the bundles can be captured into the repository as fixtures.
  // This is the issuer side of the exchange — a station legitimately holds the
  // documents it wrote. No AppView ever stores these.
  console.log('\n=== BUNDLES BEGIN ===')
  console.log(JSON.stringify(bundles, null, 2))
  console.log('=== BUNDLES END ===')

  console.log('\nSanity check:')
  const root = toHex(commitmentFromBundle(overhaul.bundle).root)
  console.log(`  genuine bundle reopens commitment ${root.slice(0, 16)}…`)
  console.log('\nSeed complete.')
}

main().catch((err) => {
  console.error('seed failed:', err)
  process.exit(1)
})
