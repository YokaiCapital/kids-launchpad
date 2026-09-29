CREATE TABLE IF NOT EXISTS public_activity_identities(
 genesis TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,
 fingerprint TEXT NOT NULL,body TEXT NOT NULL,
 PRIMARY KEY(genesis,program_id,campaign)
);
CREATE TABLE IF NOT EXISTS public_activity_events(
 genesis TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,
 signature TEXT NOT NULL,path TEXT NOT NULL,order_key TEXT NOT NULL,
 kind TEXT NOT NULL,failed INTEGER NOT NULL,has_movement INTEGER NOT NULL,
 fingerprint TEXT NOT NULL,body TEXT NOT NULL,
 PRIMARY KEY(genesis,program_id,campaign,signature,path)
);
CREATE TABLE IF NOT EXISTS public_activity_cursors(
 genesis TEXT NOT NULL,program_id TEXT NOT NULL,campaign TEXT NOT NULL,
 stream TEXT NOT NULL,revision BIGINT NOT NULL,body TEXT NOT NULL,updated_at BIGINT NOT NULL,
 PRIMARY KEY(genesis,program_id,campaign,stream)
);
