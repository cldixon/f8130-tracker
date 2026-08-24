package ingest

import (
	"errors"
	"testing"

	"github.com/bluesky-social/indigo/atproto/atdata"
)

// Record bytes are written by whoever operates the repository, which in this
// design is explicitly not us. Every one of these cases is input an ingest
// service on a public network would eventually be handed, and the required
// behaviour is always the same: refuse the record, keep the stream running.

func encode(t *testing.T, obj map[string]any) []byte {
	t.Helper()
	b, err := atdata.MarshalCBOR(obj)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func validRelease() map[string]any {
	return map[string]any{
		"$type":               ReleaseNSID,
		"commitment":          atdata.Bytes(make([]byte, 32)),
		"issuerDid":           "did:plc:cs4gk2mp7yv6nbcdefghijkl",
		"approvingAuthority":  "FAA/United States",
		"formNumber":          "SYNTHETIC81300002",
		"organizationName":    "Cascadia MRO",
		"organizationAddress": "4400 Airport Way, Everett, WA 98204",
		"description":         "Fuel control unit",
		"partNumber":          "NT882104",
		"serialNumber":        "SN000417",
		"signerCert":          "SYNTHETICCERT12345",
		"completedAt":         "2026-01-22T09:30:00Z",
	}
}

func TestDecodeValidRelease(t *testing.T) {
	r, err := DecodeRecord(ReleaseNSID, encode(t, validRelease()))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	rel, ok := r.(*Release)
	if !ok {
		t.Fatalf("wrong type: %T", r)
	}
	if rel.PartNumber != "NT882104" || rel.OrganizationName != "Cascadia MRO" {
		t.Errorf("fields not decoded: %+v", rel)
	}
	if len(rel.Commitment) != 32 {
		t.Errorf("commitment: got %d bytes, want 32", len(rel.Commitment))
	}
	if rel.Prev != nil {
		t.Error("a record with no prev is birth and should decode as such")
	}
	if rel.CompletedAt.Year() != 2026 {
		t.Errorf("completedAt not parsed: %v", rel.CompletedAt)
	}
}

func TestDecodeIgnoresOtherCollections(t *testing.T) {
	// The firehose carries everyone's data. Someone else's post is an ordinary
	// event, not an error.
	_, err := DecodeRecord("app.bsky.feed.post", encode(t, map[string]any{
		"$type": "app.bsky.feed.post",
		"text":  "hello",
	}))
	if !errors.Is(err, ErrNotOurs) {
		t.Errorf("expected ErrNotOurs, got %v", err)
	}
}

func TestDecodeRejectsMalformedReleases(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"missing commitment", func(m map[string]any) { delete(m, "commitment") }},
		{"missing issuerDid", func(m map[string]any) { delete(m, "issuerDid") }},
		{"missing partNumber", func(m map[string]any) { delete(m, "partNumber") }},
		{"missing completedAt", func(m map[string]any) { delete(m, "completedAt") }},
		{"empty serialNumber", func(m map[string]any) { m["serialNumber"] = "" }},
		{"commitment too short", func(m map[string]any) {
			m["commitment"] = atdata.Bytes(make([]byte, 16))
		}},
		{"commitment not bytes", func(m map[string]any) { m["commitment"] = "not bytes" }},
		{"missing organizationName", func(m map[string]any) { delete(m, "organizationName") }},
		{"missing organizationAddress", func(m map[string]any) {
			delete(m, "organizationAddress")
		}},
		{"missing approvingAuthority", func(m map[string]any) {
			delete(m, "approvingAuthority")
		}},
		{"description not a string", func(m map[string]any) { m["description"] = int64(3) }},
		{"completedAt not a datetime", func(m map[string]any) { m["completedAt"] = "yesterday" }},
		{"prev is not an object", func(m map[string]any) { m["prev"] = "at://something" }},
		{"prev missing cid", func(m map[string]any) {
			m["prev"] = map[string]any{"uri": "at://x/y/z"}
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			obj := validRelease()
			tc.mutate(obj)
			if _, err := DecodeRecord(ReleaseNSID, encode(t, obj)); err == nil {
				t.Error("expected an error, got none")
			}
		})
	}
}

func TestDecodeRejectsGarbageBytes(t *testing.T) {
	if _, err := DecodeRecord(ReleaseNSID, []byte{0xde, 0xad, 0xbe, 0xef}); err == nil {
		t.Error("expected an error decoding non-CBOR input")
	}
}

func TestDecodeAttestation(t *testing.T) {
	obj := map[string]any{
		"$type": AttestationNSID,
		"subject": map[string]any{
			"uri": "at://did:plc:cs4gk2mp7yv6nbcdefghijkl/dev.cldixon.f8130.release/3abc",
			"cid": "bafyreiabc",
		},
		"verifiedAt": "2026-02-01T12:00:00Z",
		"synthetic":  "SYNTHETIC DEMONSTRATION DATA",
	}

	r, err := DecodeRecord(AttestationNSID, encode(t, obj))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	a, ok := r.(*Attestation)
	if !ok {
		t.Fatalf("wrong type: %T", r)
	}
	if a.Subject.CID != "bafyreiabc" {
		t.Errorf("subject cid: got %q", a.Subject.CID)
	}
	if a.VerifiedAt.IsZero() {
		t.Error("verifiedAt did not decode")
	}
}

// An attestation with no subject vouches for nothing and would index as a
// statement about nowhere. Better to drop it than to store a dangling one.
func TestDecodeAttestationRequiresSubject(t *testing.T) {
	obj := map[string]any{
		"$type":      AttestationNSID,
		"verifiedAt": "2026-02-01T12:00:00Z",
		"synthetic":  "SYNTHETIC DEMONSTRATION DATA",
	}
	if _, err := DecodeRecord(AttestationNSID, encode(t, obj)); err == nil {
		t.Fatal("want error for an attestation with no subject")
	}
}

// Every artifact this project writes carries the marker. One without it is not
// ours, whatever collection it arrived in.
func TestDecodeAttestationRequiresMarker(t *testing.T) {
	obj := map[string]any{
		"$type":      AttestationNSID,
		"subject":    map[string]any{"uri": "at://x/y/z", "cid": "bafyreiabc"},
		"verifiedAt": "2026-02-01T12:00:00Z",
	}
	if _, err := DecodeRecord(AttestationNSID, encode(t, obj)); err == nil {
		t.Fatal("want error for an attestation with no synthetic marker")
	}
}

func TestDecodeReleaseWithPrev(t *testing.T) {
	obj := validRelease()
	obj["prev"] = map[string]any{
		"uri": "at://did:plc:nw7hd3kq2xr5mabcdefghijk/dev.cldixon.f8130.release/3xyz",
		"cid": "bafyreibirth",
	}

	r, err := DecodeRecord(ReleaseNSID, encode(t, obj))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	rel := r.(*Release)
	if rel.Prev == nil {
		t.Fatal("prev not decoded")
	}
	if rel.Prev.CID != "bafyreibirth" {
		t.Errorf("prev cid: got %q", rel.Prev.CID)
	}
	if rel.Prev.URI == "" {
		t.Error("prev uri missing — a bare CID cannot be located")
	}
}

func TestAuthorOf(t *testing.T) {
	for _, tc := range []struct{ uri, want string }{
		{"at://did:plc:abc/dev.cldixon.f8130.attestation/3k", "did:plc:abc"},
		{"nonsense", ""},
	} {
		if got := authorOf(tc.uri); got != tc.want {
			t.Errorf("authorOf(%q) = %q, want %q", tc.uri, got, tc.want)
		}
	}
}

func TestDecodeStation(t *testing.T) {
	obj := map[string]any{
		"$type":       StationNSID,
		"displayName": "Cascadia MRO",
		"kind":        "mro",
		"synthetic":   "SYNTHETIC DEMONSTRATION DATA",
		"cage":        "SYN0005",
		"certificate": "SYNTHETIC-CERT-12345",
	}
	r, err := DecodeRecord(StationNSID, encode(t, obj))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	st, ok := r.(*Station)
	if !ok {
		t.Fatalf("got %T, want *Station", r)
	}
	if st.DisplayName != "Cascadia MRO" || st.Kind != "mro" {
		t.Errorf("decoded %+v", st)
	}
	if st.Certificate != "SYNTHETIC-CERT-12345" {
		t.Errorf("certificate = %q", st.Certificate)
	}
}

// Lessors are on the roster and were not in the original kind list. Nothing
// noticed for as long as nothing wrote the column.
func TestDecodeStationAcceptsEveryRosterKind(t *testing.T) {
	for _, kind := range []string{"oem", "mro", "operator", "broker", "lessor"} {
		obj := map[string]any{
			"$type":       StationNSID,
			"displayName": "Some Organization",
			"kind":        kind,
			"synthetic":   "SYNTHETIC DEMONSTRATION DATA",
		}
		if _, err := DecodeRecord(StationNSID, encode(t, obj)); err != nil {
			t.Errorf("kind %q rejected: %v", kind, err)
		}
	}
}

func TestDecodeStationRejectsUnknownKind(t *testing.T) {
	obj := map[string]any{
		"$type":       StationNSID,
		"displayName": "Some Organization",
		"kind":        "airline",
		"synthetic":   "SYNTHETIC DEMONSTRATION DATA",
	}
	if _, err := DecodeRecord(StationNSID, encode(t, obj)); err == nil {
		t.Fatal("want an error for an unknown kind")
	}
}

// Every artifact in this demonstration carries the marker, and a profile
// without one is not ours whatever collection it arrived in.
func TestDecodeStationRequiresTheSyntheticMarker(t *testing.T) {
	obj := map[string]any{
		"$type":       StationNSID,
		"displayName": "Some Organization",
		"kind":        "mro",
	}
	if _, err := DecodeRecord(StationNSID, encode(t, obj)); err == nil {
		t.Fatal("want an error for a profile with no synthetic marker")
	}
}
