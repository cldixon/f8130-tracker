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
  /**
   * Block 4 of FAA Form 8130-3, the organization's physical address.
   *
   * This is form content, not map data. Block 4 is a required block, and the
   * commitment covers every block — an address that is not committed is an
   * address a forger can change without breaking a single check.
   *
   * Canonicalized onto one line, and PO boxes are not permitted on a real
   * 8130-3, so none appear here.
   */
  address: string
}

type RosterEntry = Omit<Org, 'handle' | 'email'>

const ROSTER: RosterEntry[] = [
  // ------------------------------------------------------------------ OEMs
  {
    key: 'northwind',
    slug: 'northwind-turbine',
    displayName: 'Northwind Turbine',
    kind: 'oem',
    address: '1200 Industrial Loop, Wichita, KS 67209',
    cage: 'SYN0001',
    certificate: 'SYNTHETIC-PC-00081',
  },
  {
    key: 'calder',
    slug: 'calder-aerosystems',
    displayName: 'Calder Aerosystems',
    kind: 'oem',
    address: '77 Founders Way, Hartford, CT 06120',
    cage: 'SYN0002',
    certificate: 'SYNTHETIC-PC-00114',
  },
  {
    key: 'vantage',
    slug: 'vantage-propulsion',
    displayName: 'Vantage Propulsion',
    kind: 'oem',
    address: '3050 Skyharbor Circle, Phoenix, AZ 85034',
    cage: 'SYN0003',
    certificate: 'SYNTHETIC-PC-00220',
  },

  // ------------------------------------------------------------------ MROs
  {
    key: 'cascadia',
    slug: 'cascadia-mro',
    displayName: 'Cascadia MRO',
    kind: 'mro',
    address: '4400 Airport Way, Everett, WA 98204',
    cage: 'SYN0004',
    certificate: 'SYNTHETIC-CERT-12345',
  },
  {
    key: 'ironwood',
    slug: 'ironwood-aero',
    displayName: 'Ironwood Aero Services',
    kind: 'mro',
    address: '9 Hangar Row, Tulsa, OK 74115',
    cage: 'SYN0005',
    certificate: 'SYNTHETIC-CERT-20418',
  },
  {
    key: 'saltmarsh',
    slug: 'saltmarsh-technics',
    displayName: 'Saltmarsh Aviation Technics',
    kind: 'mro',
    address: '215 Tidewater Drive, Charleston, SC 29405',
    cage: 'SYN0006',
    certificate: 'SYNTHETIC-CERT-20955',
  },
  {
    key: 'flinthills',
    slug: 'flinthills-repair',
    displayName: 'Flinthills Component Repair',
    kind: 'mro',
    address: '640 Prairie Belt Road, Emporia, KS 66801',
    cage: 'SYN0007',
    certificate: 'SYNTHETIC-CERT-21077',
  },
  {
    key: 'harborpoint',
    slug: 'harbor-point-aero',
    displayName: 'Harbor Point Aerospace',
    kind: 'mro',
    address: '1180 Embarcadero West, Oakland, CA 94607',
    cage: 'SYN0008',
    certificate: 'SYNTHETIC-CERT-21340',
  },
  {
    key: 'graniteridge',
    slug: 'granite-ridge',
    displayName: 'Granite Ridge Overhaul',
    kind: 'mro',
    address: '52 Ledge Street, Manchester, NH 03103',
    cage: 'SYN0009',
    certificate: 'SYNTHETIC-CERT-21688',
  },
  {
    key: 'clearwater',
    slug: 'clearwater-turbine',
    displayName: 'Clearwater Turbine Works',
    kind: 'mro',
    address: '8800 Bayline Parkway, Tampa, FL 33619',
    cage: 'SYN0010',
    certificate: 'SYNTHETIC-CERT-22015',
  },
  {
    key: 'copperline',
    slug: 'copperline-repair',
    displayName: 'Copperline Aviation Repair',
    kind: 'mro',
    address: '4501 Ocotillo Boulevard, Tucson, AZ 85714',
    cage: 'SYN0011',
    certificate: 'SYNTHETIC-CERT-22394',
  },
  {
    key: 'sandhills',
    slug: 'sandhills-overhaul',
    displayName: 'Sandhills Accessory Overhaul',
    kind: 'mro',
    address: '77 Meridian Field Road, Grand Island, NE 68801',
    cage: 'SYN0012',
    certificate: 'SYNTHETIC-CERT-22701',
  },
  {
    key: 'basalt',
    slug: 'basalt-aero',
    displayName: 'Basalt Aero Repair',
    kind: 'mro',
    address: '1900 Rimrock Drive, Bend, OR 97701',
    cage: 'SYN0013',
    certificate: 'SYNTHETIC-CERT-23044',
  },
  {
    key: 'fjordholm',
    slug: 'fjordholm-aerotek',
    displayName: 'Fjordholm Aerotek',
    kind: 'mro',
    address: 'Havneveien 14, 4033 Stavanger, Norway',
    cage: 'SYN0014',
    certificate: 'SYNTHETIC-CERT-23319',
  },
  {
    key: 'alpine',
    slug: 'alpine-rotables',
    displayName: 'Alpine Rotables',
    kind: 'mro',
    address: 'Flughafenstrasse 22, 8302 Kloten, Switzerland',
    cage: 'SYN0015',
    certificate: 'SYNTHETIC-CERT-23570',
  },
  {
    key: 'wexford',
    slug: 'wexford-components',
    displayName: 'Wexford Component Services',
    kind: 'mro',
    address: 'Unit 6, Harbour Business Park, Wexford, Ireland',
    cage: 'SYN0016',
    certificate: 'SYNTHETIC-CERT-23902',
  },

  // ------------------------------------------------------------- operators
  {
    key: 'exampleair',
    slug: 'example-air',
    displayName: 'Example Air',
    kind: 'operator',
    address: '7200 Concourse Drive, Denver, CO 80249',
    cage: 'SYN0017',
  },
  {
    key: 'southpoint',
    slug: 'southpoint-air',
    displayName: 'Southpoint Air',
    kind: 'operator',
    address: '3400 Southfield Road, Atlanta, GA 30354',
    cage: 'SYN0018',
  },
  {
    key: 'marisol',
    slug: 'marisol-airways',
    displayName: 'Marisol Airways',
    kind: 'operator',
    address: 'Avenida Aeropuerto 55, San Juan, PR 00979',
    cage: 'SYN0019',
  },
  {
    key: 'highline',
    slug: 'highline-regional',
    displayName: 'Highline Regional',
    kind: 'operator',
    address: '410 Bitterroot Way, Missoula, MT 59808',
    cage: 'SYN0020',
  },
  {
    key: 'cobaltcoast',
    slug: 'cobalt-coast',
    displayName: 'Cobalt Coast Airlines',
    kind: 'operator',
    address: '88 Jetport Road, Portland, ME 04102',
    cage: 'SYN0021',
  },
  {
    key: 'redcliff',
    slug: 'redcliff-cargo',
    displayName: 'Redcliff Cargo',
    kind: 'operator',
    address: '2600 Mesa Cargo Loop, Albuquerque, NM 87106',
    cage: 'SYN0022',
  },
  {
    key: 'pinewood',
    slug: 'pinewood-charter',
    displayName: 'Pinewood Air Charter',
    kind: 'operator',
    address: '145 Lakeshore Airfield Road, Duluth, MN 55811',
    cage: 'SYN0023',
  },
  {
    key: 'kenai',
    slug: 'kenai-freight',
    displayName: 'Kenai Freight Systems',
    kind: 'operator',
    address: '301 Float Plane Road, Kenai, AK 99611',
    cage: 'SYN0024',
  },

  // --------------------------------------------------------------- brokers
  {
    key: 'meridian',
    slug: 'meridian-aeroparts',
    displayName: 'Meridian Aeroparts',
    kind: 'broker',
    address: '90 Cargo Road, Miami, FL 33122',
    cage: 'SYN0025',
  },
  {
    key: 'fairlead',
    slug: 'fairlead-exchange',
    displayName: 'Fairlead Parts Exchange',
    kind: 'broker',
    address: '1220 Seaboard Avenue, Norfolk, VA 23502',
    cage: 'SYN0026',
  },
  {
    key: 'rioseco',
    slug: 'rio-seco-rotables',
    displayName: 'Rio Seco Rotable Exchange',
    kind: 'broker',
    address: '505 Bridgeport Trade Way, Laredo, TX 78045',
    cage: 'SYN0027',
  },

  // --------------------------------------------------------------- lessors
  {
    key: 'halyard',
    slug: 'halyard-leasing',
    displayName: 'Halyard Aircraft Leasing',
    kind: 'lessor',
    address: '18 Docklands Quay, Dublin 2, Ireland',
    cage: 'SYN0028',
  },
  {
    key: 'windward',
    slug: 'windward-leasing',
    displayName: 'Windward Asset Leasing',
    kind: 'lessor',
    address: '3 Changi Business Park Crescent, Singapore 486026',
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
    address: entry.address,
  }))
}

/** Organizations of one kind, in roster order. */
export function orgsOfKind(all: Org[], kind: OrgKind): Org[] {
  return all.filter((o) => o.kind === kind)
}

export const SYNTHETIC_ORG_MARKER =
  'SYNTHETIC DEMONSTRATION DATA — fictional organization, not a real company'
