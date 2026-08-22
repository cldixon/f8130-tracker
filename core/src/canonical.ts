/**
 * Canonicalization (§4.1).
 *
 * Every rule here is idempotent: canonicalize(canonicalize(x)) === canonicalize(x).
 * That property is tested, because a non-idempotent rule silently produces two
 * different roots for the same form depending on how many times it was
 * normalized on the way in.
 */

import {
  FIELDS,
  FIELD_SET_VERSION,
  type CanonicalForm,
  type FieldSpec,
  type RawForm,
} from './fields.js'

export class CanonicalizationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`)
    this.name = 'CanonicalizationError'
  }
}

/** Separator characters stripped from identifiers: whitespace - _ / . */
const IDENTIFIER_NOISE = /[\s\-_/.]+/g

/**
 * RFC 3339 with a mandatory offset. The offset is what makes this a point in
 * time rather than a wall-clock reading, so a naive datetime is an error, not
 * something to guess a zone for.
 */
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

export function normalizeIdentifier(value: string): string {
  return value.normalize('NFC').replace(IDENTIFIER_NOISE, '').toUpperCase()
}

export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/**
 * Truncates to second precision rather than rejecting sub-second input — an
 * 8130-3 is not signed to the millisecond, and rejecting would make round
 * trips through systems that add milliseconds fail confusingly.
 */
export function normalizeTimestamp(field: string, value: string): string {
  const trimmed = value.trim()
  const m = RFC3339.exec(trimmed)
  if (!m) {
    throw new CanonicalizationError(
      field,
      `expected RFC 3339 with a UTC offset, got ${JSON.stringify(value)}`,
    )
  }

  const [, y, mo, d, hh, mm, ss] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)

  // Date.parse rolls impossible dates forward — 2019-02-30 silently becomes
  // 2019-03-02 — which would commit to a date nobody typed. Validate the
  // calendar date by round-tripping it through a UTC construction instead.
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new CanonicalizationError(
      field,
      `not a real calendar date: ${JSON.stringify(value)}`,
    )
  }

  // Leap seconds are rejected rather than rolled forward, for the same reason.
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) {
    throw new CanonicalizationError(
      field,
      `time out of range: ${JSON.stringify(value)}`,
    )
  }

  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) {
    throw new CanonicalizationError(field, `not a valid date: ${JSON.stringify(value)}`)
  }
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function normalizeInteger(field: string, value: unknown): number {
  if (typeof value !== 'number') {
    throw new CanonicalizationError(
      field,
      `expected a number, got ${typeof value} — integers are never parsed from strings here`,
    )
  }
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(field, `expected a finite number, got ${value}`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalizationError(
      field,
      `expected a safe integer, got ${value} — money is integer cents, never a float`,
    )
  }
  return value
}

function normalizeEnum(spec: FieldSpec, value: string): string {
  const upper = value.normalize('NFC').trim().toUpperCase()
  if (!spec.values!.includes(upper)) {
    throw new CanonicalizationError(
      spec.name,
      `expected one of ${spec.values!.join(', ')}, got ${JSON.stringify(value)}`,
    )
  }
  return upper
}

/**
 * Canonicalizes one field value.
 *
 * `null` and absent are the same thing. An empty string is NOT null — a shop
 * that wrote nothing in the remarks box committed to an empty remarks box, and
 * that is a different claim from having no remarks field at all.
 */
export function canonicalizeField(
  spec: FieldSpec,
  value: unknown,
): string | number | null {
  if (value === null || value === undefined) return null

  if (spec.kind === 'integer') return normalizeInteger(spec.name, value)

  if (typeof value !== 'string') {
    throw new CanonicalizationError(
      spec.name,
      `expected a string for a ${spec.kind} field, got ${typeof value}`,
    )
  }

  switch (spec.kind) {
    case 'identifier':
      return normalizeIdentifier(value)
    case 'text':
      return normalizeText(value)
    case 'timestamp':
      return normalizeTimestamp(spec.name, value)
    case 'enum':
      return normalizeEnum(spec, value)
  }
}

/**
 * Canonicalizes a whole form into the fixed field set.
 *
 * Every field is always present in the result, explicitly null when absent, so
 * the commitment tree has a constant shape for every form ever issued. Unknown
 * keys are rejected rather than ignored: silently dropping a field the caller
 * believed they were committing to is the worst possible failure here.
 */
export function canonicalizeForm(form: RawForm): CanonicalForm {
  const unknown = Object.keys(form).filter(
    (k) => !FIELDS.some((f) => f.name === k),
  )
  if (unknown.length > 0) {
    throw new CanonicalizationError(
      unknown[0]!,
      `not part of the committed field set (v${FIELD_SET_VERSION}); ` +
        `got unknown keys: ${unknown.join(', ')}`,
    )
  }

  const out: CanonicalForm = {}
  for (const spec of FIELDS) {
    out[spec.name] = canonicalizeField(spec, form[spec.name])
  }
  return out
}
