package ingest

import (
	"context"
	"os"
	"testing"
	"time"
)

// These run against a real PostgreSQL instance. Set F8130_TEST_DSN to enable
// them; without it they skip, so the suite stays runnable anywhere.
//
// A fake would be worse than useless here. The behaviour worth testing is the
// recursive chain walk, the transactional cursor advance, and the deliberate
// absence of foreign keys — all of which are properties of the database, not of
// the Go code wrapping it.

func testStore(t *testing.T) (*Store, context.Context) {
	t.Helper()
	dsn := os.Getenv("F8130_TEST_DSN")
	if dsn == "" {
		t.Skip("F8130_TEST_DSN not set; skipping database tests")
	}
	ctx := context.Background()
	s, err := Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(s.Close)
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := s.Reset(ctx); err != nil {
		t.Fatalf("reset: %v", err)
	}
	return s, ctx
}

var (
	northwind = "did:plc:nw7hd3kq2xr5mabcdefghijk"
	cascadia  = "did:plc:cs4gk2mp7yv6nbcdefghijkl"
	exampleA  = "did:plc:exa1r2t3u4v5wbcdefghijkn"
	southpt   = "did:plc:sp6x7y8z9a0bcbcdefghijkp"
	meridian  = "did:plc:mr5jq8tn3wz7pbcdefghijkm"
)

// The `status` parameter is retained because the callers read as maintenance
// history — but Block 11 no longer reaches the public record, so it survives
// only inside Raw, where an AppView keeps the bytes it was actually given.
func releaseRec(cid, uri, issuer, part, serial, status string, completed time.Time, prev *StrongRef) IndexedRecord {
	return IndexedRecord{
		URI:        uri,
		CID:        cid,
		Collection: ReleaseNSID,
		Release: &Release{
			Commitment:          make([]byte, 32),
			IssuerDID:           issuer,
			Prev:                prev,
			ApprovingAuthority:  "FAA/United States",
			FormNumber:          "SYNTHETIC81300001",
			OrganizationName:    "Cascadia MRO",
			OrganizationAddress: "4400 Airport Way, Everett, WA 98204",
			Description:         "Fuel control unit",
			PartNumber:          part,
			SerialNumber:        serial,
			SignerCert:          "SYNTHETICCERT12345",
			CompletedAt:         completed,
			Raw:                 map[string]any{"$type": ReleaseNSID, "status": status},
		},
	}
}

func acceptanceRec(cid, uri, issuer, verifier, outcome string) IndexedRecord {
	return IndexedRecord{
		URI:        uri,
		CID:        cid,
		Collection: AcceptanceNSID,
		Acceptance: &Acceptance{
			Subject:      StrongRef{URI: "at://" + issuer + "/x/y", CID: "bafysubject"},
			IssuerDID:    issuer,
			VerifierDID:  verifier,
			PartNumber:   "NT882104",
			SerialNumber: "SN000417",
			Outcome:      outcome,
			ReceivedAt:   time.Now().UTC().Truncate(time.Second),
			Raw:          map[string]any{"$type": AcceptanceNSID, "outcome": outcome},
		},
	}
}

func disputeRec(cid, uri, subjectCID string) IndexedRecord {
	return IndexedRecord{
		URI:        uri,
		CID:        cid,
		Collection: DisputeNSID,
		Dispute: &Dispute{
			Subject:    StrongRef{URI: "at://did:plc:op/x/y", CID: subjectCID},
			Response:   "Back-to-birth records were supplied at time of sale.",
			DisputedAt: time.Now().UTC().Truncate(time.Second),
			Raw:        map[string]any{"$type": DisputeNSID},
		},
	}
}

// An issuer cannot remove a verdict against them. Indexing the reply is what
// makes that limit visible in the thread instead of merely true underneath it.
func TestApplyCommitStoresDispute(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	acc := acceptanceRec("bafyacc", "at://"+cascadia+"/a/1", northwind, cascadia, "rejected")
	dis := disputeRec("bafydis", "at://"+northwind+"/d/1", "bafyacc")

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{acc, dis}); err != nil {
		t.Fatal(err)
	}

	var (
		author   string
		response string
		subject  string
	)
	err := s.pool.QueryRow(ctx,
		`SELECT author_did, response, subject_cid FROM dispute WHERE cid = $1`,
		"bafydis",
	).Scan(&author, &response, &subject)
	if err != nil {
		t.Fatal(err)
	}

	// The author is the repository it was found in, not a field it claimed.
	if author != northwind {
		t.Errorf("author = %q, want %q", author, northwind)
	}
	if subject != "bafyacc" {
		t.Errorf("subject = %q, want the acceptance it answers", subject)
	}
	if response == "" {
		t.Error("response did not store")
	}
}

func TestDeleteRemovesDispute(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	uri := "at://" + northwind + "/d/2"

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{
		disputeRec("bafydel", uri, "bafyacc"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyCommit(ctx, 2, now, []IndexedRecord{
		{URI: uri, Collection: DisputeNSID, Deleted: true},
	}); err != nil {
		t.Fatal(err)
	}

	var n int
	if err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM dispute WHERE uri = $1`, uri).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Error("dispute should be gone")
	}
}

func stationRec(uri, name, kind string) IndexedRecord {
	return IndexedRecord{
		URI:        uri,
		CID:        "bafystation" + kind,
		Collection: StationNSID,
		Station: &Station{
			DisplayName: name,
			Kind:        kind,
			Synthetic:   "SYNTHETIC DEMONSTRATION DATA",
			CAGE:        "SYN0005",
			Certificate: "SYNTHETIC-CERT-12345",
			Raw:         map[string]any{"$type": StationNSID},
		},
	}
}

// Without this the actor row holds the DID twice over and every verdict in the
// feed renders as a bare identifier: a release carries Block 4 and can name
// its issuer, but an acceptance carries no name for either party.
func TestStationRecordNamesAnActor(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{
		stationRec("at://"+cascadia+"/dev.cldixon.f8130.station/self", "Cascadia MRO", "mro"),
	}); err != nil {
		t.Fatal(err)
	}

	var name, kind string
	if err := s.pool.QueryRow(ctx,
		`SELECT org_name, kind FROM actor WHERE did = $1`, cascadia,
	).Scan(&name, &kind); err != nil {
		t.Fatal(err)
	}
	if name != "Cascadia MRO" || kind != "mro" {
		t.Errorf("actor = %q/%q", name, kind)
	}
}

// A lessor would have failed the kind check before station records were
// indexed, because nothing had ever written the column.
func TestLessorProfileStores(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{
		stationRec("at://"+meridian+"/dev.cldixon.f8130.station/self", "Halyard Leasing", "lessor"),
	}); err != nil {
		t.Fatalf("a lessor profile should store: %v", err)
	}
}

// The profile is the organization's current statement about itself, so a
// later one supersedes an earlier one rather than being ignored.
func TestStationProfileIsSuperseded(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	uri := "at://" + cascadia + "/dev.cldixon.f8130.station/self"

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{
		stationRec(uri, "Old Name", "mro"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyCommit(ctx, 2, now, []IndexedRecord{
		stationRec(uri, "Cascadia MRO", "mro"),
	}); err != nil {
		t.Fatal(err)
	}

	var name string
	if err := s.pool.QueryRow(ctx,
		`SELECT org_name FROM actor WHERE did = $1`, cascadia).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Cascadia MRO" {
		t.Errorf("org_name = %q, want the newer profile", name)
	}
}

// A profile arriving after the organization has already published a release
// must fill in the row ensureActor created, not collide with it.
func TestStationFillsInAnExistingActor(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{
		releaseRec("bafyfirst", "at://"+cascadia+"/r/1", cascadia,
			"NT882104", "SN000417", "NEW", now, nil),
		stationRec("at://"+cascadia+"/dev.cldixon.f8130.station/self", "Cascadia MRO", "mro"),
	}); err != nil {
		t.Fatal(err)
	}

	var name string
	if err := s.pool.QueryRow(ctx,
		`SELECT org_name FROM actor WHERE did = $1`, cascadia).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "Cascadia MRO" {
		t.Errorf("org_name = %q", name)
	}
}

func TestCursorStartsUnset(t *testing.T) {
	s, ctx := testStore(t)
	seq, err := s.Cursor(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if seq != -1 {
		t.Errorf("expected -1 for a fresh index, got %d", seq)
	}
}

func TestApplyCommitAdvancesCursor(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	rec := releaseRec("bafybirth", "at://"+northwind+"/r/1", northwind,
		"NT882104", "SN000417", "NEW", now, nil)

	if err := s.ApplyCommit(ctx, 42, now, []IndexedRecord{rec}); err != nil {
		t.Fatal(err)
	}

	seq, err := s.Cursor(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if seq != 42 {
		t.Errorf("cursor: got %d, want 42", seq)
	}
}

func TestCursorAdvancesOnEmptyCommit(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC()

	// A commit carrying nothing of ours must still move the cursor, or a quiet
	// stretch of unrelated traffic gets replayed on every reconnect.
	if err := s.ApplyCommit(ctx, 7, now, nil); err != nil {
		t.Fatal(err)
	}
	seq, _ := s.Cursor(ctx)
	if seq != 7 {
		t.Errorf("cursor: got %d, want 7", seq)
	}
}

func TestObservedAtIsNotMovedByReingestion(t *testing.T) {
	s, ctx := testStore(t)
	first := time.Date(2026, 1, 22, 9, 30, 0, 0, time.UTC)
	later := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

	rec := releaseRec("bafyonce", "at://"+cascadia+"/r/1", cascadia,
		"NT882104", "SN000417", "OVERHAULED", first, nil)

	if err := s.ApplyCommit(ctx, 1, first, []IndexedRecord{rec}); err != nil {
		t.Fatal(err)
	}
	// Replay the same record much later, as a reconnect or reindex would.
	if err := s.ApplyCommit(ctx, 2, later, []IndexedRecord{rec}); err != nil {
		t.Fatal(err)
	}

	chain, err := s.Chain(ctx, "bafyonce", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 1 {
		t.Fatalf("expected 1 link, got %d", len(chain))
	}
	if !chain[0].ObservedAt.Equal(first) {
		t.Errorf("observed_at moved: got %s, want %s", chain[0].ObservedAt, first)
	}
}

func TestChainWalksBackToBirth(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	birthURI := "at://" + northwind + "/r/birth"
	birth := releaseRec("bafybirth", birthURI, northwind,
		"NT882104", "SN000417", "NEW", now.Add(-72*time.Hour), nil)
	overhaul := releaseRec("bafyoverhaul", "at://"+cascadia+"/r/oh", cascadia,
		"NT882104", "SN000417", "OVERHAULED", now,
		&StrongRef{URI: birthURI, CID: "bafybirth"})

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{birth, overhaul}); err != nil {
		t.Fatal(err)
	}

	chain, err := s.Chain(ctx, "bafyoverhaul", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 2 {
		t.Fatalf("expected 2 links, got %d", len(chain))
	}
	if chain[0].CID != "bafyoverhaul" || chain[1].CID != "bafybirth" {
		t.Errorf("wrong order: %s then %s", chain[0].CID, chain[1].CID)
	}
	if chain[1].PrevCID != nil {
		t.Error("birth record should have no predecessor")
	}
	if chain[0].IssuerDID == chain[1].IssuerDID {
		t.Error("the chain should cross an organizational boundary")
	}
}

func TestChainReportsAGapRatherThanFailing(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	// An orphan: it references a predecessor that was never published. There is
	// no foreign key, so this inserts cleanly and the gap shows up as a chain
	// that stops short — which is the fact a buyer needs, not an error.
	orphan := releaseRec("bafyorphan", "at://"+cascadia+"/r/orphan", cascadia,
		"NT882104", "SN000417", "OVERHAULED", now,
		&StrongRef{URI: "at://" + northwind + "/r/missing", CID: "bafymissing"})

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{orphan}); err != nil {
		t.Fatalf("a dangling prev must not be an integrity error: %v", err)
	}

	chain, err := s.Chain(ctx, "bafyorphan", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 1 {
		t.Fatalf("expected the chain to stop at 1 link, got %d", len(chain))
	}
	if chain[0].PrevCID == nil || *chain[0].PrevCID != "bafymissing" {
		t.Error("the unresolved predecessor should still be visible on the row")
	}
}

func TestChainRespectsDepthLimit(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	var recs []IndexedRecord
	var prev *StrongRef
	for i := 0; i < 10; i++ {
		cid := "bafylink" + string(rune('a'+i))
		uri := "at://" + cascadia + "/r/" + string(rune('a'+i))
		recs = append(recs, releaseRec(cid, uri, cascadia,
			"NT882104", "SN000417", "REPAIRED", now, prev))
		prev = &StrongRef{URI: uri, CID: cid}
	}
	if err := s.ApplyCommit(ctx, 1, now, recs); err != nil {
		t.Fatal(err)
	}

	chain, err := s.Chain(ctx, "bafylinkj", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 3 {
		t.Errorf("depth limit not honoured: got %d links, want 3", len(chain))
	}
}

func TestAcceptanceMayArriveBeforeItsRelease(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC()

	// Firehose ordering across repositories is not guaranteed, so a verdict can
	// legitimately land before the release it judges. No foreign key means this
	// simply stores.
	acc := acceptanceRec("bafyacc", "at://"+exampleA+"/a/1", meridian, exampleA, "rejected")
	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{acc}); err != nil {
		t.Fatalf("an early acceptance must not be an integrity error: %v", err)
	}
}

func TestIssuerRejectionsCountDistinctOperators(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC()

	recs := []IndexedRecord{
		acceptanceRec("bafy1", "at://"+exampleA+"/a/1", meridian, exampleA, "rejected"),
		// The same operator rejecting twice is still one independent voice.
		acceptanceRec("bafy2", "at://"+exampleA+"/a/2", meridian, exampleA, "rejected"),
		acceptanceRec("bafy3", "at://"+southpt+"/a/1", meridian, southpt, "rejected"),
		// An acceptance is not a rejection.
		acceptanceRec("bafy4", "at://"+exampleA+"/a/3", cascadia, exampleA, "accepted"),
	}
	if err := s.ApplyCommit(ctx, 1, now, recs); err != nil {
		t.Fatal(err)
	}

	scores, err := s.IssuerRejections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if scores[meridian] != 2 {
		t.Errorf("meridian: got %d distinct rejectors, want 2", scores[meridian])
	}
	if _, ok := scores[cascadia]; ok {
		t.Error("cascadia has no rejections and should not be scored")
	}
}

func TestResetMakesTheIndexRebuildable(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	rec := releaseRec("bafybirth", "at://"+northwind+"/r/1", northwind,
		"NT882104", "SN000417", "NEW", now, nil)
	if err := s.ApplyCommit(ctx, 99, now, []IndexedRecord{rec}); err != nil {
		t.Fatal(err)
	}

	if err := s.Reset(ctx); err != nil {
		t.Fatal(err)
	}

	seq, err := s.Cursor(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if seq != -1 {
		t.Errorf("cursor should be forgotten after reset, got %d", seq)
	}
	chain, err := s.Chain(ctx, "bafybirth", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 0 {
		t.Errorf("expected an empty index after reset, got %d rows", len(chain))
	}

	// ...and replaying the same commit reproduces it exactly.
	if err := s.ApplyCommit(ctx, 99, now, []IndexedRecord{rec}); err != nil {
		t.Fatal(err)
	}
	chain, _ = s.Chain(ctx, "bafybirth", 10)
	if len(chain) != 1 {
		t.Errorf("replay did not rebuild the row")
	}
}

// Reset has to survive a schema change, not just stale rows.
//
// Truncating leaves yesterday's columns in place, so after a field set change
// every insert fails on a column that no longer exists or a NOT NULL nobody
// writes any more. This is that situation in miniature: mutate the table out
// from under the code, reset, and check the index works again.
func TestResetRecoversFromAStaleSchema(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	// Make the live table disagree with schema.sql the way a field set change
	// does: a column the code writes is gone, and one it never writes is
	// mandatory.
	if _, err := s.pool.Exec(ctx, `ALTER TABLE release DROP COLUMN description`); err != nil {
		t.Fatalf("drop column: %v", err)
	}
	if _, err := s.pool.Exec(ctx,
		`ALTER TABLE release ADD COLUMN legacy_status TEXT NOT NULL DEFAULT ''`,
	); err != nil {
		t.Fatalf("add column: %v", err)
	}

	rec := releaseRec("bafystale", "at://"+northwind+"/r/1", northwind,
		"NT882104", "SN000417", "NEW", now, nil)

	// Sanity: the stale shape really does break writes. If this ever stops
	// failing, the test below is proving nothing.
	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{rec}); err == nil {
		t.Fatal("expected the stale schema to reject the insert")
	}

	if err := s.Reset(ctx); err != nil {
		t.Fatalf("reset: %v", err)
	}

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{rec}); err != nil {
		t.Fatalf("insert after reset: %v", err)
	}
	chain, err := s.Chain(ctx, "bafystale", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != 1 {
		t.Errorf("expected the row back after reset, got %d", len(chain))
	}
}

func TestDeleteRemovesARecord(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	uri := "at://" + cascadia + "/r/1"

	rec := releaseRec("bafygone", uri, cascadia, "NT882104", "SN000417", "REPAIRED", now, nil)
	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{rec}); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyCommit(ctx, 2, now, []IndexedRecord{
		{URI: uri, Collection: ReleaseNSID, Deleted: true},
	}); err != nil {
		t.Fatal(err)
	}

	chain, _ := s.Chain(ctx, "bafygone", 10)
	if len(chain) != 0 {
		t.Error("record should be gone")
	}
}
