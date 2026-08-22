package ingest

import (
	"net/url"
	"testing"
)

// cursorParam pulls the cursor query parameter back out of a built URL, so the
// tests assert on what the server actually receives rather than on string
// formatting.
func cursorParam(t *testing.T, host string, cursor int64) string {
	t.Helper()
	raw, err := subscribeURL(host, cursor)
	if err != nil {
		t.Fatalf("subscribeURL(%q, %d): %v", host, cursor, err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	if !u.Query().Has("cursor") {
		t.Fatalf("no cursor in %q; omitting it live-tails and silently skips history", raw)
	}
	return u.Query().Get("cursor")
}

// The regression this file exists for.
//
// The cursor is exclusive: the server replays events with a seq greater than
// the value sent. Sending last+1 therefore names an event that does not exist
// once the index has caught up, and the server closes the connection with
// `1008 (policy violation): FutureCursor`. Because the consumer reconnects
// with backoff, that is not a crash — it is a service that stays green,
// reconnects every 30 seconds forever, and indexes nothing ever again. Both
// AppViews ran that way in production for two weeks.
func TestCursorIsTheLastAppliedSeqNotTheNextOne(t *testing.T) {
	if got := cursorParam(t, "ws://pds.railway.internal:3000", 90); got != "90" {
		t.Fatalf("cursor = %s, want 90 (the last seq applied). "+
			"91 asks for an event the server has not sequenced yet and is "+
			"rejected as FutureCursor on every reconnect.", got)
	}
}

// Seq 0 is a real event, and int64 zero is not the same as "no cursor stored".
// Store.Cursor signals the empty index with -1 precisely so this case stays
// distinguishable.
func TestSeqZeroIsAppliedNotTreatedAsUnset(t *testing.T) {
	if got := cursorParam(t, "ws://pds.railway.internal:3000", 0); got != "0" {
		t.Fatalf("cursor = %s, want 0", got)
	}
}

// A fresh index backfills the whole log rather than tailing live, so a second
// AppView can join late and still see everything.
func TestFreshIndexBackfillsFromTheStart(t *testing.T) {
	if got := cursorParam(t, "wss://f8130.cldixon.dev", -1); got != "0" {
		t.Fatalf("cursor = %s, want 0 for an unset cursor", got)
	}
}

func TestSubscribeURLTargetsTheFirehoseEndpoint(t *testing.T) {
	raw, err := subscribeURL("ws://pds.railway.internal:3000", 12)
	if err != nil {
		t.Fatal(err)
	}
	want := "ws://pds.railway.internal:3000/xrpc/com.atproto.sync.subscribeRepos?cursor=12"
	if raw != want {
		t.Fatalf("subscribeURL = %q, want %q", raw, want)
	}
}

// Railway private networking is plain ws over IPv6; the public firehose is
// wss. Both must survive URL construction with their scheme and host intact.
func TestSubscribeURLPreservesSchemeAndHost(t *testing.T) {
	for _, host := range []string{
		"ws://pds.railway.internal:3000",
		"wss://f8130.cldixon.dev",
	} {
		raw, err := subscribeURL(host, 5)
		if err != nil {
			t.Fatalf("subscribeURL(%q): %v", host, err)
		}
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		orig, _ := url.Parse(host)
		if u.Scheme != orig.Scheme || u.Host != orig.Host {
			t.Fatalf("subscribeURL(%q) = %q; scheme/host changed", host, raw)
		}
	}
}

func TestSubscribeURLRejectsAnUnparseableHost(t *testing.T) {
	if _, err := subscribeURL("ht tp://nope", 1); err == nil {
		t.Fatal("expected an error for a malformed host")
	}
}
