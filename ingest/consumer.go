package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
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
