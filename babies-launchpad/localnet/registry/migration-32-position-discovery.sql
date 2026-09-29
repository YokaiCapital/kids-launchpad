CREATE TABLE IF NOT EXISTS public_wallet_campaigns(
 genesis TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,
 owner TEXT NOT NULL,receipt TEXT NOT NULL,source_slot BIGINT NOT NULL,
 PRIMARY KEY(genesis,program_id,campaign,owner),
 UNIQUE(genesis,program_id,receipt)
);
CREATE INDEX IF NOT EXISTS public_wallet_campaigns_owner ON public_wallet_campaigns(genesis,program_id,owner,campaign);
CREATE TABLE IF NOT EXISTS public_position_snapshots(
 genesis TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,
 revision BIGINT NOT NULL,body TEXT NOT NULL,updated_at BIGINT NOT NULL,
 PRIMARY KEY(genesis,program_id,campaign)
);
