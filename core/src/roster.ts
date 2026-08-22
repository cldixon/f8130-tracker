/**
 * The demonstration cast.
 *
 * This lives in core rather than in the seed job because two workspaces need
 * the same list, and it had already drifted once: the web app's "act as"
 * selector carried its own hand-copied five, which would silently have become
 * five of twenty-nine the moment the roster grew. Core already hosts
 * demonstration scaffolding (MemoryNetwork, standardNetwork), so it is the
 * honest home for it.
 *
 * EVERY ORGANIZATION HERE IS FICTIONAL. No name, CAGE code, certificate number
 * or address belongs to a real entity, and none is meant to resemble one. That
 * is a hard constraint rather than a disclaimer: did:plc registrations are
 * permanent and public, so a careless name is a careless name forever.
 *
 * CAGE codes are seven characters (`SYN####`). A real CAGE code is exactly
 * five, so these cannot collide with one no matter how unlucky we get.
 *
 * The first five entries keep the exact handles the original cast was
 * provisioned under. Their did:plc identities already exist and are permanent;
 * renaming them would strand five registrations and orphan every record ever
 * signed by them.
 */

export type OrgKind = 'oem' | 'mro' | 'operator' | 'broker' | 'lessor'

export type Org = {
  key: string
  /** Handle prefix. Combined with the PDS hostname to form the full handle. */
  slug: string
  handle: string
  email: string
  kind: OrgKind
  displayName: string
  cage: string
  /** Repair stations and manufacturers carry one; buyers and lessors do not. */
  certificate?: string
}

type RosterEntry = Omit<Org, 'handle' | 'email'>

const ROSTER: RosterEntry[] = [
  // ------------------------------------------------------------------ OEMs
  {
    key: 'northwind',
    slug: 'northwind-turbine',
    displayName: 'Northwind Turbine',
    kind: 'oem',
    cage: 'SYN0001',
    certificate: 'SYNTHETIC-PC-00081',
  },
  {
    key: 'calder',
    slug: 'calder-aerosystems',
    displayName: 'Calder Aerosystems',
    kind: 'oem',
    cage: 'SYN0002',
    certificate: 'SYNTHETIC-PC-00114',
  },
  {
    key: 'vantage',
    slug: 'vantage-propulsion',
    displayName: 'Vantage Propulsion',
    kind: 'oem',
    cage: 'SYN0003',
    certificate: 'SYNTHETIC-PC-00220',
  },

  // ------------------------------------------------------------------ MROs
  {
    key: 'cascadia',
    slug: 'cascadia-mro',
    displayName: 'Cascadia MRO',
    kind: 'mro',
    cage: 'SYN0004',
    certificate: 'SYNTHETIC-CERT-12345',
  },
  {
    key: 'ironwood',
    slug: 'ironwood-aero',
    displayName: 'Ironwood Aero Services',
    kind: 'mro',
    cage: 'SYN0005',
    certificate: 'SYNTHETIC-CERT-20418',
  },
  {
    key: 'saltmarsh',
    slug: 'saltmarsh-technics',
    displayName: 'Saltmarsh Aviation Technics',
    kind: 'mro',
    cage: 'SYN0006',
    certificate: 'SYNTHETIC-CERT-20955',
  },
  {
    key: 'flinthills',
    slug: 'flinthills-repair',
    displayName: 'Flinthills Component Repair',
    kind: 'mro',
    cage: 'SYN0007',
    certificate: 'SYNTHETIC-CERT-21077',
  },
  {
    key: 'harborpoint',
    slug: 'harbor-point-aero',
    displayName: 'Harbor Point Aerospace',
    kind: 'mro',
    cage: 'SYN0008',
    certificate: 'SYNTHETIC-CERT-21340',
  },
  {
    key: 'graniteridge',
    slug: 'granite-ridge',
    displayName: 'Granite Ridge Overhaul',
    kind: 'mro',
    cage: 'SYN0009',
    certificate: 'SYNTHETIC-CERT-21688',
  },
  {
    key: 'clearwater',
    slug: 'clearwater-turbine',
    displayName: 'Clearwater Turbine Works',
    kind: 'mro',
    cage: 'SYN0010',
    certificate: 'SYNTHETIC-CERT-22015',
  },
  {
    key: 'copperline',
    slug: 'copperline-repair',
    displayName: 'Copperline Aviation Repair',
    kind: 'mro',
    cage: 'SYN0011',
    certificate: 'SYNTHETIC-CERT-22394',
  },
  {
    key: 'sandhills',
    slug: 'sandhills-overhaul',
    displayName: 'Sandhills Accessory Overhaul',
    kind: 'mro',
    cage: 'SYN0012',
    certificate: 'SYNTHETIC-CERT-22701',
  },
  {
    key: 'basalt',
    slug: 'basalt-aero',
    displayName: 'Basalt Aero Repair',
    kind: 'mro',
    cage: 'SYN0013',
    certificate: 'SYNTHETIC-CERT-23044',
  },
  {
    key: 'fjordholm',
    slug: 'fjordholm-aerotek',
    displayName: 'Fjordholm Aerotek',
    kind: 'mro',
    cage: 'SYN0014',
    certificate: 'SYNTHETIC-CERT-23319',
  },
  {
    key: 'alpine',
    slug: 'alpine-rotables',
    displayName: 'Alpine Rotables',
    kind: 'mro',
    cage: 'SYN0015',
    certificate: 'SYNTHETIC-CERT-23570',
  },
  {
    key: 'wexford',
    slug: 'wexford-components',
    displayName: 'Wexford Component Services',
    kind: 'mro',
    cage: 'SYN0016',
    certificate: 'SYNTHETIC-CERT-23902',
  },

  // ------------------------------------------------------------- operators
  {
    key: 'exampleair',
    slug: 'example-air',
    displayName: 'Example Air',
    kind: 'operator',
    cage: 'SYN0017',
  },
  {
    key: 'southpoint',
    slug: 'southpoint-air',
    displayName: 'Southpoint Air',
    kind: 'operator',
    cage: 'SYN0018',
  },
  {
    key: 'marisol',
    slug: 'marisol-airways',
    displayName: 'Marisol Airways',
    kind: 'operator',
    cage: 'SYN0019',
  },
  {
    key: 'highline',
    slug: 'highline-regional',
    displayName: 'Highline Regional',
    kind: 'operator',
    cage: 'SYN0020',
  },
  {
    key: 'cobaltcoast',
    slug: 'cobalt-coast',
    displayName: 'Cobalt Coast Airlines',
    kind: 'operator',
    cage: 'SYN0021',
  },
  {
    key: 'redcliff',
    slug: 'redcliff-cargo',
    displayName: 'Redcliff Cargo',
    kind: 'operator',
    cage: 'SYN0022',
  },
  {
    key: 'pinewood',
    slug: 'pinewood-charter',
    displayName: 'Pinewood Air Charter',
    kind: 'operator',
    cage: 'SYN0023',
  },
  {
    key: 'kenai',
    slug: 'kenai-freight',
    displayName: 'Kenai Freight Systems',
    kind: 'operator',
    cage: 'SYN0024',
  },

  // --------------------------------------------------------------- brokers
  {
    key: 'meridian',
    slug: 'meridian-aeroparts',
    displayName: 'Meridian Aeroparts',
    kind: 'broker',
    cage: 'SYN0025',
  },
  {
    key: 'fairlead',
    slug: 'fairlead-exchange',
    displayName: 'Fairlead Parts Exchange',
    kind: 'broker',
    cage: 'SYN0026',
  },
  {
    key: 'rioseco',
    slug: 'rio-seco-rotables',
    displayName: 'Rio Seco Rotable Exchange',
    kind: 'broker',
    cage: 'SYN0027',
  },

  // --------------------------------------------------------------- lessors
  {
    key: 'halyard',
    slug: 'halyard-leasing',
    displayName: 'Halyard Aircraft Leasing',
    kind: 'lessor',
    cage: 'SYN0028',
  },
  {
    key: 'windward',
    slug: 'windward-leasing',
    displayName: 'Windward Asset Leasing',
    kind: 'lessor',
    cage: 'SYN0029',
  },
]

/**
 * The cast, with handles and e-mail addresses resolved against a PDS hostname.
 *
 * Handles are subdomains of the PDS, which works because the deployment has a
 * wildcard DNS record — adding an organization needs no DNS change.
 */
export function orgs(domain: string): Org[] {
  return ROSTER.map((entry) => ({
    key: entry.key,
    slug: entry.slug,
    handle: `${entry.slug}.${domain}`,
    email: `${entry.key}@${domain}`,
    kind: entry.kind,
    displayName: entry.displayName,
    cage: entry.cage,
    ...(entry.certificate ? { certificate: entry.certificate } : {}),
  }))
}

/** Organizations of one kind, in roster order. */
export function orgsOfKind(all: Org[], kind: OrgKind): Org[] {
  return all.filter((o) => o.kind === kind)
}

export const SYNTHETIC_ORG_MARKER =
  'SYNTHETIC DEMONSTRATION DATA — fictional organization, not a real company'
