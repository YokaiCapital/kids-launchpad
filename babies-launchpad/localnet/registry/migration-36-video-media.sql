CREATE TABLE creation_videos(
 asset_id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL,
 source_hash TEXT NOT NULL,source_bytes BIGINT NOT NULL,source_type TEXT NOT NULL,
 policy_version TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','processing','ready','failed')),
 attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until BIGINT NOT NULL DEFAULT 0,
 object_key TEXT,sha256 TEXT,byte_count BIGINT,duration_ms INTEGER,
 poster_key TEXT,poster_hash TEXT,poster_bytes BIGINT,
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,UNIQUE(owner,request_key)
);
CREATE INDEX creation_videos_processing ON creation_videos(lease_until,owner) WHERE state='processing';
CREATE TABLE creation_video_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL);
CREATE TABLE creation_video_usage(day TEXT NOT NULL,scope TEXT NOT NULL,attempts BIGINT NOT NULL,bytes BIGINT NOT NULL,PRIMARY KEY(day,scope));
-- Portable, transactional constraint expansion for PostgreSQL and legacy SQLite.
-- No table references these receipts; preserve every immutable receipt verbatim.
CREATE TABLE creation_media_publications_v2(
 operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES creation_requests(request_id),
 owner TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('banner','video','poster')),
 descriptor_hash TEXT NOT NULL,input_hash TEXT NOT NULL,byte_count BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('publishing','published')),cid TEXT,
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 UNIQUE(request_id,stage)
);
INSERT INTO creation_media_publications_v2 SELECT * FROM creation_media_publications;
DROP TABLE creation_media_publications;
ALTER TABLE creation_media_publications_v2 RENAME TO creation_media_publications;
