package ingest

import (
	"fmt"
	"time"

	"github.com/bluesky-social/indigo/atproto/atdata"
)

const (
	ReleaseNSID     = "dev.cldixon.f8130.release"
	AttestationNSID = "dev.cldixon.f8130.attestation"
	StationNSID     = "dev.cldixon.f8130.station"
)

// StrongRef is an atproto strong reference: a location plus the content hash
// of what was there when the reference was made.
type StrongRef struct {
	URI string
	CID string
}

// Release is a decoded release record.
//
// These are the blocks of the form that appear in plaintext on the public
// record. Block 11 (status) and Block 12 (remarks) are not among them: what was
// done to a part, and what the shop found, are commercially sensitive to the
// operator. They are committed like every other block and disclosed
// selectively.
type Release struct {
	Commitment          []byte
	IssuerDID           string
	Prev                *StrongRef
	ApprovingAuthority  string
	FormNumber          string
	OrganizationName    string
	OrganizationAddress string
	Description         string
	PartNumber          string
	SerialNumber        string
	SignerCert          string
	CompletedAt         time.Time
	Raw                 map[string]any
}

// Attestation is a decoded attestation: somebody checked a document against a
// release and it held.
//
// There is no author field to check, and no issuer field either. The author is
// the repository it was found in, which is the only authorship claim worth
// anything; the issuer is in the subject URI, which the strong reference
// already pins. Restating either on the record would only create a second
// place for them to disagree with the first.
//
// There is no failed counterpart. A party who cannot verify a document cannot
// prove that to anyone — a document that fails to recompute shows only that
// some document fails, and anybody can produce one — so the network carries
// successes and nothing else.
type Attestation struct {
	Subject    StrongRef
	VerifiedAt time.Time
	Synthetic  string
	Raw        map[string]any
}

// Station is an organization's self-published profile.
//
// This is how an AppView learns who anybody is. Without it a verdict has
// nothing but a DID to render — the release record carries Block 4 and so can
// name its issuer, but an acceptance carries no name for either party, and an
// operator that has never issued anything is a bare identifier forever.
//
// Nothing here is committed to by any release. It is descriptive and
// self-asserted: an organization saying what it calls itself, in its own
// repository under its own key. That is a weaker claim than a commitment and
// exactly the right strength for a display name.
type Station struct {
	DisplayName string
	Kind        string
	Synthetic   string
	CAGE        string
	Certificate string
	Raw         map[string]any
}

// ErrNotOurs marks a record in a collection this AppView does not index. It is
// an ordinary outcome, not a failure: the firehose carries everyone's data.
var ErrNotOurs = fmt.Errorf("record is not an f8130 record")

// DecodeRecord decodes DAG-CBOR record bytes from a firehose commit.
//
// Every field is validated rather than assumed. These bytes are written by
// whoever operates the repository, which in this design is explicitly not us,
// so a malformed or hostile record has to produce an error and a skipped row
// rather than a panic that stalls the whole stream.
func DecodeRecord(collection string, raw []byte) (any, error) {
	obj, err := atdata.UnmarshalCBOR(raw)
	if err != nil {
		return nil, fmt.Errorf("decode CBOR: %w", err)
	}

	switch collection {
	case ReleaseNSID:
		return decodeRelease(obj)
	case AttestationNSID:
		return decodeAttestation(obj)
	case StationNSID:
		return decodeStation(obj)
	default:
		return nil, ErrNotOurs
	}
}

func decodeRelease(obj map[string]any) (*Release, error) {
	r := &Release{Raw: obj}
	var err error

	if r.Commitment, err = requireBytes(obj, "commitment"); err != nil {
		return nil, err
	}
	if len(r.Commitment) != 32 {
		return nil, fmt.Errorf("commitment must be 32 bytes, got %d", len(r.Commitment))
	}
	if r.IssuerDID, err = requireString(obj, "issuerDid"); err != nil {
		return nil, err
	}
	if r.ApprovingAuthority, err = requireString(obj, "approvingAuthority"); err != nil {
		return nil, err
	}
	if r.FormNumber, err = requireString(obj, "formNumber"); err != nil {
		return nil, err
	}
	if r.OrganizationName, err = requireString(obj, "organizationName"); err != nil {
		return nil, err
	}
	if r.OrganizationAddress, err = requireString(obj, "organizationAddress"); err != nil {
		return nil, err
	}
	if r.Description, err = requireString(obj, "description"); err != nil {
		return nil, err
	}
	if r.PartNumber, err = requireString(obj, "partNumber"); err != nil {
		return nil, err
	}
	if r.SerialNumber, err = requireString(obj, "serialNumber"); err != nil {
		return nil, err
	}
	if r.SignerCert, err = requireString(obj, "signerCert"); err != nil {
		return nil, err
	}
	if r.CompletedAt, err = requireTime(obj, "completedAt"); err != nil {
		return nil, err
	}

	// Absent prev means birth, which is a legitimate and common shape.
	if r.Prev, err = optionalStrongRef(obj, "prev"); err != nil {
		return nil, err
	}

	return r, nil
}

func decodeAttestation(obj map[string]any) (*Attestation, error) {
	a := &Attestation{Raw: obj}
	var err error

	subject, err := optionalStrongRef(obj, "subject")
	if err != nil {
		return nil, err
	}
	if subject == nil {
		return nil, fmt.Errorf("missing field: subject")
	}
	a.Subject = *subject

	if a.VerifiedAt, err = requireTime(obj, "verifiedAt"); err != nil {
		return nil, err
	}
	// Required on decode, like every other artifact this project writes. A
	// record without one is not ours, whatever collection it arrived in.
	if a.Synthetic, err = requireString(obj, "synthetic"); err != nil {
		return nil, err
	}

	return a, nil
}

func requireString(obj map[string]any, key string) (string, error) {
	v, ok := obj[key]
	if !ok {
		return "", fmt.Errorf("missing field: %s", key)
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("field %s must be a string, got %T", key, v)
	}
	if s == "" {
		return "", fmt.Errorf("field %s must not be empty", key)
	}
	return s, nil
}

func requireBytes(obj map[string]any, key string) ([]byte, error) {
	v, ok := obj[key]
	if !ok {
		return nil, fmt.Errorf("missing field: %s", key)
	}
	switch b := v.(type) {
	case []byte:
		return b, nil
	case atdata.Bytes:
		return []byte(b), nil
	default:
		return nil, fmt.Errorf("field %s must be bytes, got %T", key, v)
	}
}

func requireTime(obj map[string]any, key string) (time.Time, error) {
	s, err := requireString(obj, key)
	if err != nil {
		return time.Time{}, err
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("field %s is not an RFC 3339 datetime: %w", key, err)
	}
	return t.UTC(), nil
}

// optionalStrongRef reads a {uri, cid} reference, returning nil when absent.
func optionalStrongRef(obj map[string]any, key string) (*StrongRef, error) {
	v, ok := obj[key]
	if !ok || v == nil {
		return nil, nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("field %s must be an object, got %T", key, v)
	}
	uri, err := requireString(m, "uri")
	if err != nil {
		return nil, fmt.Errorf("%s.%w", key, err)
	}
	rawCid, ok := m["cid"]
	if !ok {
		return nil, fmt.Errorf("%s.cid is missing", key)
	}
	cidStr, err := cidToString(rawCid)
	if err != nil {
		return nil, fmt.Errorf("%s.cid: %w", key, err)
	}
	return &StrongRef{URI: uri, CID: cidStr}, nil
}

func cidToString(v any) (string, error) {
	switch c := v.(type) {
	case string:
		return c, nil
	case atdata.CIDLink:
		return c.String(), nil
	case fmt.Stringer:
		return c.String(), nil
	default:
		return "", fmt.Errorf("unrecognized CID representation %T", v)
	}
}

func decodeStation(obj map[string]any) (*Station, error) {
	st := &Station{Raw: obj}
	var err error

	if st.DisplayName, err = requireString(obj, "displayName"); err != nil {
		return nil, err
	}
	if st.Kind, err = requireString(obj, "kind"); err != nil {
		return nil, err
	}
	switch st.Kind {
	case "oem", "mro", "operator", "broker", "lessor":
	default:
		return nil, fmt.Errorf("unknown station kind: %q", st.Kind)
	}
	// Every artifact in this demonstration carries the marker, and a profile
	// that does not is not one of ours no matter what collection it sits in.
	if st.Synthetic, err = requireString(obj, "synthetic"); err != nil {
		return nil, err
	}
	if cage, ok := obj["cage"].(string); ok {
		st.CAGE = cage
	}
	if cert, ok := obj["certificate"].(string); ok {
		st.Certificate = cert
	}

	return st, nil
}
