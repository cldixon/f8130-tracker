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
  -- 'lessor' was missing until station records started being indexed, at
  -- which point the two lessors on the roster would have failed the check on
  -- insert. Nothing had ever written this column, so nothing had ever noticed.
  kind         TEXT CHECK (kind IN ('oem', 'mro', 'operator', 'broker', 'lessor')),
  -- Fictional commercial identifier, seven characters so it cannot collide
  -- with a real five-character CAGE code. Decoded off the station record since
  -- station records were first indexed, and until the account page existed
  -- there was nowhere to put it, so it was decoded and thrown away.
  cage         TEXT,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
-- column added after the first deployment needs saying twice. Idempotent, and
-- the value arrives on the next station record this observer sees -- or on the
-- next `ingest reindex`, which re-reads every profile from the repositories.
ALTER TABLE actor ADD COLUMN IF NOT EXISTS cage TEXT;

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

-- Somebody checked a document against a release and it held.
--
-- There is no failed counterpart and no outcome column. A party who cannot
-- verify a document cannot prove that to anybody — revealing a document that
-- fails to recompute shows only that some document fails, and anyone can make
-- one — so the network carries successes, and the absence of them is the
-- closest thing to a negative signal it can honestly offer.
--
-- No issuer column either: who issued the release is in subject_uri, and the
-- release row it joins to is authoritative about it. Restating it here would
-- only create a second place for the two to disagree.
CREATE TABLE IF NOT EXISTS attestation (
  cid           TEXT PRIMARY KEY,
  uri           TEXT NOT NULL UNIQUE,

  -- Not a foreign key: firehose ordering across repositories is not
  -- guaranteed, so an attestation can legitimately arrive before the release
  -- it covers. Reconcile on read.
  subject_uri   TEXT NOT NULL,
  subject_cid   TEXT NOT NULL,

  -- The repository the record was found in, which is the whole of its
  -- authorship claim.
  verifier_did  TEXT NOT NULL,

  verified_at   TIMESTAMPTZ NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  seq           BIGINT NOT NULL,
  raw_record    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS attestation_subject_idx ON attestation (subject_cid);
CREATE INDEX IF NOT EXISTS attestation_verifier_idx ON attestation (verifier_did);
CREATE INDEX IF NOT EXISTS attestation_observed_idx ON attestation (observed_at DESC);

-- Single-row table. The cursor advances in the same transaction as the rows it
-- describes, so a crash between the two is not representable: either the
-- records and the cursor both moved, or neither did.
CREATE TABLE IF NOT EXISTS ingest_cursor (
  id   INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seq  BIGINT NOT NULL
);
