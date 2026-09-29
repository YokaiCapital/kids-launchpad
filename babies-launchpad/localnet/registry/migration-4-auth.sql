-- Shared wallet sign-in. Session tokens are stored only as SHA-256 digests.
-- Origin is part of every auth lookup so staging and production cannot share a session.
CREATE TABLE IF NOT EXISTS wallet_auth_challenges (
 id TEXT PRIMARY KEY,
 origin TEXT NOT NULL,
 owner TEXT NOT NULL,
 message TEXT NOT NULL,
 expires BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_auth_challenges_owner ON wallet_auth_challenges(origin,owner,expires);
CREATE INDEX IF NOT EXISTS wallet_auth_challenges_expiry ON wallet_auth_challenges(expires);
CREATE TABLE IF NOT EXISTS wallet_sessions (
 token_hash TEXT PRIMARY KEY,
 origin TEXT NOT NULL,
 owner TEXT NOT NULL,
 expires BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_sessions_expiry ON wallet_sessions(expires);
CREATE TABLE IF NOT EXISTS wallet_accounts (
 owner TEXT PRIMARY KEY,
 body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_account_requests (
 owner TEXT NOT NULL,
 id TEXT NOT NULL,
 hash TEXT NOT NULL,
 response TEXT NOT NULL,
 PRIMARY KEY(owner,id)
);
CREATE TABLE IF NOT EXISTS wallet_account_audit (
 id TEXT PRIMARY KEY,
 time BIGINT NOT NULL,
 owner TEXT NOT NULL,
 action TEXT NOT NULL,
 resource TEXT NOT NULL
);
