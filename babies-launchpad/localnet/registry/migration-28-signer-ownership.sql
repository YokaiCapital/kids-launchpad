-- Durable time leases, not session locks: a dropped database connection must not
-- immediately let a second signer bypass the first process's unexpired authority.
CREATE TABLE IF NOT EXISTS signer_ownership (
 genesis_hash TEXT NOT NULL,
 program_id TEXT NOT NULL,
 payer TEXT NOT NULL,
 owner TEXT,
 epoch BIGINT NOT NULL CHECK(epoch > 0),
 expires_ms BIGINT NOT NULL,
 PRIMARY KEY(genesis_hash,program_id,payer)
);
