import { buildForm, type RawForm } from '@f8130/core'

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

export { orgs, orgsOfKind, buildForm, syntheticForm, SYNTHETIC_ORG_MARKER } from '@f8130/core'
export type { Org, OrgKind } from '@f8130/core'

/** Scenario 1a — the part is manufactured. */
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
  remarks: 'Production acceptance test complete. New manufacture; no findings.',
  certifyingBlock: 'CONFORMITY',
  approvalBasis: 'APPROVED_DESIGN_DATA',
  signerCert: 'SYNTHETIC-CERT-00081',
  signerName: 'R. Inspector',
  completedAt: '2019-03-11T14:02:00Z',
}

/** Scenario 1b — seven years later it comes in for overhaul. */
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
  remarks: 'Metering valve wear beyond limits. Full overhaul per CMM 73-21-05. Returned to service.',
  certifyingBlock: 'RETURN_TO_SERVICE',
  approvalBasis: 'PART_43_RETURN_TO_SERVICE',
  signerCert: 'SYNTHETIC-CERT-12345',
  signerName: 'A. Technician',
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
  approvingAuthority: 'FAA/United States',
  formNumber: 'SYNTHETIC-8130-0004',
  organizationName: 'Cascadia MRO',
  organizationAddress: '4400 Airport Way, Everett, WA 98204',
  workOrder: 'WO/2026/0077',
  item: 1,
  description: 'Hydraulic actuator',
  partNumber: 'NT-9004-11',
  quantity: 1,
  serialNumber: 'SN-551200',
  status: 'REPAIRED',
  remarks: 'Seal degradation. Seal replacement per CMM 29-11-08. Prior history not supplied by seller.',
  certifyingBlock: 'RETURN_TO_SERVICE',
  approvalBasis: 'PART_43_RETURN_TO_SERVICE',
  signerCert: 'SYNTHETIC-CERT-12345',
  signerName: 'A. Technician',
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
    approvingAuthority: 'FAA/United States',
    formNumber: 'SYNTHETIC-8130-0101',
    organizationName: 'Meridian Aeroparts',
    organizationAddress: '90 Cargo Road, Miami, FL 33122',
    workOrder: 'WO/2026/1001',
    item: 1,
    description: 'Bleed air valve',
    partNumber: 'NT-7702-09',
    quantity: 1,
    serialNumber: 'SN-330011',
    status: 'OVERHAULED',
    remarks: 'Overhauled to serviceable condition.',
    certifyingBlock: 'RETURN_TO_SERVICE',
    approvalBasis: 'PART_43_RETURN_TO_SERVICE',
    signerCert: 'SYNTHETIC-CERT-90001',
    signerName: 'M. Broker',
    completedAt: '2026-03-02T08:00:00Z',
  },
  {
    approvingAuthority: 'FAA/United States',
    formNumber: 'SYNTHETIC-8130-0102',
    organizationName: 'Meridian Aeroparts',
    organizationAddress: '90 Cargo Road, Miami, FL 33122',
    workOrder: 'WO/2026/1002',
    item: 1,
    description: 'Bleed air valve',
    partNumber: 'NT-7702-09',
    quantity: 1,
    serialNumber: 'SN-330012',
    status: 'OVERHAULED',
    remarks: 'Overhauled to serviceable condition.',
    certifyingBlock: 'RETURN_TO_SERVICE',
    approvalBasis: 'PART_43_RETURN_TO_SERVICE',
    signerCert: 'SYNTHETIC-CERT-90001',
    signerName: 'M. Broker',
    completedAt: '2026-03-05T08:00:00Z',
  },
  {
    approvingAuthority: 'FAA/United States',
    formNumber: 'SYNTHETIC-8130-0103',
    organizationName: 'Meridian Aeroparts',
    organizationAddress: '90 Cargo Road, Miami, FL 33122',
    workOrder: 'WO/2026/1003',
    item: 1,
    description: 'Bleed air valve',
    partNumber: 'NT-7702-09',
    quantity: 1,
    serialNumber: 'SN-330013',
    status: 'OVERHAULED',
    remarks: 'Overhauled to serviceable condition.',
    certifyingBlock: 'RETURN_TO_SERVICE',
    approvalBasis: 'PART_43_RETURN_TO_SERVICE',
    signerCert: 'SYNTHETIC-CERT-90001',
    signerName: 'M. Broker',
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
  /** Block 12. Findings, workscope and anything else the shop wrote down. */
  remarks: string
  /**
   * Block 13a/14a override.
   *
   * Left absent, the basis is derived from the status: new manufacture is
   * certified for conformity against approved design data, everything else is
   * approved for return to service under part 43. Set this only for the
   * unusual case.
   */
  approvalBasis?:
    | 'APPROVED_DESIGN_DATA'
    | 'NON_APPROVED_DESIGN_DATA'
    | 'PART_43_RETURN_TO_SERVICE'
    | 'OTHER_REGULATION'
}

export type PartLineage = {
  partNumber: string
  serialNumber: string
  description: string
  /** Oldest first. Each visit links the one before it via `prev`. */
  visits: Visit[]
}

/**
 * Adapts a scenario visit onto the shared form builder.
 *
 * The builder lives in core because the app's issue page needs the same one.
 * What stays here is the scenario vocabulary — an issuer and a customer named
 * by roster key — which is about authoring the demonstration, not about the
 * form.
 *
 * The receiving operator is NOT a field. Version 1 committed to a `customer`,
 * which is not a block on an 8130-3 — the form says who issued it, not who it
 * was issued to. Who received the part is expressed the way the protocol
 * expresses it: by that operator publishing an acceptance from its own repo.
 */
export function visitForm(params: {
  lineage: PartLineage
  visit: Visit
  index: number
  formSeq: number
  organizationName: string
  organizationAddress: string
  signerCert: string
  signerName: string
}): RawForm {
  const { lineage, visit } = params
  return buildForm({
    formSeq: params.formSeq,
    partNumber: lineage.partNumber,
    serialNumber: lineage.serialNumber,
    description: lineage.description,
    status: visit.status,
    remarks: visit.remarks,
    completedAt: visit.completedAt,
    organizationName: params.organizationName,
    organizationAddress: params.organizationAddress,
    signerCert: params.signerCert,
    signerName: params.signerName,
    ...(visit.approvalBasis ? { approvalBasis: visit.approvalBasis } : {}),
  })
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
      remarks: 'None; new manufacture. Production acceptance test. Delivered with engine build.',
    },
    {
      issuer: 'ironwood',
      customer: 'exampleair',
      remarks: 'Case porosity at mounting flange. Flange repair per CMM 29-11-42.',
      status: 'REPAIRED',
      completedAt: '2012-09-04T10:45:00Z',
      receivedAt: '2012-09-19T09:15:00Z',
      outcome: 'accepted',
    },
    {
      issuer: 'cascadia',
      customer: 'exampleair',
      remarks: 'Bearing wear at limits; shaft seal weeping. Full overhaul per CMM 29-11-40.',
      status: 'OVERHAULED',
      completedAt: '2015-02-27T15:10:00Z',
      receivedAt: '2015-03-14T11:30:00Z',
      outcome: 'accepted',
    },
    {
      issuer: 'harborpoint',
      customer: 'southpoint',
      status: 'INSPECTED',
      completedAt: '2017-11-13T09:05:00Z',
      receivedAt: '2017-11-28T14:20:00Z',
      outcome: 'accepted',
      remarks: 'No defects noted. Receiving inspection on asset transfer. Inspected on change of ownership.',
    },
    {
      issuer: 'alpine',
      customer: 'southpoint',
      remarks: 'Gear scoring; pressure decay beyond limits. Full overhaul per CMM 29-11-40 rev 6.',
      status: 'OVERHAULED',
      completedAt: '2020-05-29T12:00:00Z',
      receivedAt: '2020-06-18T10:00:00Z',
      outcome: 'accepted',
    },
    {
      issuer: 'fjordholm',
      customer: 'halyard',
      status: 'MODIFIED',
      completedAt: '2023-08-07T08:40:00Z',
      receivedAt: '2023-08-29T13:05:00Z',
      outcome: 'accepted',
      remarks: 'Pre-modification condition serviceable. Service bulletin embodiment SB-29-0114. Modification standard raised to -02B.',
    },
    {
      issuer: 'cascadia',
      customer: 'marisol',
      status: 'OVERHAULED',
      completedAt: '2026-04-16T11:25:00Z',
      receivedAt: '2026-05-04T09:45:00Z',
      outcome: 'accepted',
      remarks: 'Bearing wear; impeller erosion. Full overhaul per CMM 29-11-40 rev 8. Returned to service.',
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
      remarks: 'Outflow valve drive wear. Full overhaul per CMM 21-31-16. History prior to 2022 not supplied.',
    },
    {
      issuer: 'clearwater',
      customer: 'redcliff',
      remarks: 'Pressure transducer drift. Transducer replacement per CMM 21-31-16.',
      status: 'REPAIRED',
      completedAt: '2026-05-20T10:15:00Z',
      receivedAt: '2026-06-08T15:40:00Z',
      outcome: 'discrepancy',
      note: 'Part serviceable and paperwork verifies, but the chain stops at a station we cannot locate.',
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
        remarks: 'Turbine wheel erosion. Full overhaul per CMM 21-52-08.',
        status: 'OVERHAULED',
        completedAt: '2026-05-04T09:00:00Z',
        receivedAt: '2026-05-19T13:00:00Z',
        outcome: 'accepted',
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
        remarks: 'Brush wear beyond limits. Brush and bearing replacement per CMM 24-31-11.',
        status: 'REPAIRED',
        completedAt: '2026-05-11T16:20:00Z',
        receivedAt: '2026-05-27T08:30:00Z',
        outcome: 'accepted',
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
        remarks: 'Servo valve contamination. Full overhaul per CMM 73-21-11.',
        status: 'OVERHAULED',
        completedAt: '2026-05-22T11:40:00Z',
        receivedAt: '2026-06-09T10:00:00Z',
        outcome: 'accepted',
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
        remarks: 'Clutch pack wear; oil contamination. Full overhaul per CMM 24-11-27.',
        status: 'OVERHAULED',
        completedAt: '2026-06-01T08:15:00Z',
        receivedAt: '2026-06-22T12:20:00Z',
        outcome: 'accepted',
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
        remarks: 'No defects noted. Bench functional check per CMM 30-11-04.',
        status: 'INSPECTED',
        completedAt: '2026-06-05T13:50:00Z',
        receivedAt: '2026-06-20T09:10:00Z',
        outcome: 'accepted',
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
        remarks: 'Core fin damage, localized. Core repair per CMM 79-21-05.',
        status: 'REPAIRED',
        completedAt: '2026-06-12T10:05:00Z',
        receivedAt: '2026-07-01T14:45:00Z',
        outcome: 'discrepancy',
        note: 'Paperwork verifies; core shows impact damage not noted on the release.',
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
        remarks: 'Overhauled to serviceable condition. Overhaul.',
        status: 'OVERHAULED',
        completedAt: '2026-06-18T09:30:00Z',
        receivedAt: '2026-07-06T11:15:00Z',
        outcome: 'rejected',
        note: 'Release references a shop visit the issuer will not identify.',
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
        remarks: 'Bearing wear; seal leakage. Full overhaul per CMM 21-52-08.',
        status: 'OVERHAULED',
        completedAt: '2026-06-24T15:00:00Z',
        receivedAt: '2026-07-11T10:30:00Z',
        outcome: 'accepted',
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
        remarks: 'Field winding insulation breakdown. Rewind per CMM 24-31-11. In transit at time of writing.',
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
        remarks: 'Butterfly shaft wear. Full overhaul per CMM 30-11-04.',
        status: 'OVERHAULED',
        completedAt: '2022-04-19T09:20:00Z',
        receivedAt: '2022-05-06T13:40:00Z',
        outcome: 'accepted',
      },
      {
        issuer: 'copperline',
        customer: 'pinewood',
        remarks: 'No defects noted. Bench functional check per CMM 30-11-04.',
        status: 'INSPECTED',
        completedAt: '2026-07-09T14:10:00Z',
        receivedAt: '2026-07-24T09:55:00Z',
        outcome: 'accepted',
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
        remarks: 'Overhauled to serviceable condition. Overhaul.',
        status: 'OVERHAULED',
        completedAt: '2026-07-15T10:50:00Z',
        receivedAt: '2026-08-03T16:05:00Z',
        outcome: 'accepted',
      },
    ],
  },
]
