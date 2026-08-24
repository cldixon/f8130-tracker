package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	comatproto "github.com/bluesky-social/indigo/api/atproto"
	"github.com/bluesky-social/indigo/atproto/identity"
	atrepo "github.com/bluesky-social/indigo/atproto/repo"
	"github.com/bluesky-social/indigo/atproto/syntax"
	"github.com/bluesky-social/indigo/events"
	"github.com/bluesky-social/indigo/events/schedulers/sequential"
	"github.com/gorilla/websocket"
)

// Consumer subscribes to a PDS firehose and maintains the derived index.
//
// It takes the canonical CBOR path — com.atproto.sync.subscribeRepos — rather
// than a convenience JSON feed, because it verifies every commit signature
// itself. That independent verification is the entire notary role: an observer
// that trusted the server's word about what the server published would be
// witnessing nothing.
type Consumer struct {
	Store     *Store
	Directory identity.Directory
	Logger    *slog.Logger

	// Host is the PDS origin, e.g. ws://pds.railway.internal:3000 for Railway
	// private networking (which is plain HTTP over IPv6, not TLS) or
	// wss://pds.f8130.cldixon.dev over the public internet.
	Host string

	// Now is injectable so tests can pin the notary timestamp.
	Now func() time.Time

	// HTTPClient fetches proofs for records the firehose will not replay.
	// Injectable so a test can answer without a server.
	HTTPClient *http.Client

	// Repositories already asked for a profile, so one that has never
	// published a station record is asked once per process and not once per
	// commit. Absence is the common case for an organization that simply has
	// no profile, and it is not worth a request each time it publishes.
	askedForProfile map[string]bool
}

func (c *Consumer) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: 15 * time.Second}
}

func (c *Consumer) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func (c *Consumer) logger() *slog.Logger {
	if c.Logger != nil {
		return c.Logger
	}
	return slog.Default()
}

// Run consumes the firehose until the context is cancelled, reconnecting with
// backoff and resuming from the stored cursor.
func (c *Consumer) Run(ctx context.Context) error {
	backoff := time.Second
	const maxBackoff = 30 * time.Second

	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		err := c.connectAndConsume(ctx)
		if err == nil || errors.Is(err, context.Canceled) {
			return nil
		}

		c.logger().Warn("firehose disconnected, retrying",
			"error", err, "backoff", backoff)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}

		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// subscribeURL builds the firehose subscription URL for a stored cursor.
//
// The cursor parameter is *exclusive and already means "the last event I
// have"* — the server replays everything with a greater sequence number. So
// the value to send is the last seq durably applied, not the next one we hope
// to see. Sending last+1 works right up until the index is fully caught up,
// at which point it names an event the server has not sequenced yet and the
// connection is closed with `1008 FutureCursor` on every attempt — a consumer
// that reconnects forever and indexes nothing new.
//
// Re-sending the last applied seq is safe even if a server were to treat the
// cursor as inclusive: ApplyCommit upserts, so replaying the final event is a
// no-op.
func subscribeURL(host string, cursor int64) (string, error) {
	u, err := url.Parse(host)
	if err != nil {
		return "", fmt.Errorf("bad host %q: %w", host, err)
	}
	u.Path = "/xrpc/com.atproto.sync.subscribeRepos"
	q := u.Query()
	if cursor >= 0 {
		q.Set("cursor", fmt.Sprintf("%d", cursor))
	} else {
		// A brand new index backfills from the start of the log rather than
		// tailing live. Omitting the cursor entirely would silently skip
		// everything published before this observer happened to start, which
		// for a second AppView joining later means an index that is empty and
		// looks correct. Catching up on history without needing anyone's
		// cooperation is the point.
		q.Set("cursor", "0")
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (c *Consumer) connectAndConsume(ctx context.Context) error {
	cursor, err := c.Store.Cursor(ctx)
	if err != nil {
		return fmt.Errorf("read cursor: %w", err)
	}

	target, err := subscribeURL(c.Host, cursor)
	if err != nil {
		return err
	}

	c.logger().Info("connecting to firehose", "url", target, "cursor", cursor)

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, target, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	callbacks := &events.RepoStreamCallbacks{
		RepoCommit: func(evt *comatproto.SyncSubscribeRepos_Commit) error {
			return c.handleCommit(ctx, evt)
		},
	}

	sched := sequential.NewScheduler("f8130-ingest", callbacks.EventHandler)
	return events.HandleRepoStream(ctx, conn, sched, c.logger())
}

// handleCommit verifies one commit and indexes any f8130 records it carries.
//
// A commit that fails verification is logged and skipped rather than fatal.
// This is a public-network consumer in spirit: crashing on input written by
// someone else hands them a denial of service, and the correct response to an
// unverifiable commit is simply not to believe it.
func (c *Consumer) handleCommit(ctx context.Context, evt *comatproto.SyncSubscribeRepos_Commit) error {
	log := c.logger().With("did", evt.Repo, "seq", evt.Seq)

	if err := atrepo.VerifyCommitSignature(ctx, c.Directory, evt); err != nil {
		log.Warn("commit signature did not verify; skipping", "error", err)
		return nil
	}

	repo, err := atrepo.VerifyCommitMessage(ctx, evt)
	if err != nil {
		log.Warn("commit structure did not verify; skipping", "error", err)
		return nil
	}

	records, err := c.extractRecords(ctx, evt, repo)
	if err != nil {
		log.Warn("could not extract records; skipping", "error", err)
		return nil
	}

	// Who this repository belongs to, in the form a person can read.
	//
	// Resolved rather than read off a record, because no f8130 record carries
	// a handle and one that did would be self-asserted. The directory is the
	// same one the signature check just used and it caches, so this is not a
	// lookup per commit in practice. A failure is not fatal: the handle is for
	// reading, the DID is the identity, and an actor row keeps whatever it had.
	if len(records) > 0 {
		handle := c.handleFor(ctx, evt.Repo)
		for i := range records {
			records[i].Handle = handle
		}
		if rec := c.backfillProfile(ctx, evt.Repo); rec != nil {
			records = append(records, *rec)
		}
	}

	// The cursor still advances for a commit carrying nothing of ours,
	// otherwise a quiet stretch of unrelated traffic would be replayed on
	// every reconnect.
	if err := c.Store.ApplyCommit(ctx, evt.Seq, c.now(), records); err != nil {
		return fmt.Errorf("apply commit seq %d: %w", evt.Seq, err)
	}

	if len(records) > 0 {
		log.Info("indexed records", "count", len(records))
	}
	return nil
}

// backfillProfile recovers a display name the firehose is never going to send.
//
// A station record is published once and the firehose only carries changes, so
// a rebuilt index has no way to learn a name it did not happen to catch the
// first time. Rather than wait for an organization to republish — which it has
// no reason to ever do — the observer notices it is missing a profile and goes
// and gets it, verified.
//
// Asked at most once per repository per process, whether or not it worked. An
// organization with no profile is an ordinary thing to be, and re-asking on
// every commit would turn that into a request per record forever.
func (c *Consumer) backfillProfile(ctx context.Context, repoDID string) *IndexedRecord {
	if c.askedForProfile == nil {
		c.askedForProfile = map[string]bool{}
	}
	if c.askedForProfile[repoDID] {
		return nil
	}
	has, err := c.Store.HasProfile(ctx, repoDID)
	if err != nil || has {
		// An error here is a database problem the caller is about to hit
		// anyway on the write it actually cares about. Not this path's to
		// report, and not a reason to skip indexing the commit.
		return nil
	}
	c.askedForProfile[repoDID] = true

	st, err := c.fetchStation(ctx, repoDID)
	if err != nil {
		c.logger().Info("no profile available for repository",
			"did", repoDID, "error", err)
		return nil
	}
	c.logger().Info("recovered a station profile the firehose had not replayed",
		"did", repoDID, "name", st.DisplayName)
	return &IndexedRecord{
		URI:        fmt.Sprintf("at://%s/%s/%s", repoDID, StationNSID, stationRkey),
		Collection: StationNSID,
		Station:    st,
		Handle:     c.handleFor(ctx, repoDID),
	}
}

// handleFor resolves a repository's DID to its handle, or "" if it cannot.
//
// A handle that has not been bi-directionally verified comes back from the
// directory as the reserved `handle.invalid`, and that is not a name to show
// anybody — it is discarded here rather than stored and rendered later.
func (c *Consumer) handleFor(ctx context.Context, repoDID string) string {
	did, err := syntax.ParseDID(repoDID)
	if err != nil {
		return ""
	}
	ident, err := c.Directory.LookupDID(ctx, did)
	if err != nil || ident == nil {
		c.logger().Debug("could not resolve handle", "did", repoDID, "error", err)
		return ""
	}
	if ident.Handle == syntax.HandleInvalid {
		return ""
	}
	return ident.Handle.String()
}

func (c *Consumer) extractRecords(
	ctx context.Context,
	evt *comatproto.SyncSubscribeRepos_Commit,
	repo *atrepo.Repo,
) ([]IndexedRecord, error) {
	var out []IndexedRecord

	for _, op := range evt.Ops {
		nsid, rkey, err := syntax.ParseRepoPath(op.Path)
		if err != nil {
			continue
		}
		collection := nsid.String()
		if collection != ReleaseNSID &&
			collection != AttestationNSID &&
			collection != StationNSID {
			continue
		}
		uri := fmt.Sprintf("at://%s/%s/%s", evt.Repo, collection, rkey.String())

		if op.Action == "delete" {
			out = append(out, IndexedRecord{URI: uri, Collection: collection, Deleted: true})
			continue
		}
		if op.Cid == nil {
			continue
		}

		raw, recCid, err := repo.GetRecordBytes(ctx, nsid, rkey)
		if err != nil {
			c.logger().Warn("record named in ops but absent from commit blocks",
				"uri", uri, "error", err)
			continue
		}

		decoded, err := DecodeRecord(collection, raw)
		if err != nil {
			if !errors.Is(err, ErrNotOurs) {
				c.logger().Warn("malformed record; skipping", "uri", uri, "error", err)
			}
			continue
		}

		rec := IndexedRecord{URI: uri, CID: recCid.String(), Collection: collection}
		switch v := decoded.(type) {
		case *Release:
			// A record claiming to be issued by someone other than the
			// repository it lives in is not evidence about that someone.
			if v.IssuerDID != evt.Repo {
				c.logger().Warn("release claims a different issuer than its repo; skipping",
					"uri", uri, "claimed", v.IssuerDID)
				continue
			}
			rec.Release = v
		case *Attestation:
			// Nothing to cross-check: an attestation names no author and no
			// issuer, so the repository it was found in is the author by
			// construction and the subject URI names the issuer. A record
			// that cannot claim to be somebody else cannot lie about it.
			rec.Attestation = v
		case *Station:
			// Self-asserted, and the repository it was found in is the subject
			// by construction — a profile claiming to describe somebody else
			// would just be describing itself under a different name.
			rec.Station = v
		default:
			continue
		}
		out = append(out, rec)
	}

	return out, nil
}
