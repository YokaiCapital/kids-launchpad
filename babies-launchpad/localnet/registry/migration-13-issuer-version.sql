-- Portable SQLite/PostgreSQL constraint replacement. No table references grant
-- IDs; the immutable IDs and all history are copied, including revoked entries.
CREATE TABLE signer_capabilities_next(
 capability_id TEXT NOT NULL PRIMARY KEY,
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
 program_version INTEGER NOT NULL DEFAULT 1 CHECK(program_version IN (1,2,3)),
 FOREIGN KEY(genesis_hash,program_id,campaign) REFERENCES campaigns(genesis_hash,program_id,campaign)
);
INSERT INTO signer_capabilities_next(capability_id,genesis_hash,program_id,campaign,kind,tags_json,recipients_json,limits_json,expires_at,revoked_at,created_at,program_version)
 SELECT capability_id,genesis_hash,program_id,campaign,kind,tags_json,recipients_json,limits_json,expires_at,revoked_at,created_at,program_version FROM signer_capabilities;
DROP TABLE signer_capabilities;
ALTER TABLE signer_capabilities_next RENAME TO signer_capabilities;
CREATE INDEX signer_capabilities_campaign ON signer_capabilities(genesis_hash,program_id,campaign,expires_at);
CREATE INDEX signer_capabilities_latest ON signer_capabilities(genesis_hash,program_id,campaign,created_at DESC,capability_id DESC);
