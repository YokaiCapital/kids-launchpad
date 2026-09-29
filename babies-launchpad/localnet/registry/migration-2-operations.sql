-- KIDS public launches, P3 registry migration 2 (plan section 8, "operations").
-- Same one-dialect rules as schema.sql: runs unchanged on node:sqlite and on PostgreSQL, one statement per
-- semicolon-ended line, no engine-specific syntax. ALTER TABLE ADD COLUMN is applied once (schema_migrations records it).
-- Jobs gain a not-before time (backoff with jitter survives a restart) and a per-job deadline.
ALTER TABLE jobs ADD COLUMN not_before TEXT;
ALTER TABLE jobs ADD COLUMN deadline_at TEXT;
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, not_before, created_at);
-- Mint leases gain the binding (network, draft, idempotency key), the approved creation message digest and the signing
-- state, all written before any signature is emitted. UNIQUE(mint) from migration 1 makes two leases of one mint impossible.
ALTER TABLE mint_leases ADD COLUMN network TEXT;
ALTER TABLE mint_leases ADD COLUMN draft_id TEXT;
ALTER TABLE mint_leases ADD COLUMN idempotency_key TEXT;
ALTER TABLE mint_leases ADD COLUMN message_digest TEXT;
ALTER TABLE mint_leases ADD COLUMN signature TEXT;
ALTER TABLE mint_leases ADD COLUMN reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS mint_leases_binding ON mint_leases(creator, idempotency_key);
-- Signer capabilities: an explicit, expiring grant per campaign for the keeper. Recipients must stay empty for the
-- keeper kind (no recipient, supply, claim or root power); tags name the launch-program instructions it may sign.
CREATE TABLE IF NOT EXISTS signer_capabilities(
  capability_id TEXT NOT NULL,
  genesis_hash TEXT NOT NULL,
  program_id TEXT NOT NULL,
  campaign TEXT NOT NULL,
  kind TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(capability_id),
  FOREIGN KEY(genesis_hash, program_id, campaign) REFERENCES campaigns(genesis_hash, program_id, campaign)
);
CREATE INDEX IF NOT EXISTS signer_capabilities_campaign ON signer_capabilities(genesis_hash, program_id, campaign, expires_at);
