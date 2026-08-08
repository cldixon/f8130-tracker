import type { RawForm } from '@f8130/core'

/**
 * The demonstration cast and the seven scenarios (§6.4).
 *
 * Every organization is fictional, every part number is invented, and no CAGE
 * code here belongs to a real entity. That is not a disclaimer bolted on — it
 * is a hard constraint of the project, because did:plc registrations are
 * permanent and public.
 */

export type OrgKind = 'oem' | 'mro' | 'operator' | 'broker'

export type Org = {
  key: string
  handle: string
  email: string
  kind: OrgKind
  displayName: string
}

export function orgs(domain: string): Org[] {
  return [
    {
      key: 'northwind',
      handle: `northwind-turbine.${domain}`,
      email: `northwind@${domain}`,
      kind: 'oem',
      displayName: 'Northwind Turbine',
    },
    {
      key: 'cascadia',
      handle: `cascadia-mro.${domain}`,
      email: `cascadia@${domain}`,
      kind: 'mro',
      displayName: 'Cascadia MRO',
    },
    {
      key: 'exampleair',
      handle: `example-air.${domain}`,
      email: `exampleair@${domain}`,
      kind: 'operator',
      displayName: 'Example Air',
    },
    {
      key: 'southpoint',
      handle: `southpoint-air.${domain}`,
      email: `southpoint@${domain}`,
      kind: 'operator',
      displayName: 'Southpoint Air',
    },
    {
      key: 'meridian',
      handle: `meridian-aeroparts.${domain}`,
      email: `meridian@${domain}`,
      kind: 'broker',
      displayName: 'Meridian Aeroparts',
    },
  ]
}

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
