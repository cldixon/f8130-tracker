package ingest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPBaseFromFirehoseHost(t *testing.T) {
	for _, tc := range []struct{ host, want string }{
		// Railway private networking is plain HTTP over IPv6, not TLS.
		{"ws://pds.railway.internal:3000", "http://pds.railway.internal:3000"},
		{"wss://pds.f8130.cldixon.dev", "https://pds.f8130.cldixon.dev"},
		{"http://localhost:3000", "http://localhost:3000"},
		{"wss://example.com/", "https://example.com"},
	} {
		got, err := httpBase(tc.host)
		if err != nil {
			t.Fatalf("%s: %v", tc.host, err)
		}
		if got != tc.want {
			t.Errorf("httpBase(%q) = %q, want %q", tc.host, got, tc.want)
		}
	}
	if _, err := httpBase("ftp://nope"); err == nil {
		t.Error("an unusable scheme should be an error, not a guess")
	}
}

func TestHasProfile(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	if has, err := s.HasProfile(ctx, cascadia); err != nil || has {
		t.Fatalf("a DID nobody has seen: has=%v err=%v", has, err)
	}

	// A row created by publishing a release carries no name.
	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{
		releaseRec("bafyp1", "at://"+cascadia+"/r/1", cascadia,
			"NT882104", "SN000417", "NEW", now, nil),
	}); err != nil {
		t.Fatal(err)
	}
	if has, err := s.HasProfile(ctx, cascadia); err != nil || has {
		t.Fatalf("a row without org_name is not a profile: has=%v err=%v", has, err)
	}

	if err := s.ApplyCommit(ctx, 2, now, []IndexedRecord{
		stationRec("at://"+cascadia+"/dev.cldixon.f8130.station/self", "Cascadia MRO", "mro"),
	}); err != nil {
		t.Fatal(err)
	}
	if has, err := s.HasProfile(ctx, cascadia); err != nil || !has {
		t.Fatalf("after a station record: has=%v err=%v", has, err)
	}
}

// The request budget, which is the part that could go wrong quietly.
//
// An organization that has never published a profile is an ordinary thing to
// be. Asking its server on every commit would turn that into a request per
// record for the life of the process, against a server that will keep saying
// no.
func TestProfileIsAskedForOnceAndNotAgain(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	var asked int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked++
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := &Consumer{Store: s, Host: srv.URL, HTTPClient: srv.Client()}

	for i := 0; i < 3; i++ {
		if rec := c.backfillProfile(ctx, cascadia); rec != nil {
			t.Fatal("a 404 is not a profile")
		}
	}
	if asked != 1 {
		t.Errorf("asked %d times, want 1", asked)
	}
	_ = now
}

// And a repository whose profile is already indexed is never asked at all.
func TestProfileIsNotFetchedWhenAlreadyKnown(t *testing.T) {
	s, ctx := testStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	if err := s.ApplyCommit(ctx, 1, now, []IndexedRecord{
		stationRec("at://"+cascadia+"/dev.cldixon.f8130.station/self", "Cascadia MRO", "mro"),
	}); err != nil {
		t.Fatal(err)
	}

	var asked int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked++
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := &Consumer{Store: s, Host: srv.URL, HTTPClient: srv.Client()}
	if rec := c.backfillProfile(context.Background(), cascadia); rec != nil {
		t.Error("a known profile was fetched again")
	}
	if asked != 0 {
		t.Errorf("asked %d times for a profile already held", asked)
	}
}

// A server that answers with something other than a verifiable proof gets
// nothing indexed. This is the whole reason the sync endpoint is used rather
// than repo.getRecord: the answer has to carry a signature to be believed.
func TestUnverifiableProofIsNotIndexed(t *testing.T) {
	s, ctx := testStore(t)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/vnd.ipld.car")
		_, _ = w.Write([]byte("not a car file, let alone a signed one"))
	}))
	defer srv.Close()

	c := &Consumer{Store: s, Host: srv.URL, HTTPClient: srv.Client()}
	if rec := c.backfillProfile(ctx, cascadia); rec != nil {
		t.Error("an unsigned answer was accepted as a profile")
	}
}
