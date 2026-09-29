CREATE TABLE IF NOT EXISTS public_campaign_snapshots(
 genesis TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,
 revision BIGINT NOT NULL,body TEXT NOT NULL,updated_at BIGINT NOT NULL,
 PRIMARY KEY(genesis,program_id,campaign)
);
