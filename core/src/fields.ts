/**
 * The committed field set.
 *
 * FIELD ORDER IS SCHEMA. Changing the order, the membership, or any field's
 * normalization kind changes every commitment root ever produced. None of it
 * may be edited in place — bump FIELD_SET_VERSION and add a new table.
 *
 * Version 2 is the whole form. Version 1 committed to fifteen fields chosen by
 * what seemed interesting, which left four blocks of the actual 8130-3
 * uncommitted — including Block 4, the issuing organization's name and address.
 * That is not a gap in coverage, it is a hole in the guarantee: a bundle could
 * be rendered under a different organization's letterhead and every check would
 * still pass, because the commitment never covered the letterhead. A commitment
 * over a subset of a document commits to a subset of a document.
 *
 * So every field here maps to a numbered block on the form, and every block a
 * releasing organization fills in has a field. Nothing else is committed:
 * version 1 also carried cost and customer, which are not 8130-3 fields at all.
 */

export const FIELD_SET_VERSION = 2

/**
 * How a field's value is canonicalized before it is hashed into a leaf.
 *
 * `identifier` — the aggressive normalization from §4.1: strip separators and
 *   uppercase, so `NT-8821/04`, `nt 8821 04`, and `NT882104` all commit to the
 *   same bytes. Part and serial numbers get transcribed by hand off a metal
 *   plate; the punctuation is noise.
 * `text`       — human prose. NFC, collapse internal runs of whitespace, trim.
 *   Note that this flattens a multi-line address onto one line, which is
 *   deliberate: the canonical form of Block 4 is a single line, and two people
 *   who wrapped the same address differently must commit to the same bytes.
 * `integer`    — exact integers only. Floats are rejected outright rather than
 *   rounded.
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
  /**
   * The block on FAA Form 8130-3 this field carries.
   *
   * Recorded in the schema rather than in a comment because the form view
   * renders from it, and because a field that cannot name its block is a field
   * that has drifted away from the document.
   */
  block: string
}

/**
 * Block 11, Status/Work.
 *
 * `TESTED` is here because FAA guidance names it explicitly alongside
 * `INSPECTED` as an acceptable Block 11 entry for a return to service.
 */
export const RELEASE_STATUS = [
  'NEW',
  'OVERHAULED',
  'REPAIRED',
  'INSPECTED',
  'TESTED',
  'MODIFIED',
] as const

/**
 * Which certifying column of the form is in use.
 *
 * Block 13 certifies conformity for new manufacture; Block 14 approves a return
 * to service after maintenance. A form is one or the other and never both — one
 * column is always blank — so this is a single field rather than two.
 */
export const CERTIFYING_BLOCK = ['CONFORMITY', 'RETURN_TO_SERVICE'] as const

/**
 * The statement selected in Block 13a or Block 14a.
 *
 * Two options under each column. Which pair is legal depends on
 * `certifyingBlock`, and `validateApprovalBasis` enforces that pairing —
 * a return to service certified against approved design data is not a form
 * anyone could file.
 */
export const APPROVAL_BASIS = [
  // Block 13a
  'APPROVED_DESIGN_DATA',
  'NON_APPROVED_DESIGN_DATA',
  // Block 14a
  'PART_43_RETURN_TO_SERVICE',
  'OTHER_REGULATION',
] as const

const BASIS_FOR_BLOCK: Record<string, readonly string[]> = {
  CONFORMITY: ['APPROVED_DESIGN_DATA', 'NON_APPROVED_DESIGN_DATA'],
  RETURN_TO_SERVICE: ['PART_43_RETURN_TO_SERVICE', 'OTHER_REGULATION'],
}

/**
 * The seventeen committed fields, in commitment order.
 *
 * Ordered by block number so the sequence is self-documenting and the form
 * view's mapping is mechanical rather than a lookup table someone maintains.
 *
 * Block 2 is the preprinted title and Block 13b/14b is the signature itself,
 * which in this design is the AT Protocol commit signature rather than
 * anything written on the page. Neither is a committed field.
 */
export const FIELDS: readonly FieldSpec[] = [
  { name: 'approvingAuthority', kind: 'text', public: true, block: '1' },
  { name: 'formNumber', kind: 'identifier', public: true, block: '3' },
  { name: 'organizationName', kind: 'text', public: true, block: '4' },
  { name: 'organizationAddress', kind: 'text', public: true, block: '4' },
  { name: 'workOrder', kind: 'identifier', public: false, block: '5' },
  { name: 'item', kind: 'integer', public: false, block: '6' },
  { name: 'description', kind: 'text', public: true, block: '7' },
  { name: 'partNumber', kind: 'identifier', public: true, block: '8' },
  { name: 'quantity', kind: 'integer', public: false, block: '9' },
  { name: 'serialNumber', kind: 'identifier', public: true, block: '10' },
  { name: 'status', kind: 'enum', values: RELEASE_STATUS, public: false, block: '11' },
  { name: 'remarks', kind: 'text', public: false, block: '12' },
  {
    name: 'certifyingBlock',
    kind: 'enum',
    values: CERTIFYING_BLOCK,
    public: false,
    block: '13/14',
  },
  {
    name: 'approvalBasis',
    kind: 'enum',
    values: APPROVAL_BASIS,
    public: false,
    block: '13a/14a',
  },
  { name: 'signerCert', kind: 'identifier', public: true, block: '13c/14c' },
  { name: 'signerName', kind: 'text', public: false, block: '13d/14d' },
  { name: 'completedAt', kind: 'timestamp', public: true, block: '13e/14e' },
] as const

export const FIELD_ORDER: readonly string[] = FIELDS.map((f) => f.name)

export const FIELD_INDEX: ReadonlyMap<string, number> = new Map(
  FIELDS.map((f, i) => [f.name, i]),
)

/**
 * Fields that also appear in plaintext on the public release record.
 *
 * This is not part of the commitment. Every field above is committed whatever
 * this says; `public` only decides what a reader can see without being given a
 * bundle. Which means the split can be revised without invalidating a single
 * root — unlike the field set, which cannot.
 *
 * The current split publishes identity and discovery, and withholds the work.
 * Status and remarks are commercially sensitive to an operator: Block 11 says
 * what was done to the part, and Block 12 carries the detail behind it.
 * `certifyingBlock` travels with them, because new-manufacture versus
 * return-to-service is most of what Block 11 would have told you.
 */
export const PUBLIC_FIELDS: readonly string[] = FIELDS.filter(
  (f) => f.public,
).map((f) => f.name)

export function fieldSpec(name: string): FieldSpec {
  const spec = FIELDS.find((f) => f.name === name)
  if (!spec) throw new Error(`unknown field: ${name}`)
  return spec
}

/** Whether an approval basis is one of the two legal for a certifying block. */
export function validateApprovalBasis(
  certifyingBlock: string,
  approvalBasis: string,
): boolean {
  return BASIS_FOR_BLOCK[certifyingBlock]?.includes(approvalBasis) ?? false
}

/** The approval bases legal under a certifying block. */
export function basesForBlock(certifyingBlock: string): readonly string[] {
  return BASIS_FOR_BLOCK[certifyingBlock] ?? []
}

/**
 * The plaintext subset of a canonicalized form that goes on the public record.
 *
 * One implementation, called by everything that writes or reproduces a release
 * record — the seed, the web writer, the vector generator, and the tests that
 * check them. Four hand-maintained copies of this list existed before, and
 * three of them went on naming `status` after status stopped being public.
 *
 * Null values are omitted rather than written as null: a field the issuer left
 * blank is absent from the record, and the commitment is what says it was
 * committed to as null.
 */
export function publicValues(
  values: CanonicalForm,
): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const name of PUBLIC_FIELDS) {
    const v = values[name]
    if (v !== null && v !== undefined) out[name] = v
  }
  return out
}

/** A form as supplied by a caller, before canonicalization. */
export type RawForm = Record<string, unknown>

/** A form after canonicalization: every field present, null for absent. */
export type CanonicalForm = Record<string, string | number | null>
