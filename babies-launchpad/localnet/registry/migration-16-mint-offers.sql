-- Unsigned wallet offers are immutable. Only one may remain open per request.
-- The approved creator packet remains in the existing private operator outbox.
CREATE TABLE creation_mint_offers(
 offer_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES creation_requests(request_id),
 owner TEXT NOT NULL,intent_hash TEXT NOT NULL,block_json TEXT NOT NULL,
 unsigned_packet TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','superseded','approved')),
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX creation_mint_offers_open ON creation_mint_offers(request_id) WHERE state='open';
CREATE INDEX creation_mint_offers_request ON creation_mint_offers(request_id,created_at DESC);
