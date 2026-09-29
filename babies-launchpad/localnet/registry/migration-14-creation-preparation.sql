-- Durable launch identity before crossing into the encrypted mint inventory.
-- All columns are public identifiers. No key material or signed packet lives here.
CREATE TABLE creation_preparations(
 request_id TEXT PRIMARY KEY REFERENCES creation_requests(request_id),
 genesis_hash TEXT NOT NULL,program_id TEXT NOT NULL,program_version INTEGER NOT NULL CHECK(program_version=3),
 campaign TEXT NOT NULL,nonce TEXT NOT NULL,authority TEXT NOT NULL,
 descriptor_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('allocated','reserved','attention')),
 mint_lease_id TEXT UNIQUE,mint TEXT,reason TEXT,
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 UNIQUE(genesis_hash,program_id,campaign)
);
