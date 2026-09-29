-- One explicitly enabled lifecycle per isolated v3 campaign. The original grant
-- remains bound across restarts; expiration/revocation never creates a new grant.
CREATE TABLE IF NOT EXISTS standard_lifecycles(
 genesis_hash TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,
 descriptor_hash TEXT NOT NULL,initial_capability_id TEXT NOT NULL,
 terms_hash TEXT NOT NULL,stage TEXT NOT NULL,
 setup_capability_id TEXT,updated_at TEXT NOT NULL,
 PRIMARY KEY(genesis_hash,program_id,campaign)
);
