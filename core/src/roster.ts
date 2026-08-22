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
 * Two rules the roster follows deliberately:
 *
 *   - CAGE codes are seven characters (`SYN####`). A real CAGE code is exactly
 *     five, so these cannot collide with one no matter how unlucky we get.
 *   - Coordinates are integer microdegrees. DAG-CBOR under AT Protocol forbids
 *     floats outright, so a latitude of 47.979 is not merely discouraged — it
 *     is unencodable. Same reason money in this project is counted in cents.
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
  city: string
  region: string
  /** ISO 3166-1 alpha-2. */
  country: string
  latMicro: number
  lonMicro: number
}

type RosterEntry = Omit<Org, 'key' | 'handle' | 'email' | 'latMicro' | 'lonMicro'> & {
  key: string
  lat: number
  lon: number
}

/**
 * Degrees to microdegrees, as an integer.
 *
 * Math.round rather than truncation so the sign behaves at negative
 * longitudes, which is most of this roster.
 */
function micro(deg: number): number {
  return Math.round(deg * 1_000_000)
}

const ROSTER: RosterEntry[] = [
  // ------------------------------------------------------------------ OEMs
  {
    key: 'northwind',
    slug: 'northwind-turbine',
    displayName: 'Northwind Turbine',
    kind: 'oem',
    cage: 'SYN0001',
    certificate: 'SYNTHETIC-PC-00081',
    city: 'Wichita',
    region: 'KS',
    country: 'US',
    lat: 37.6872,
    lon: -97.3301,
  },
  {
    key: 'calder',
    slug: 'calder-aerosystems',
    displayName: 'Calder Aerosystems',
    kind: 'oem',
    cage: 'SYN0002',
    certificate: 'SYNTHETIC-PC-00114',
    city: 'Hartford',
    region: 'CT',
    country: 'US',
    lat: 41.7658,
    lon: -72.6734,
  },
  {
    key: 'vantage',
    slug: 'vantage-propulsion',
    displayName: 'Vantage Propulsion',
    kind: 'oem',
    cage: 'SYN0003',
    certificate: 'SYNTHETIC-PC-00220',
    city: 'Phoenix',
    region: 'AZ',
    country: 'US',
    lat: 33.4484,
    lon: -112.074,
  },

  // ------------------------------------------------------------------ MROs
  {
    key: 'cascadia',
    slug: 'cascadia-mro',
    displayName: 'Cascadia MRO',
    kind: 'mro',
    cage: 'SYN0004',
    certificate: 'SYNTHETIC-CERT-12345',
    city: 'Everett',
    region: 'WA',
    country: 'US',
    lat: 47.979,
    lon: -122.2021,
  },
  {
    key: 'ironwood',
    slug: 'ironwood-aero',
    displayName: 'Ironwood Aero Services',
    kind: 'mro',
    cage: 'SYN0005',
    certificate: 'SYNTHETIC-CERT-20418',
    city: 'Tulsa',
    region: 'OK',
    country: 'US',
    lat: 36.154,
    lon: -95.9928,
  },
  {
    key: 'saltmarsh',
    slug: 'saltmarsh-technics',
    displayName: 'Saltmarsh Aviation Technics',
    kind: 'mro',
    cage: 'SYN0006',
    certificate: 'SYNTHETIC-CERT-20955',
    city: 'Charleston',
    region: 'SC',
    country: 'US',
    lat: 32.7765,
    lon: -79.9311,
  },
  {
    key: 'flinthills',
    slug: 'flinthills-repair',
    displayName: 'Flinthills Component Repair',
    kind: 'mro',
    cage: 'SYN0007',
    certificate: 'SYNTHETIC-CERT-21077',
    city: 'Emporia',
    region: 'KS',
    country: 'US',
    lat: 38.4039,
    lon: -96.1817,
  },
  {
    key: 'harborpoint',
    slug: 'harbor-point-aero',
    displayName: 'Harbor Point Aerospace',
    kind: 'mro',
    cage: 'SYN0008',
    certificate: 'SYNTHETIC-CERT-21340',
    city: 'Oakland',
    region: 'CA',
    country: 'US',
    lat: 37.8044,
    lon: -122.2712,
  },
  {
    key: 'graniteridge',
    slug: 'granite-ridge',
    displayName: 'Granite Ridge Overhaul',
    kind: 'mro',
    cage: 'SYN0009',
    certificate: 'SYNTHETIC-CERT-21688',
    city: 'Manchester',
    region: 'NH',
    country: 'US',
    lat: 42.9956,
    lon: -71.4548,
  },
  {
    key: 'clearwater',
    slug: 'clearwater-turbine',
    displayName: 'Clearwater Turbine Works',
    kind: 'mro',
    cage: 'SYN0010',
    certificate: 'SYNTHETIC-CERT-22015',
    city: 'Tampa',
    region: 'FL',
    country: 'US',
    lat: 27.9506,
    lon: -82.4572,
  },
  {
    key: 'copperline',
    slug: 'copperline-repair',
    displayName: 'Copperline Aviation Repair',
    kind: 'mro',
    cage: 'SYN0011',
    certificate: 'SYNTHETIC-CERT-22394',
    city: 'Tucson',
    region: 'AZ',
    country: 'US',
    lat: 32.2226,
    lon: -110.9747,
  },
  {
    key: 'sandhills',
    slug: 'sandhills-overhaul',
    displayName: 'Sandhills Accessory Overhaul',
    kind: 'mro',
    cage: 'SYN0012',
    certificate: 'SYNTHETIC-CERT-22701',
    city: 'Grand Island',
    region: 'NE',
    country: 'US',
    lat: 40.9264,
    lon: -98.342,
  },
  {
    key: 'basalt',
    slug: 'basalt-aero',
    displayName: 'Basalt Aero Repair',
    kind: 'mro',
    cage: 'SYN0013',
    certificate: 'SYNTHETIC-CERT-23044',
    city: 'Bend',
    region: 'OR',
    country: 'US',
    lat: 44.0582,
    lon: -121.3153,
  },
  {
    key: 'fjordholm',
    slug: 'fjordholm-aerotek',
    displayName: 'Fjordholm Aerotek',
    kind: 'mro',
    cage: 'SYN0014',
    certificate: 'SYNTHETIC-CERT-23319',
    city: 'Stavanger',
    region: 'Rogaland',
    country: 'NO',
    lat: 58.97,
    lon: 5.7331,
  },
  {
    key: 'alpine',
    slug: 'alpine-rotables',
    displayName: 'Alpine Rotables',
    kind: 'mro',
    cage: 'SYN0015',
    certificate: 'SYNTHETIC-CERT-23570',
    city: 'Zurich',
    region: 'ZH',
    country: 'CH',
    lat: 47.3769,
    lon: 8.5417,
  },
  {
    key: 'wexford',
    slug: 'wexford-components',
    displayName: 'Wexford Component Services',
    kind: 'mro',
    cage: 'SYN0016',
    certificate: 'SYNTHETIC-CERT-23902',
    city: 'Wexford',
    region: 'Leinster',
    country: 'IE',
    lat: 52.3369,
    lon: -6.4633,
  },

  // ------------------------------------------------------------- operators
  {
    key: 'exampleair',
    slug: 'example-air',
    displayName: 'Example Air',
    kind: 'operator',
    cage: 'SYN0017',
    city: 'Denver',
    region: 'CO',
    country: 'US',
    lat: 39.7392,
    lon: -104.9903,
  },
  {
    key: 'southpoint',
    slug: 'southpoint-air',
    displayName: 'Southpoint Air',
    kind: 'operator',
    cage: 'SYN0018',
    city: 'Atlanta',
    region: 'GA',
    country: 'US',
    lat: 33.749,
    lon: -84.388,
  },
  {
    key: 'marisol',
    slug: 'marisol-airways',
    displayName: 'Marisol Airways',
    kind: 'operator',
    cage: 'SYN0019',
    city: 'San Juan',
    region: 'PR',
    country: 'US',
    lat: 18.4655,
    lon: -66.1057,
  },
  {
    key: 'highline',
    slug: 'highline-regional',
    displayName: 'Highline Regional',
    kind: 'operator',
    cage: 'SYN0020',
    city: 'Missoula',
    region: 'MT',
    country: 'US',
    lat: 46.8721,
    lon: -113.994,
  },
  {
    key: 'cobaltcoast',
    slug: 'cobalt-coast',
    displayName: 'Cobalt Coast Airlines',
    kind: 'operator',
    cage: 'SYN0021',
    city: 'Portland',
    region: 'ME',
    country: 'US',
    lat: 43.6591,
    lon: -70.2568,
  },
  {
    key: 'redcliff',
    slug: 'redcliff-cargo',
    displayName: 'Redcliff Cargo',
    kind: 'operator',
    cage: 'SYN0022',
    city: 'Albuquerque',
    region: 'NM',
    country: 'US',
    lat: 35.0844,
    lon: -106.6504,
  },
  {
    key: 'pinewood',
    slug: 'pinewood-charter',
    displayName: 'Pinewood Air Charter',
    kind: 'operator',
    cage: 'SYN0023',
    city: 'Duluth',
    region: 'MN',
    country: 'US',
    lat: 46.7867,
    lon: -92.1005,
  },
  {
    key: 'kenai',
    slug: 'kenai-freight',
    displayName: 'Kenai Freight Systems',
    kind: 'operator',
    cage: 'SYN0024',
    city: 'Kenai',
    region: 'AK',
    country: 'US',
    lat: 60.5544,
    lon: -151.2583,
  },

  // --------------------------------------------------------------- brokers
  {
    key: 'meridian',
    slug: 'meridian-aeroparts',
    displayName: 'Meridian Aeroparts',
    kind: 'broker',
    cage: 'SYN0025',
    city: 'Miami',
    region: 'FL',
    country: 'US',
    lat: 25.7617,
    lon: -80.1918,
  },
  {
    key: 'fairlead',
    slug: 'fairlead-exchange',
    displayName: 'Fairlead Parts Exchange',
    kind: 'broker',
    cage: 'SYN0026',
    city: 'Norfolk',
    region: 'VA',
    country: 'US',
    lat: 36.8508,
    lon: -76.2859,
  },
  {
    key: 'rioseco',
    slug: 'rio-seco-rotables',
    displayName: 'Rio Seco Rotable Exchange',
    kind: 'broker',
    cage: 'SYN0027',
    city: 'Laredo',
    region: 'TX',
    country: 'US',
    lat: 27.5306,
    lon: -99.4803,
  },

  // --------------------------------------------------------------- lessors
  {
    key: 'halyard',
    slug: 'halyard-leasing',
    displayName: 'Halyard Aircraft Leasing',
    kind: 'lessor',
    cage: 'SYN0028',
    city: 'Dublin',
    region: 'Leinster',
    country: 'IE',
    lat: 53.3498,
    lon: -6.2603,
  },
  {
    key: 'windward',
    slug: 'windward-leasing',
    displayName: 'Windward Asset Leasing',
    kind: 'lessor',
    cage: 'SYN0029',
    city: 'Singapore',
    region: 'SG',
    country: 'SG',
    lat: 1.3521,
    lon: 103.8198,
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
    city: entry.city,
    region: entry.region,
    country: entry.country,
    latMicro: micro(entry.lat),
    lonMicro: micro(entry.lon),
  }))
}

/** Organizations of one kind, in roster order. */
export function orgsOfKind(all: Org[], kind: OrgKind): Org[] {
  return all.filter((o) => o.kind === kind)
}

export const SYNTHETIC_ORG_MARKER =
  'SYNTHETIC DEMONSTRATION DATA — fictional organization, not a real company'
