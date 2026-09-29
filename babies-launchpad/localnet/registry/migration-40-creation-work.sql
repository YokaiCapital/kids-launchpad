-- Durable continuation of an accepted creation, independent of browser lifetime.
CREATE TABLE creation_work(
 request_id TEXT PRIMARY KEY REFERENCES creation_requests(request_id),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','wallet','paused','done')),
 fencing_token BIGINT NOT NULL DEFAULT 0,
 lease_owner TEXT,
 lease_until BIGINT,
 next_run BIGINT NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 activated_at BIGINT,
 failures INTEGER NOT NULL DEFAULT 0,
 result_json TEXT,
 error_code TEXT,
 updated_at BIGINT NOT NULL
);
CREATE INDEX creation_work_due ON creation_work(state,next_run,lease_until);

-- Explicit consent prepares permanent artwork before the final create click.
CREATE TABLE creation_prepublications(
 request_id TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 draft_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 body TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','attention')),
 next_run BIGINT NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0,
 created_at BIGINT NOT NULL,
 UNIQUE(owner,draft_id,revision)
);
CREATE INDEX creation_prepublications_due ON creation_prepublications(owner,state,next_run);
CREATE TABLE creation_prepublication_receipts(
 operation_id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES creation_prepublications(request_id),
 owner TEXT NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN ('image','document')),
 descriptor_hash TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 byte_count BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('publishing','published')),
 cid TEXT,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 UNIQUE(request_id,stage)
);
CREATE INDEX creation_prepublication_reuse ON creation_prepublication_receipts(owner,stage,input_hash);
CREATE INDEX creation_publication_reuse ON creation_publications(owner,stage,input_hash);
