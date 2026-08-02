/**
 * The committed field set.
 *
 * FIELD ORDER IS SCHEMA. Changing the order, the membership, or any field's
 * normalization kind changes every commitment root ever produced. None of it
 * may be edited in place — bump FIELD_SET_VERSION and add a new table.
 */

export const FIELD_SET_VERSION = 1

/**
 * How a field's value is canonicalized before it is hashed into a leaf.
 *
 * `identifier` — the aggressive normalization from §4.1: strip separators and
 *   uppercase, so `NT-8821/04`, `nt 8821 04`, and `NT882104` all commit to the
 *   same bytes. Part and serial numbers get transcribed by hand off a metal
 *   plate; the punctuation is noise.
 * `text`       — human prose. NFC, collapse internal runs of whitespace, trim.
 * `integer`    — exact integers only. Money is cents; floats are rejected
 *   outright rather than rounded.
 * `timestamp`  — RFC 3339, forced to UTC, second precision. Naive datetimes
 *   are rejected: a timestamp without an offset is not a point in time.
 * `enum`       — a closed set, compared case-insensitively and stored upper.
 */
export type FieldKind = 'identifier' | 'text' | 'integer' | 'timestamp' | 'enum'

export type FieldSpec = {
  name: string
  kind: FieldKind
  /** Permitted values, for `enum` fields. */
  values?: readonly string[]
  /** Whether this field also appears in plaintext on the public record. */
  public: boolean
}

export const RELEASE_STATUS = [
  'NEW',
  'OVERHAULED',
  'REPAIRED',
  'INSPECTED',
  'MODIFIED',
] as const

/**
 * The 15 committed fields, in commitment order.
 *
 * NOTE ON `formNumber`: the handoff document names exactly four identifier
 * fields — partNumber, serialNumber, workOrder, signerCert — and formNumber is
 * not among them, so it is canonicalized as text. That is very likely an
 * oversight (a form number is an identifier by any reasonable reading), but
 * changing it is a version bump, not an edit, so it stays as specified until
 * someone decides otherwise.
 */
export const FIELDS: readonly FieldSpec[] = [
  { name: 'formNumber', kind: 'text', public: true },
  { name: 'partNumber', kind: 'identifier', public: true },
  { name: 'serialNumber', kind: 'identifier', public: true },
  { name: 'description', kind: 'text', public: false },
  { name: 'status', kind: 'enum', values: RELEASE_STATUS, public: true },
  { name: 'quantity', kind: 'integer', public: false },
  { name: 'workOrder', kind: 'identifier', public: false },
  { name: 'findings', kind: 'text', public: false },
  { name: 'workscope', kind: 'text', public: false },
  { name: 'costCents', kind: 'integer', public: false },
  { name: 'customer', kind: 'text', public: false },
  { name: 'signerCert', kind: 'identifier', public: true },
  { name: 'signerName', kind: 'text', public: false },
  { name: 'remarks', kind: 'text', public: false },
  { name: 'completedAt', kind: 'timestamp', public: true },
] as const

export const FIELD_ORDER: readonly string[] = FIELDS.map((f) => f.name)

export const FIELD_INDEX: ReadonlyMap<string, number> = new Map(
  FIELDS.map((f, i) => [f.name, i]),
)

/** Fields that also appear in plaintext on the public release record. */
export const PUBLIC_FIELDS: readonly string[] = FIELDS.filter(
  (f) => f.public,
).map((f) => f.name)

export function fieldSpec(name: string): FieldSpec {
  const spec = FIELDS.find((f) => f.name === name)
  if (!spec) throw new Error(`unknown field: ${name}`)
  return spec
}

/** A form as supplied by a caller, before canonicalization. */
export type RawForm = Record<string, unknown>

/** A form after canonicalization: every field present, null for absent. */
export type CanonicalForm = Record<string, string | number | null>
