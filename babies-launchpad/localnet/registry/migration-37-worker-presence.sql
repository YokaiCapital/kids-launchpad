-- Private telemetry only: not a lease, capability, or financial readiness proof.
CREATE TABLE IF NOT EXISTS worker_presence (
 boot_id TEXT PRIMARY KEY,
 genesis_hash TEXT NOT NULL,
 program_id TEXT NOT NULL,
 campaign_version INTEGER NOT NULL CHECK(campaign_version IN (2,3)),
 lane TEXT NOT NULL,
 classes_json TEXT NOT NULL,
 capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 64),
 sequence BIGINT NOT NULL CHECK(sequence > 0),
 state TEXT NOT NULL CHECK(state IN ('running','stopped')),
 active INTEGER NOT NULL CHECK(active BETWEEN 0 AND 64),
 dispatch_age_ms BIGINT NOT NULL CHECK(dispatch_age_ms >= 0),
 oldest_active_ms BIGINT NOT NULL CHECK(oldest_active_ms >= 0),
 finished BIGINT NOT NULL CHECK(finished >= 0),
 observed_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS worker_presence_scope ON worker_presence(genesis_hash,program_id,campaign_version,lane,observed_ms);
