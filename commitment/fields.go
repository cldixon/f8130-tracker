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
const FieldSetVersion = 2

// FieldKind determines how a value is canonicalized before hashing.
type FieldKind int

const (
	// KindIdentifier strips separators and uppercases: part and serial
	// numbers get transcribed by hand off a metal plate, so the punctuation
	// is noise.
	KindIdentifier FieldKind = iota
	// KindText is human prose: NFC, collapse internal whitespace, trim.
	KindText
	// KindInteger is exact integers only; floats are refused rather than
	// rounded.
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
	Block  string   // the block on FAA Form 8130-3 this field carries
}

// ReleaseStatus is the closed set of Block 11 entries.
//
// TESTED is here because FAA guidance names it explicitly alongside INSPECTED
// as an acceptable Block 11 entry for a return to service.
var ReleaseStatus = []string{"NEW", "OVERHAULED", "REPAIRED", "INSPECTED", "TESTED", "MODIFIED"}

// CertifyingBlock is which certifying column of the form is in use. Block 13
// certifies conformity for new manufacture; Block 14 approves a return to
// service. A form is one or the other and never both.
var CertifyingBlock = []string{"CONFORMITY", "RETURN_TO_SERVICE"}

// ApprovalBasis is the statement selected in Block 13a or Block 14a. The first
// two belong to Block 13a, the second two to Block 14a; which pair is legal
// depends on CertifyingBlock.
var ApprovalBasis = []string{
	"APPROVED_DESIGN_DATA",
	"NON_APPROVED_DESIGN_DATA",
	"PART_43_RETURN_TO_SERVICE",
	"OTHER_REGULATION",
}

// Fields is the committed field set, in commitment order.
//
// FIELD ORDER IS SCHEMA. Never reorder, never add, never remove — bump
// FieldSetVersion and add a new table.
//
// Version 2 is the whole form. Version 1 committed to fifteen fields chosen by
// what seemed interesting, which left four blocks of the actual 8130-3
// uncommitted — Block 1, Block 4, Block 6, and the 13a/14a approval basis.
// That is a hole in the guarantee rather than a gap in coverage: a commitment
// over part of a document commits to part of a document. Version 1 also
// carried cost and customer, which are not 8130-3 fields at all.
//
// Ordered by block number, so the sequence is self-documenting.
var Fields = []FieldSpec{
	{Name: "approvingAuthority", Kind: KindText, Public: true, Block: "1"},
	{Name: "formNumber", Kind: KindIdentifier, Public: true, Block: "3"},
	{Name: "organizationName", Kind: KindText, Public: true, Block: "4"},
	{Name: "organizationAddress", Kind: KindText, Public: true, Block: "4"},
	{Name: "workOrder", Kind: KindIdentifier, Block: "5"},
	{Name: "item", Kind: KindInteger, Block: "6"},
	{Name: "description", Kind: KindText, Public: true, Block: "7"},
	{Name: "partNumber", Kind: KindIdentifier, Public: true, Block: "8"},
	{Name: "quantity", Kind: KindInteger, Block: "9"},
	{Name: "serialNumber", Kind: KindIdentifier, Public: true, Block: "10"},
	{Name: "status", Kind: KindEnum, Values: ReleaseStatus, Block: "11"},
	{Name: "remarks", Kind: KindText, Block: "12"},
	{Name: "certifyingBlock", Kind: KindEnum, Values: CertifyingBlock, Block: "13/14"},
	{Name: "approvalBasis", Kind: KindEnum, Values: ApprovalBasis, Block: "13a/14a"},
	{Name: "signerCert", Kind: KindIdentifier, Public: true, Block: "13c/14c"},
	{Name: "signerName", Kind: KindText, Block: "13d/14d"},
	{Name: "completedAt", Kind: KindTimestamp, Public: true, Block: "13e/14e"},
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
