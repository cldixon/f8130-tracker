package ingest

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
	Release     *Release
	Attestation *Attestation
	Station     *Station
	// Deletions carry only a URI.
	Deleted bool
	// The repository author's handle, resolved from its DID.
	//
	// Not on the record — no f8130 record carries a handle, and one that did
	// would be self-asserted. This comes from the DID document, which is where
	// a handle is actually established, and it is empty when resolution failed.
	Handle string
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
		case rec.Attestation != nil:
			if err := upsertAttestation(ctx, tx, rec, seq, observedAt); err != nil {
				return fmt.Errorf("upsert attestation %s: %w", rec.URI, err)
			}
		case rec.Station != nil:
			if err := upsertStation(ctx, tx, rec); err != nil {
				return fmt.Errorf("upsert station %s: %w", rec.URI, err)
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

	if err := ensureActor(ctx, tx, r.IssuerDID, rec.Handle); err != nil {
		return err
	}

	// observed_at is set on first sight only. A record that reappears — a
	// replay, a reconnect, a re-announcement — must not be able to move its own
	// observation time forward, or the one timestamp an issuer cannot forge
	// would become forgeable by flooding.
	_, err = tx.Exec(ctx, `
		INSERT INTO release (
			cid, uri, issuer_did, prev_uri, prev_cid,
			approving_authority, form_number, organization_name,
			organization_address, description, part_number, serial_number,
			signer_cert, commitment, completed_at, observed_at, seq, raw_record
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
		ON CONFLICT (cid) DO UPDATE SET
			uri = EXCLUDED.uri,
			seq = EXCLUDED.seq
	`,
		rec.CID, rec.URI, r.IssuerDID, prevURI, prevCID,
		r.ApprovingAuthority, r.FormNumber, r.OrganizationName,
		r.OrganizationAddress, r.Description, r.PartNumber, r.SerialNumber,
		r.SignerCert, r.Commitment, r.CompletedAt, observedAt, seq, raw,
	)
	return err
}

// upsertAttestation stores somebody's signed statement that a document checked
// out.
//
// The author is the repository the record was found in, which the consumer
// carries on the URI, so there is no claimed author to reconcile — and no
// claimed issuer either, since the subject URI already names whose repo the
// release lives in.
func upsertAttestation(
	ctx context.Context,
	tx pgx.Tx,
	rec IndexedRecord,
	seq int64,
	observedAt time.Time,
) error {
	a := rec.Attestation
	raw, err := json.Marshal(jsonSafe(a.Raw))
	if err != nil {
		return err
	}

	author := authorOf(rec.URI)
	if err := ensureActor(ctx, tx, author, rec.Handle); err != nil {
		return err
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO attestation (
			cid, uri, subject_uri, subject_cid, verifier_did,
			verified_at, observed_at, seq, raw_record
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (cid) DO UPDATE SET
			uri = EXCLUDED.uri,
			seq = EXCLUDED.seq
	`,
		rec.CID, rec.URI, a.Subject.URI, a.Subject.CID, author,
		a.VerifiedAt, observedAt, seq, raw,
	)
	return err
}

// upsertStation records who an organization says it is.
//
// The actor row already existed — ensureActor creates one the first time a DID
// publishes anything — but until now it held nothing except the DID twice
// over, so every verdict in the feed rendered as a bare identifier. This fills
// in the columns the schema always had.
//
// Overwrites on conflict rather than filling blanks, because a station record
// is the organization's current statement about itself and a later one
// supersedes an earlier one.
func upsertStation(ctx context.Context, tx pgx.Tx, rec IndexedRecord) error {
	st := rec.Station
	did := authorOf(rec.URI)
	if did == "" {
		return fmt.Errorf("station URI has no repository: %s", rec.URI)
	}

	// The handle is only the insert's placeholder and is deliberately absent
	// from the update: a station record says nothing about handles, so this
	// statement must not overwrite one ensureActor resolved.
	handle := rec.Handle
	if handle == "" {
		handle = did
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO actor (did, handle, org_name, kind, cert_number)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (did) DO UPDATE SET
			org_name    = EXCLUDED.org_name,
			kind        = EXCLUDED.kind,
			cert_number = EXCLUDED.cert_number
	`, did, handle, st.DisplayName, st.Kind, nullIfEmpty(st.Certificate))
	return err
}

// HasProfile reports whether this index holds a display name for a DID.
//
// Used to decide whether a profile is worth fetching. A row can exist without
// one — ensureActor creates it the first time a repository publishes anything
// — so the question is about org_name and not about the row.
func (s *Store) HasProfile(ctx context.Context, did string) (bool, error) {
	var name *string
	err := s.pool.QueryRow(ctx,
		`SELECT org_name FROM actor WHERE did = $1`, did).Scan(&name)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return name != nil && *name != "", nil
}

// authorOf pulls the repository DID out of an at:// URI.
func authorOf(uri string) string {
	rest, ok := strings.CutPrefix(uri, "at://")
	if !ok {
		return ""
	}
	did, _, _ := strings.Cut(rest, "/")
	return did
}

// ensureActor creates the row the first time a DID publishes anything, and
// keeps its handle current.
//
// The handle used to be the DID: both writers here inserted VALUES ($1, $1),
// and no statement anywhere ever put a real handle in the column. Nothing
// failed loudly. What failed quietly was everything downstream that reads it —
// the feed's fallback from a display name to a handle rendered a DID, and the
// viewpoint check compared a handle against a DID and so never matched, which
// is why no card was ever marked as yours in production. Both looked like view
// bugs and neither was.
//
// An empty handle leaves whatever is already stored alone rather than
// overwriting it with a blank: a resolution failure is this observer not
// knowing, which is not the same as the account not having one.
func ensureActor(ctx context.Context, tx pgx.Tx, did, handle string) error {
	if handle == "" {
		_, err := tx.Exec(ctx, `
			INSERT INTO actor (did, handle) VALUES ($1, $1)
			ON CONFLICT (did) DO NOTHING
		`, did)
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO actor (did, handle) VALUES ($1, $2)
		ON CONFLICT (did) DO UPDATE SET handle = EXCLUDED.handle
	`, did, handle)
	return err
}

func deleteRecord(ctx context.Context, tx pgx.Tx, uri string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM release WHERE uri = $1`, uri); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM attestation WHERE uri = $1`, uri)
	return err
}

// ChainLink is one shop visit as recorded by this observer.
//
// No status: Block 11 is committed but not published, so an index built from
// the firehose cannot say what was done at each visit. A buyer tracing a part
// learns who touched it and when, and must be shown the rest.
type ChainLink struct {
	Depth            int
	CID              string
	URI              string
	IssuerDID        string
	OrganizationName string
	PartNumber       string
	SerialNumber     string
	Description      string
	PrevURI          *string
	PrevCID          *string
	CompletedAt      time.Time
	ObservedAt       time.Time
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
		SELECT depth, cid, uri, issuer_did, organization_name, part_number,
		       serial_number, description, prev_uri, prev_cid, completed_at,
		       observed_at
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
			&l.Depth, &l.CID, &l.URI, &l.IssuerDID, &l.OrganizationName,
			&l.PartNumber, &l.SerialNumber, &l.Description, &l.PrevURI,
			&l.PrevCID, &l.CompletedAt, &l.ObservedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// IssuerCoverage counts, per issuing organization, how many of its releases
// somebody independently checked and said so in public.
//
// Not a score, and deliberately not framed as one. A thin count can mean
// nobody got round to checking as easily as it can mean something is wrong,
// so it is returned as attested-against-total and left to a reader to weigh.
// The network carries no rejections to count instead: a party who cannot
// verify a document cannot prove that to anybody, so there is nothing
// publishable to aggregate.
func (s *Store) IssuerCoverage(ctx context.Context) (map[string][2]int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.issuer_did,
		       COUNT(*)                       AS releases,
		       COUNT(DISTINCT att.cid)        AS attested
		FROM release r
		LEFT JOIN attestation att ON att.subject_cid = r.cid
		GROUP BY r.issuer_did
		ORDER BY 2 DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string][2]int{}
	for rows.Next() {
		var did string
		var releases, attested int
		if err := rows.Scan(&did, &releases, &attested); err != nil {
			return nil, err
		}
		out[did] = [2]int{releases, attested}
	}
	return out, rows.Err()
}

// Reset truncates every derived table and forgets the cursor.
//
// This is what makes "Postgres is rebuildable from the firehose" a testable
// claim rather than a comforting sentence in a README.
func (s *Store) Reset(ctx context.Context) error {
	// Drop rather than truncate, then migrate again.
	//
	// Truncating empties the tables but keeps their shape, which is fine when
	// only the rows are stale and wrong when the schema is. A field set change
	// moves columns — v2 added Block 1, 4 and 7 to the public record and took
	// Block 11 off it — and a truncated table still carries yesterday's
	// columns, so every insert afterwards fails on a column that no longer
	// exists or a NOT NULL that no longer gets written.
	//
	// Reindex means the index is rebuilt from sequence zero. Nothing here is a
	// source of truth, so there is nothing to lose by taking the tables with
	// it.
	// acceptance and dispute are named here although nothing writes them any
	// more. They exist in deployments that ran before the network stopped
	// carrying verdicts, and a reindex is the moment to be rid of them.
	if _, err := s.pool.Exec(ctx, `
		DROP TABLE IF EXISTS release, acceptance, dispute, attestation, actor, ingest_cursor CASCADE
	`); err != nil {
		return err
	}
	return s.Migrate(ctx)
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
