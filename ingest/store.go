package ingest

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

// Store is the derived index.
//
// Derived is the operative word: nothing in here is authoritative, and
// Reindex exists so that claim can be demonstrated rather than asserted.
type Store struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, schemaSQL)
	return err
}

// Cursor returns the last firehose sequence number durably applied, or -1 when
// the index has never ingested anything.
func (s *Store) Cursor(ctx context.Context) (int64, error) {
	var seq int64
	err := s.pool.QueryRow(ctx, `SELECT seq FROM ingest_cursor WHERE id = 1`).Scan(&seq)
	if err == pgx.ErrNoRows {
		return -1, nil
	}
	if err != nil {
		return 0, err
	}
	return seq, nil
}

// IndexedRecord is one decoded record from a verified commit, ready to store.
type IndexedRecord struct {
	URI        string
	CID        string
	Collection string
	// Exactly one of these is set.
	Release    *Release
	Acceptance *Acceptance
	// Deletions carry only a URI.
	Deleted bool
}

// ApplyCommit writes a verified commit's records and advances the cursor in a
// single transaction.
//
// The atomicity is the point. If the cursor could advance independently of the
// rows, a crash in between would silently skip records, and the index would be
// quietly wrong in a way no later replay would notice — it would resume from a
// cursor that claims work was done.
func (s *Store) ApplyCommit(
	ctx context.Context,
	seq int64,
	observedAt time.Time,
	records []IndexedRecord,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, rec := range records {
		if rec.Deleted {
			if err := deleteRecord(ctx, tx, rec.URI); err != nil {
				return fmt.Errorf("delete %s: %w", rec.URI, err)
			}
			continue
		}
		switch {
		case rec.Release != nil:
			if err := upsertRelease(ctx, tx, rec, seq, observedAt); err != nil {
				return fmt.Errorf("upsert release %s: %w", rec.URI, err)
			}
		case rec.Acceptance != nil:
			if err := upsertAcceptance(ctx, tx, rec, seq, observedAt); err != nil {
				return fmt.Errorf("upsert acceptance %s: %w", rec.URI, err)
			}
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO ingest_cursor (id, seq) VALUES (1, $1)
		ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq
	`, seq); err != nil {
		return fmt.Errorf("advance cursor: %w", err)
	}

	return tx.Commit(ctx)
}

func upsertRelease(
	ctx context.Context,
	tx pgx.Tx,
	rec IndexedRecord,
	seq int64,
	observedAt time.Time,
) error {
	r := rec.Release
	raw, err := json.Marshal(jsonSafe(r.Raw))
	if err != nil {
		return err
	}

	var prevURI, prevCID *string
	if r.Prev != nil {
		prevURI = &r.Prev.URI
		prevCID = &r.Prev.CID
	}

	if err := ensureActor(ctx, tx, r.IssuerDID); err != nil {
		return err
	}

	// observed_at is set on first sight only. A record that reappears — a
	// replay, a reconnect, a re-announcement — must not be able to move its own
	// observation time forward, or the one timestamp an issuer cannot forge
	// would become forgeable by flooding.
	_, err = tx.Exec(ctx, `
		INSERT INTO release (
			cid, uri, issuer_did, prev_uri, prev_cid, part_number, serial_number,
			status, signer_cert, form_number, commitment, completed_at, observed_at,
			seq, raw_record
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		ON CONFLICT (cid) DO UPDATE SET
			uri = EXCLUDED.uri,
			seq = EXCLUDED.seq
	`,
		rec.CID, rec.URI, r.IssuerDID, prevURI, prevCID, r.PartNumber, r.SerialNumber,
		r.Status, r.SignerCert, r.FormNumber, r.Commitment, r.CompletedAt, observedAt,
		seq, raw,
	)
	return err
}

func upsertAcceptance(
	ctx context.Context,
	tx pgx.Tx,
	rec IndexedRecord,
	seq int64,
	observedAt time.Time,
) error {
	a := rec.Acceptance
	raw, err := json.Marshal(jsonSafe(a.Raw))
	if err != nil {
		return err
	}

	if err := ensureActor(ctx, tx, a.VerifierDID); err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO acceptance (
			cid, uri, subject_uri, subject_cid, issuer_did, verifier_did,
			part_number, serial_number, outcome, note, received_at, observed_at,
			seq, raw_record
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		ON CONFLICT (cid) DO UPDATE SET
			uri = EXCLUDED.uri,
			seq = EXCLUDED.seq
	`,
		rec.CID, rec.URI, a.Subject.URI, a.Subject.CID, a.IssuerDID, a.VerifierDID,
		a.PartNumber, a.SerialNumber, a.Outcome, nullIfEmpty(a.Note), a.ReceivedAt,
		observedAt, seq, raw,
	)
	return err
}

func ensureActor(ctx context.Context, tx pgx.Tx, did string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO actor (did, handle) VALUES ($1, $1)
		ON CONFLICT (did) DO NOTHING
	`, did)
	return err
}

func deleteRecord(ctx context.Context, tx pgx.Tx, uri string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM release WHERE uri = $1`, uri); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM acceptance WHERE uri = $1`, uri)
	return err
}

// ChainLink is one shop visit as recorded by this observer.
type ChainLink struct {
	Depth        int
	CID          string
	URI          string
	IssuerDID    string
	PartNumber   string
	SerialNumber string
	Status       string
	PrevURI      *string
	PrevCID      *string
	CompletedAt  time.Time
	ObservedAt   time.Time
}

// Chain walks a release back toward birth.
//
// The recursive join follows prev_cid rather than prev_uri: the CID pins
// content, so a predecessor that has been rewritten since it was referenced
// simply fails to join and surfaces as a gap. A row that does not come back is
// the answer, not an error.
func (s *Store) Chain(ctx context.Context, cid string, maxDepth int) ([]ChainLink, error) {
	rows, err := s.pool.Query(ctx, `
		WITH RECURSIVE chain AS (
			SELECT r.*, 1 AS depth FROM release r WHERE r.cid = $1
			UNION ALL
			SELECT r.*, c.depth + 1
			FROM release r
			JOIN chain c ON r.cid = c.prev_cid
			WHERE c.depth < $2
		)
		SELECT depth, cid, uri, issuer_did, part_number, serial_number, status,
		       prev_uri, prev_cid, completed_at, observed_at
		FROM chain
		ORDER BY depth
	`, cid, maxDepth)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ChainLink
	for rows.Next() {
		var l ChainLink
		if err := rows.Scan(
			&l.Depth, &l.CID, &l.URI, &l.IssuerDID, &l.PartNumber, &l.SerialNumber,
			&l.Status, &l.PrevURI, &l.PrevCID, &l.CompletedAt, &l.ObservedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// IssuerRejections counts distinct operators who have rejected an issuer's
// releases — the scoring the watchdog AppView is built on.
func (s *Store) IssuerRejections(ctx context.Context) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT issuer_did, COUNT(DISTINCT verifier_did)
		FROM acceptance
		WHERE outcome = 'rejected'
		GROUP BY issuer_did
		ORDER BY 2 DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]int{}
	for rows.Next() {
		var did string
		var n int
		if err := rows.Scan(&did, &n); err != nil {
			return nil, err
		}
		out[did] = n
	}
	return out, rows.Err()
}

// Reset truncates every derived table and forgets the cursor.
//
// This is what makes "Postgres is rebuildable from the firehose" a testable
// claim rather than a comforting sentence in a README.
func (s *Store) Reset(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		TRUNCATE release, acceptance, actor, ingest_cursor RESTART IDENTITY
	`)
	return err
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// jsonSafe rewrites atproto's CBOR-native types into something encoding/json
// can represent, so raw_record stays inspectable.
func jsonSafe(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[k] = jsonSafe(val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = jsonSafe(val)
		}
		return out
	case []byte:
		return fmt.Sprintf("%x", x)
	case fmt.Stringer:
		return x.String()
	default:
		return v
	}
}
