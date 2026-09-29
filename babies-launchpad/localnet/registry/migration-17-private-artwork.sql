-- Descriptors and quotas only; source/processed image bytes never enter SQL.
CREATE TABLE creation_artwork(
 asset_id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_key TEXT NOT NULL,
 source_hash TEXT NOT NULL,source_bytes BIGINT NOT NULL,source_type TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('pfp','banner')),policy_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('processing','pending','ready','failed')),
 attempts INTEGER NOT NULL,lease_token TEXT,lease_until BIGINT NOT NULL,
 object_key TEXT,sha256 TEXT,byte_count BIGINT,width INTEGER,height INTEGER,
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 UNIQUE(owner,request_key)
);
CREATE INDEX creation_artwork_owner ON creation_artwork(owner,created_at,asset_id);
CREATE INDEX creation_artwork_active ON creation_artwork(state,lease_until);
CREATE TABLE creation_artwork_usage(
 day TEXT NOT NULL,scope TEXT NOT NULL,attempts BIGINT NOT NULL,bytes BIGINT NOT NULL,
 PRIMARY KEY(day,scope)
);
CREATE TABLE creation_artwork_policy(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL
);
