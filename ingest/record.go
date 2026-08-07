package ingest

import (
	"fmt"
	"time"

	"github.com/bluesky-social/indigo/atproto/atdata"
)

const (
	ReleaseNSID    = "dev.cldixon.f8130.release"
	AcceptanceNSID = "dev.cldixon.f8130.acceptance"
	DisputeNSID    = "dev.cldixon.f8130.dispute"
)

// StrongRef is an atproto strong reference: a location plus the content hash
// of what was there when the reference was made.
type StrongRef struct {
	URI string
	CID string
}

// Release is a decoded release record.
type Release struct {
	Commitment   []byte
	IssuerDID    string
	Prev         *StrongRef
	FormNumber   string
	PartNumber   string
	SerialNumber string
	Status       string
	SignerCert   string
	CompletedAt  time.Time
	Raw          map[string]any
}

// Acceptance is a decoded acceptance record.
type Acceptance struct {
	Subject      StrongRef
	IssuerDID    string
	VerifierDID  string
	PartNumber   string
	SerialNumber string
	Outcome      string
	Note         string
	ReceivedAt   time.Time
	Raw          map[string]any
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
	case AcceptanceNSID:
		return decodeAcceptance(obj)
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
	if r.FormNumber, err = requireString(obj, "formNumber"); err != nil {
		return nil, err
	}
	if r.PartNumber, err = requireString(obj, "partNumber"); err != nil {
		return nil, err
	}
	if r.SerialNumber, err = requireString(obj, "serialNumber"); err != nil {
		return nil, err
	}
	if r.Status, err = requireString(obj, "status"); err != nil {
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

func decodeAcceptance(obj map[string]any) (*Acceptance, error) {
	a := &Acceptance{Raw: obj}
	var err error

	subject, err := optionalStrongRef(obj, "subject")
	if err != nil {
		return nil, err
	}
	if subject == nil {
		return nil, fmt.Errorf("missing field: subject")
	}
	a.Subject = *subject

	if a.IssuerDID, err = requireString(obj, "issuerDid"); err != nil {
		return nil, err
	}
	if a.VerifierDID, err = requireString(obj, "verifierDid"); err != nil {
		return nil, err
	}
	if a.PartNumber, err = requireString(obj, "partNumber"); err != nil {
		return nil, err
	}
	if a.SerialNumber, err = requireString(obj, "serialNumber"); err != nil {
		return nil, err
	}
	if a.Outcome, err = requireString(obj, "outcome"); err != nil {
		return nil, err
	}
	switch a.Outcome {
	case "accepted", "rejected", "discrepancy":
	default:
		return nil, fmt.Errorf("unknown outcome: %q", a.Outcome)
	}
	if a.ReceivedAt, err = requireTime(obj, "receivedAt"); err != nil {
		return nil, err
	}
	if note, ok := obj["note"].(string); ok {
		a.Note = note
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
