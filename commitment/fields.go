// Package commitment implements the f8130 field commitment scheme.
//
// This is a deliberate second implementation. The scheme is meant to be
// independently implementable from the specification alone, and the only way
// to know whether it actually is — rather than having quietly encoded a
// JavaScript quirk — is to write it twice and make both agree byte for byte
// against testdata/vectors.json.
package commitment

// FieldSetVersion identifies the committed field order and normalization
// rules. Changing either invalidates every commitment ever published, so this
// is versioned rather than edited.
const FieldSetVersion = 1

// FieldKind determines how a value is canonicalized before hashing.
type FieldKind int

const (
	// KindIdentifier strips separators and uppercases: part and serial
	// numbers get transcribed by hand off a metal plate, so the punctuation
	// is noise.
	KindIdentifier FieldKind = iota
	// KindText is human prose: NFC, collapse internal whitespace, trim.
	KindText
	// KindInteger is exact integers only. Money is cents; floats are refused
	// rather than rounded.
	KindInteger
	// KindTimestamp is RFC 3339 forced to UTC at second precision. A datetime
	// without an offset is not a point in time and is rejected.
	KindTimestamp
	// KindEnum is a closed set, compared case-insensitively.
	KindEnum
)

// FieldSpec describes one committed field.
type FieldSpec struct {
	Name   string
	Kind   FieldKind
	Values []string // permitted values, for KindEnum
	Public bool     // also appears in plaintext on the release record
}

// ReleaseStatus is the closed set of release statuses.
var ReleaseStatus = []string{"NEW", "OVERHAULED", "REPAIRED", "INSPECTED", "MODIFIED"}

// Fields is the committed field set, in commitment order.
//
// FIELD ORDER IS SCHEMA. Never reorder, never add, never remove — bump
// FieldSetVersion and add a new table.
//
// On formNumber: the specification names exactly four identifier fields
// (partNumber, serialNumber, workOrder, signerCert) and formNumber is not
// among them, so it is canonicalized as text. Probably an oversight, but
// changing it is a version bump rather than an edit.
var Fields = []FieldSpec{
	{Name: "formNumber", Kind: KindText, Public: true},
	{Name: "partNumber", Kind: KindIdentifier, Public: true},
	{Name: "serialNumber", Kind: KindIdentifier, Public: true},
	{Name: "description", Kind: KindText},
	{Name: "status", Kind: KindEnum, Values: ReleaseStatus, Public: true},
	{Name: "quantity", Kind: KindInteger},
	{Name: "workOrder", Kind: KindIdentifier},
	{Name: "findings", Kind: KindText},
	{Name: "workscope", Kind: KindText},
	{Name: "costCents", Kind: KindInteger},
	{Name: "customer", Kind: KindText},
	{Name: "signerCert", Kind: KindIdentifier, Public: true},
	{Name: "signerName", Kind: KindText},
	{Name: "remarks", Kind: KindText},
	{Name: "completedAt", Kind: KindTimestamp, Public: true},
}

// FieldOrder returns the committed field names in order.
func FieldOrder() []string {
	names := make([]string, len(Fields))
	for i, f := range Fields {
		names[i] = f.Name
	}
	return names
}

// IndexOf returns the commitment index of a field, or -1.
func IndexOf(name string) int {
	for i, f := range Fields {
		if f.Name == name {
			return i
		}
	}
	return -1
}

// Value is a canonicalized field value: string, int64, or nil.
//
// nil and absent are the same thing. An empty string is NOT nil — a shop that
// wrote nothing in the remarks box committed to an empty remarks box, which is
// a different claim from having no remarks field at all.
type Value any

// Form is a canonicalized form: every field present, nil where absent.
type Form map[string]Value
