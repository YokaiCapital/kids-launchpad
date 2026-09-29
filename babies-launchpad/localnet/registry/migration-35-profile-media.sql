-- Supplemental branding is separate from immutable token metadata receipts.
CREATE TABLE creation_media_publications(
 operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES creation_requests(request_id),
 owner TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('banner')),
 descriptor_hash TEXT NOT NULL,input_hash TEXT NOT NULL,byte_count BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('publishing','published')),cid TEXT,
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 UNIQUE(request_id,stage)
);
