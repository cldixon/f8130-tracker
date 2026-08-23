-- Derived index for the f8130 AppView.
--
-- NOTHING HERE IS A SOURCE OF TRUTH. Every row is reconstructible by replaying
-- the firehose from sequence zero, and `ingest reindex` exists to prove it. If
-- this database and an issuer's repository ever disagree, the repository is
-- right and this is stale.

CREATE TABLE IF NOT EXISTS actor (
  did          TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  org_name     TEXT,
  cert_number  TEXT,
  kind         TEXT CHECK (kind IN ('oem', 'mro', 'operator', 'broker')),
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS release (
  cid           TEXT PRIMARY KEY,
  uri           TEXT NOT NULL UNIQUE,
  issuer_did    TEXT NOT NULL,

  -- The predecessor as a strong reference. NOT a foreign key, deliberately:
  -- a dangling link is data, not corruption. A part whose history stops short
  -- of birth is exactly what a buyer most needs to be told about, and an FK
  -- would make that unrepresentable.
  prev_uri      TEXT,
  prev_cid      TEXT,

  -- The blocks of the form that travel in plaintext on the public record.
  -- Block 11 (status) and Block 12 (remarks) are deliberately absent: they are
  -- committed but not published, so this index cannot answer what was done to
  -- a part or what the shop found. That is the point.
  approving_authority  TEXT NOT NULL,
  form_number          TEXT NOT NULL,
  organization_name    TEXT NOT NULL,
  organization_address TEXT NOT NULL,
  description          TEXT NOT NULL,
  part_number          TEXT NOT NULL,
  serial_number        TEXT NOT NULL,
  signer_cert          TEXT NOT NULL,
  commitment           BYTEA NOT NULL,

  -- Claimed by the issuer. A self-hosted server can write anything here, and
  -- backdating is precisely the fraudster's move.
  completed_at  TIMESTAMPTZ NOT NULL,

  -- When THIS observer first saw the record on the firehose. The only
  -- timestamp on this row that an issuer cannot forge — and still only as
  -- trustworthy as this one observer, which is why a second independent
  -- AppView is part of the design rather than a nicety.
  observed_at   TIMESTAMPTZ NOT NULL,

  -- Firehose sequence number the record arrived at, for replay and ordering.
  seq           BIGINT NOT NULL,

  raw_record    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS release_part_serial_idx ON release (part_number, serial_number);
CREATE INDEX IF NOT EXISTS release_prev_cid_idx ON release (prev_cid);
CREATE INDEX IF NOT EXISTS release_issuer_idx ON release (issuer_did);
CREATE INDEX IF NOT EXISTS release_observed_idx ON release (observed_at DESC);

CREATE TABLE IF NOT EXISTS acceptance (
  cid           TEXT PRIMARY KEY,
  uri           TEXT NOT NULL UNIQUE,

  -- Also not a foreign key: firehose ordering across repositories is not
  -- guaranteed, so an operator's verdict can legitimately arrive before the
  -- release it judges. Reconcile on read.
  subject_uri   TEXT NOT NULL,
  subject_cid   TEXT NOT NULL,

  issuer_did    TEXT NOT NULL,
  verifier_did  TEXT NOT NULL,
  part_number   TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'discrepancy')),
  note          TEXT,
  received_at   TIMESTAMPTZ NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  seq           BIGINT NOT NULL,
  raw_record    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS acceptance_issuer_outcome_idx ON acceptance (issuer_did, outcome);
CREATE INDEX IF NOT EXISTS acceptance_subject_idx ON acceptance (subject_cid);

-- An issuer answering a verdict published against them.
--
-- They cannot delete or amend the verdict — it lives in the verifier's
-- repository, not theirs — so a reply is the whole of what they can do, and
-- indexing it is what makes that visible rather than merely true.
CREATE TABLE IF NOT EXISTS dispute (
  cid           TEXT PRIMARY KEY,
  uri           TEXT NOT NULL UNIQUE,

  -- The acceptance being answered. Not a foreign key, for the same reason as
  -- the others: cross-repository ordering is not guaranteed.
  subject_uri   TEXT NOT NULL,
  subject_cid   TEXT NOT NULL,

  -- The repository the record was found in. A dispute names no author, which
  -- is the only authorship claim worth anything.
  author_did    TEXT NOT NULL,

  response      TEXT NOT NULL,
  disputed_at   TIMESTAMPTZ NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  seq           BIGINT NOT NULL,
  raw_record    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS dispute_subject_idx ON dispute (subject_cid);

-- Single-row table. The cursor advances in the same transaction as the rows it
-- describes, so a crash between the two is not representable: either the
-- records and the cursor both moved, or neither did.
CREATE TABLE IF NOT EXISTS ingest_cursor (
  id   INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seq  BIGINT NOT NULL
);
