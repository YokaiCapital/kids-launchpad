-- Public read model only. Money remains in on-chain fee custody.
CREATE TABLE IF NOT EXISTS public_fee_snapshots (
 genesis TEXT NOT NULL,
 program_id TEXT NOT NULL,
 campaign TEXT NOT NULL,
 slot BIGINT NOT NULL,
 fingerprint TEXT NOT NULL,
 body TEXT NOT NULL,
 observed_at BIGINT NOT NULL,
 PRIMARY KEY(genesis,program_id,campaign)
);
