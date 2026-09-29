-- Private creation publication receipts; no image blobs, credentials or keys.
CREATE TABLE creation_publications(
 operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES creation_requests(request_id),
 owner TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('image','document')),
 descriptor_hash TEXT NOT NULL,input_hash TEXT NOT NULL,byte_count BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('publishing','published')),cid TEXT,
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 UNIQUE(request_id,stage)
);
CREATE TABLE creation_publication_usage(
 day TEXT NOT NULL,scope TEXT NOT NULL,pins BIGINT NOT NULL,bytes BIGINT NOT NULL,
 PRIMARY KEY(day,scope)
);
CREATE TABLE creation_publication_policy(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),body TEXT NOT NULL
);
CREATE TABLE creation_mint_plans(
 request_id TEXT PRIMARY KEY REFERENCES creation_requests(request_id),
 owner TEXT NOT NULL,request_hash TEXT NOT NULL,intent_hash TEXT NOT NULL,
 intent_json TEXT NOT NULL,created_at BIGINT NOT NULL
);
