-- Immutable activation evidence. Revoking the resulting capability does not
-- remove this row or authorize an automatic replacement grant.
CREATE TABLE IF NOT EXISTS standard_fee_activations(
 genesis_hash TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,
 descriptor_hash TEXT NOT NULL,setup_capability_id TEXT NOT NULL,
 active_capability_id TEXT NOT NULL,setup_job_id TEXT NOT NULL,
 payer TEXT NOT NULL,policy TEXT NOT NULL,minimum_reserve_lamports TEXT NOT NULL,
 evidence_json TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(genesis_hash,program_id,campaign)
);
