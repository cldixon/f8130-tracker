import type { RawForm } from '@f8130/core'

/**
 * The demonstration scenarios.
 *
 * Every organization is fictional, every part number is invented, and no CAGE
 * code or certificate number here belongs to a real entity. That is not a
 * disclaimer bolted on — it is a hard constraint of the project, because
 * did:plc registrations are permanent and public.
 *
 * The cast itself lives in orgs.ts.
 */

export { orgs, orgsOfKind, SYNTHETIC_ORG_MARKER } from '@f8130/core'
export type { Org, OrgKind } from '@f8130/core'

/** Scenario 1a — the part is manufactured. */
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

/** Scenario 1b — seven years later it comes in for overhaul. */
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

/**
 * Scenario 4 — an orphan.
 *
 * A genuine, correctly signed release whose predecessor was never published.
 * Nothing about this document is forged; its history simply does not reach
 * birth, which is precisely the thing a buyer cannot otherwise discover.
 */
export const orphanForm: RawForm = {
  formNumber: 'SYNTHETIC-8130-0004',
  partNumber: 'NT-9004-11',
  serialNumber: 'SN-551200',
  description: 'Hydraulic actuator',
  status: 'REPAIRED',
  quantity: 1,
  workOrder: 'WO/2026/0077',
  findings: 'Seal degradation',
  workscope: 'Seal replacement per CMM 29-11-08',
  costCents: 310_000,
  customer: 'Southpoint Air',
  signerCert: 'SYNTHETIC-CERT-12345',
  signerName: 'A. Technician',
  remarks: 'Prior history not supplied by seller',
  completedAt: '2026-02-14T11:05:00Z',
}

/**
 * Scenario 5 — the broker's three releases.
 *
 * Each is cryptographically impeccable: really signed, really published, and
 * it verifies cleanly. What is wrong with them is not visible in any single
 * document, only in the pattern of independent operators refusing them.
 */
export const brokerForms: RawForm[] = [
  {
    formNumber: 'SYNTHETIC-8130-0101',
    partNumber: 'NT-7702-09',
    serialNumber: 'SN-330011',
    description: 'Bleed air valve',
    status: 'OVERHAULED',
    quantity: 1,
    workOrder: 'WO/2026/1001',
    findings: 'Overhauled to serviceable condition',
    workscope: 'Overhaul',
    costCents: 890_000,
    customer: 'Example Air',
    signerCert: 'SYNTHETIC-CERT-90001',
    signerName: 'M. Broker',
    remarks: '',
    completedAt: '2026-03-02T08:00:00Z',
  },
  {
    formNumber: 'SYNTHETIC-8130-0102',
    partNumber: 'NT-7702-09',
    serialNumber: 'SN-330012',
    description: 'Bleed air valve',
    status: 'OVERHAULED',
    quantity: 1,
    workOrder: 'WO/2026/1002',
    findings: 'Overhauled to serviceable condition',
    workscope: 'Overhaul',
    costCents: 890_000,
    customer: 'Southpoint Air',
    signerCert: 'SYNTHETIC-CERT-90001',
    signerName: 'M. Broker',
    remarks: '',
    completedAt: '2026-03-05T08:00:00Z',
  },
  {
    formNumber: 'SYNTHETIC-8130-0103',
    partNumber: 'NT-7702-09',
    serialNumber: 'SN-330013',
    description: 'Bleed air valve',
    status: 'OVERHAULED',
    quantity: 1,
    workOrder: 'WO/2026/1003',
    findings: 'Overhauled to serviceable condition',
    workscope: 'Overhaul',
    costCents: 890_000,
    customer: 'Cascadia MRO',
    signerCert: 'SYNTHETIC-CERT-90001',
    signerName: 'M. Broker',
    remarks: '',
    completedAt: '2026-03-09T08:00:00Z',
  },
]

export const rejectionNotes = [
  'Back-to-birth documentation could not be produced on request.',
  'Serial number on the part does not match the accompanying paperwork.',
  'Supplied release references a shop visit we have no record of.',
]

// ---------------------------------------------------------------------------
// Shop-visit specifications
// ---------------------------------------------------------------------------

/**
 * One shop visit, compressed.
 *
 * The 8130-3 has fifteen committed fields and most of them are boilerplate for
 * a given visit. Writing all fifteen out for every record in a seventeen-year
 * chain buries the three that actually vary, and invites the kind of
 * copy-paste error that produces a chain nobody notices is wrong.
 */
export type Visit = {
  /** Roster key of the issuing organization. */
  issuer: string
  /** Roster key of the receiving organization — the customer on the form. */
  customer: string
  status: 'NEW' | 'OVERHAULED' | 'REPAIRED' | 'INSPECTED' | 'MODIFIED'
  completedAt: string
  /** When the customer published its verdict. Omit for no acceptance. */
  receivedAt?: string
  outcome?: 'accepted' | 'rejected' | 'discrepancy'
  note?: string
  costCents: number
  findings: string
  workscope: string
  remarks?: string
}

export type PartLineage = {
  partNumber: string
  serialNumber: string
  description: string
  /** Oldest first. Each visit links the one before it via `prev`. */
  visits: Visit[]
}

/**
 * Builds the full fifteen-field form for one visit.
 *
 * `formNumber` and `workOrder` are derived from the sequence rather than
 * hand-assigned, so they cannot silently collide across scenarios.
 */
export function visitForm(params: {
  lineage: PartLineage
  visit: Visit
  index: number
  formSeq: number
  signerCert: string
  signerName: string
  customerName: string
}): RawForm {
  const { lineage, visit, formSeq } = params
  const year = visit.completedAt.slice(0, 4)
  return {
    formNumber: `SYNTHETIC-8130-${String(formSeq).padStart(4, '0')}`,
    partNumber: lineage.partNumber,
    serialNumber: lineage.serialNumber,
    description: lineage.description,
    status: visit.status,
    quantity: 1,
    workOrder: `WO/${year}/${String(formSeq).padStart(4, '0')}`,
    findings: visit.findings,
    workscope: visit.workscope,
    costCents: visit.costCents,
    customer: params.customerName,
    signerCert: params.signerCert,
    signerName: params.signerName,
    remarks: visit.remarks ?? '',
    completedAt: visit.completedAt,
  }
}

/**
 * The deep chain — seventeen years, seven shop visits, six organizations,
 * four successive owners.
 *
 * This is the buyer's view of a part with nothing to hide. Every link resolves,
 * every signature checks, and the trace reaches manufacture. A prospective
 * buyer holding no bundles and enjoying nobody's cooperation can establish all
 * of that from public records alone — and still learn nothing about what any
 * visit cost or what any shop found.
 *
 * Custody moves three times (Example Air → Southpoint Air → Halyard → Marisol),
 * which is the ordinary life of a rotable and the reason the customer field
 * cannot be inferred from the issuer.
 */
export const deepLineage: PartLineage = {
  partNumber: 'NT-6110-02',
  serialNumber: 'SN-118344',
  description: 'Engine-driven hydraulic pump',
  visits: [
    {
      issuer: 'northwind',
      customer: 'exampleair',
      status: 'NEW',
      completedAt: '2009-06-18T13:20:00Z',
      receivedAt: '2009-07-02T16:00:00Z',
      outcome: 'accepted',
      costCents: 3_890_000,
      findings: 'None; new manufacture',
      workscope: 'Production acceptance test',
      remarks: 'Delivered with engine build',
    },
    {
      issuer: 'ironwood',
      customer: 'exampleair',
      status: 'REPAIRED',
      completedAt: '2012-09-04T10:45:00Z',
      receivedAt: '2012-09-19T09:15:00Z',
      outcome: 'accepted',
      costCents: 842_000,
      findings: 'Case porosity at mounting flange',
      workscope: 'Flange repair per CMM 29-11-42',
    },
    {
      issuer: 'cascadia',
      customer: 'exampleair',
      status: 'OVERHAULED',
      completedAt: '2015-02-27T15:10:00Z',
      receivedAt: '2015-03-14T11:30:00Z',
      outcome: 'accepted',
      costCents: 1_975_000,
      findings: 'Bearing wear at limits; shaft seal weeping',
      workscope: 'Full overhaul per CMM 29-11-40',
    },
    {
      issuer: 'harborpoint',
      customer: 'southpoint',
      status: 'INSPECTED',
      completedAt: '2017-11-13T09:05:00Z',
      receivedAt: '2017-11-28T14:20:00Z',
      outcome: 'accepted',
      costCents: 218_000,
      findings: 'No defects noted',
      workscope: 'Receiving inspection on asset transfer',
      remarks: 'Inspected on change of ownership',
    },
    {
      issuer: 'alpine',
      customer: 'southpoint',
      status: 'OVERHAULED',
      completedAt: '2020-05-29T12:00:00Z',
      receivedAt: '2020-06-18T10:00:00Z',
      outcome: 'accepted',
      costCents: 2_230_000,
      findings: 'Gear scoring; pressure decay beyond limits',
      workscope: 'Full overhaul per CMM 29-11-40 rev 6',
    },
    {
      issuer: 'fjordholm',
      customer: 'halyard',
      status: 'MODIFIED',
      completedAt: '2023-08-07T08:40:00Z',
      receivedAt: '2023-08-29T13:05:00Z',
      outcome: 'accepted',
      costCents: 1_460_000,
      findings: 'Pre-modification condition serviceable',
      workscope: 'Service bulletin embodiment SB-29-0114',
      remarks: 'Modification standard raised to -02B',
    },
    {
      issuer: 'cascadia',
      customer: 'marisol',
      status: 'OVERHAULED',
      completedAt: '2026-04-16T11:25:00Z',
      receivedAt: '2026-05-04T09:45:00Z',
      outcome: 'accepted',
      costCents: 2_145_000,
      findings: 'Bearing wear; impeller erosion',
      workscope: 'Full overhaul per CMM 29-11-40 rev 8',
      remarks: 'Returned to service',
    },
  ],
}

/**
 * The vanished-station chain.
 *
 * Two published visits, and then the trail runs into an issuer whose identity
 * does not resolve at all. This is a different failure from the orphan in
 * scenario 4: there the DID resolves and the record was never published; here
 * there is nothing to ask in the first place, which is what a shop that closed
 * years ago actually looks like.
 *
 * Both are worth having, because a buyer needs to tell them apart. One says
 * "this record is missing"; the other says "the organization that would hold
 * it cannot be found."
 */
export const vanishedLineage: PartLineage = {
  partNumber: 'CA-4420-07',
  serialNumber: 'SN-772019',
  description: 'Cabin pressure controller',
  visits: [
    {
      issuer: 'copperline',
      customer: 'redcliff',
      status: 'OVERHAULED',
      completedAt: '2022-03-11T14:30:00Z',
      receivedAt: '2022-03-25T10:10:00Z',
      outcome: 'accepted',
      costCents: 1_180_000,
      findings: 'Outflow valve drive wear',
      workscope: 'Full overhaul per CMM 21-31-16',
      remarks: 'History prior to 2022 not supplied',
    },
    {
      issuer: 'clearwater',
      customer: 'redcliff',
      status: 'REPAIRED',
      completedAt: '2026-05-20T10:15:00Z',
      receivedAt: '2026-06-08T15:40:00Z',
      outcome: 'discrepancy',
      note: 'Part serviceable and paperwork verifies, but the chain stops at a station we cannot locate.',
      costCents: 430_000,
      findings: 'Pressure transducer drift',
      workscope: 'Transducer replacement per CMM 21-31-16',
    },
  ],
}

/**
 * A syntactically valid did:plc that was never registered.
 *
 * The vanished station's `prev` points here. Twenty-four characters from the
 * did:plc alphabet, so identity resolution is genuinely attempted and
 * genuinely fails — rather than failing early on a malformed identifier, which
 * would exercise a different code path and teach the wrong lesson.
 */
export const VANISHED_STATION_DID = 'did:plc:syntheticvanishedstn2345'

/** The record key the vanished station's release would have had. */
export const VANISHED_STATION_RKEY = '3lqvanishedstn7k'

/**
 * Ordinary traffic.
 *
 * Nine parts moving between shops and operators with nothing remarkable about
 * any of them. Without this the feed is nothing but fraud and broken chains,
 * which misrepresents the domain: the overwhelming majority of real 8130-3
 * traffic is unexceptional, and a demonstration where every record is a
 * scandal teaches the wrong prior.
 *
 * One rejection and one discrepancy are seeded in among them, because a feed
 * where nothing ever goes wrong is equally unrealistic.
 */
export const routineLineages: PartLineage[] = [
  {
    partNumber: 'CA-3315-22',
    serialNumber: 'SN-204118',
    description: 'Air cycle machine',
    visits: [
      {
        issuer: 'saltmarsh',
        customer: 'cobaltcoast',
        status: 'OVERHAULED',
        completedAt: '2026-05-04T09:00:00Z',
        receivedAt: '2026-05-19T13:00:00Z',
        outcome: 'accepted',
        costCents: 1_640_000,
        findings: 'Turbine wheel erosion',
        workscope: 'Full overhaul per CMM 21-52-08',
      },
    ],
  },
  {
    partNumber: 'VP-2208-30',
    serialNumber: 'SN-661042',
    description: 'Starter-generator',
    visits: [
      {
        issuer: 'flinthills',
        customer: 'highline',
        status: 'REPAIRED',
        completedAt: '2026-05-11T16:20:00Z',
        receivedAt: '2026-05-27T08:30:00Z',
        outcome: 'accepted',
        costCents: 612_000,
        findings: 'Brush wear beyond limits',
        workscope: 'Brush and bearing replacement per CMM 24-31-11',
      },
    ],
  },
  {
    partNumber: 'VP-5540-16',
    serialNumber: 'SN-118907',
    description: 'Fuel metering unit',
    visits: [
      {
        issuer: 'graniteridge',
        customer: 'pinewood',
        status: 'OVERHAULED',
        completedAt: '2026-05-22T11:40:00Z',
        receivedAt: '2026-06-09T10:00:00Z',
        outcome: 'accepted',
        costCents: 1_915_000,
        findings: 'Servo valve contamination',
        workscope: 'Full overhaul per CMM 73-21-11',
      },
    ],
  },
  {
    partNumber: 'NT-1180-45',
    serialNumber: 'SN-449021',
    description: 'Constant speed drive',
    visits: [
      {
        issuer: 'sandhills',
        customer: 'kenai',
        status: 'OVERHAULED',
        completedAt: '2026-06-01T08:15:00Z',
        receivedAt: '2026-06-22T12:20:00Z',
        outcome: 'accepted',
        costCents: 2_480_000,
        findings: 'Clutch pack wear; oil contamination',
        workscope: 'Full overhaul per CMM 24-11-27',
      },
    ],
  },
  {
    partNumber: 'CA-7761-08',
    serialNumber: 'SN-330788',
    description: 'Anti-ice valve',
    visits: [
      {
        issuer: 'basalt',
        customer: 'marisol',
        status: 'INSPECTED',
        completedAt: '2026-06-05T13:50:00Z',
        receivedAt: '2026-06-20T09:10:00Z',
        outcome: 'accepted',
        costCents: 186_000,
        findings: 'No defects noted',
        workscope: 'Bench functional check per CMM 30-11-04',
      },
    ],
  },
  {
    partNumber: 'VP-3390-12',
    serialNumber: 'SN-905513',
    description: 'Oil cooler',
    visits: [
      {
        issuer: 'wexford',
        customer: 'cobaltcoast',
        status: 'REPAIRED',
        completedAt: '2026-06-12T10:05:00Z',
        receivedAt: '2026-07-01T14:45:00Z',
        outcome: 'discrepancy',
        note: 'Paperwork verifies; core shows impact damage not noted on the release.',
        costCents: 398_000,
        findings: 'Core fin damage, localized',
        workscope: 'Core repair per CMM 79-21-05',
      },
    ],
  },
  {
    partNumber: 'NT-2245-63',
    serialNumber: 'SN-771230',
    description: 'Nose wheel steering actuator',
    visits: [
      {
        issuer: 'fairlead',
        customer: 'highline',
        status: 'OVERHAULED',
        completedAt: '2026-06-18T09:30:00Z',
        receivedAt: '2026-07-06T11:15:00Z',
        outcome: 'rejected',
        note: 'Release references a shop visit the issuer will not identify.',
        costCents: 1_050_000,
        findings: 'Overhauled to serviceable condition',
        workscope: 'Overhaul',
      },
    ],
  },
  {
    partNumber: 'CA-3315-22',
    serialNumber: 'SN-204902',
    description: 'Air cycle machine',
    visits: [
      {
        issuer: 'ironwood',
        customer: 'redcliff',
        status: 'OVERHAULED',
        completedAt: '2026-06-24T15:00:00Z',
        receivedAt: '2026-07-11T10:30:00Z',
        outcome: 'accepted',
        costCents: 1_702_000,
        findings: 'Bearing wear; seal leakage',
        workscope: 'Full overhaul per CMM 21-52-08',
      },
    ],
  },
  {
    partNumber: 'VP-2208-30',
    serialNumber: 'SN-661180',
    description: 'Starter-generator',
    visits: [
      {
        issuer: 'harborpoint',
        customer: 'southpoint',
        status: 'REPAIRED',
        completedAt: '2026-07-02T12:25:00Z',
        costCents: 587_000,
        findings: 'Field winding insulation breakdown',
        workscope: 'Rewind per CMM 24-31-11',
        remarks: 'In transit at time of writing',
      },
    ],
  },
  {
    // Two visits four years apart. Not every ordinary part is a singleton, and
    // a buyer view where the only multi-visit chains are the two set pieces
    // would flatter itself.
    partNumber: 'CA-7761-08',
    serialNumber: 'SN-331004',
    description: 'Anti-ice valve',
    visits: [
      {
        issuer: 'clearwater',
        customer: 'pinewood',
        status: 'OVERHAULED',
        completedAt: '2022-04-19T09:20:00Z',
        receivedAt: '2022-05-06T13:40:00Z',
        outcome: 'accepted',
        costCents: 744_000,
        findings: 'Butterfly shaft wear',
        workscope: 'Full overhaul per CMM 30-11-04',
      },
      {
        issuer: 'copperline',
        customer: 'pinewood',
        status: 'INSPECTED',
        completedAt: '2026-07-09T14:10:00Z',
        receivedAt: '2026-07-24T09:55:00Z',
        outcome: 'accepted',
        costCents: 164_000,
        findings: 'No defects noted',
        workscope: 'Bench functional check per CMM 30-11-04',
      },
    ],
  },
  {
    partNumber: 'NT-1180-45',
    serialNumber: 'SN-449887',
    description: 'Constant speed drive',
    visits: [
      {
        issuer: 'rioseco',
        customer: 'kenai',
        status: 'OVERHAULED',
        completedAt: '2026-07-15T10:50:00Z',
        receivedAt: '2026-08-03T16:05:00Z',
        outcome: 'accepted',
        costCents: 2_310_000,
        findings: 'Overhauled to serviceable condition',
        workscope: 'Overhaul',
      },
    ],
  },
]
