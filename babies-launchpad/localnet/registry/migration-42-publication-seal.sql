-- Sealed publication receipts (29 September 2026). A funding-first creation seals the metadata document (and a token
-- image of at most one IPFS chunk) with the content id computed locally from the exact bytes, so the URI is final before
-- the provider is asked; the pin runs in the background during funding and the provider's answer must equal the sealed id.
--   sealed     the URI is final; the provider pin is pending (attempts and next_attempt_at drive the background pin)
--   attention  the provider or the rebuilt content disagreed with the sealed id; an operator must look, nothing moves
-- Portable, transactional constraint expansion for PostgreSQL and legacy SQLite (as migration 36): no table references
-- these receipts; every existing receipt is copied verbatim.
CREATE TABLE creation_publications_v2(
 operation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES creation_requests(request_id),
 owner TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('image','document')),
 descriptor_hash TEXT NOT NULL,input_hash TEXT NOT NULL,byte_count BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('publishing','published','sealed','attention')),cid TEXT,
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 attempts BIGINT NOT NULL DEFAULT 0,next_attempt_at BIGINT NOT NULL DEFAULT 0,
 UNIQUE(request_id,stage)
);
INSERT INTO creation_publications_v2(operation_id,request_id,owner,stage,descriptor_hash,input_hash,byte_count,state,cid,created_at,updated_at) SELECT operation_id,request_id,owner,stage,descriptor_hash,input_hash,byte_count,state,cid,created_at,updated_at FROM creation_publications;
DROP TABLE creation_publications;
ALTER TABLE creation_publications_v2 RENAME TO creation_publications;
CREATE INDEX creation_publications_sealed_due ON creation_publications(owner,state,next_attempt_at);
