CREATE TABLE IF NOT EXISTS public_market_identities(
 genesis TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,pool TEXT NOT NULL,
 identity_hash TEXT NOT NULL,body TEXT NOT NULL,first_observed_at BIGINT NOT NULL,
 PRIMARY KEY(genesis,program_id,campaign),UNIQUE(genesis,pool)
);
