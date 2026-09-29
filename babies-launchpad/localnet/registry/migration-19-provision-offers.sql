-- Owned, server-built creator setup offers. Browser input never chooses expiry.
CREATE TABLE creation_provision_offers(
 offer_id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES creation_requests(request_id),
 owner TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('native-custody','create-campaign')),
 intent_hash TEXT NOT NULL,block_json TEXT NOT NULL,unsigned_packet TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('open','superseded','approved')),
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX creation_provision_offers_open ON creation_provision_offers(request_id,stage) WHERE state='open';
CREATE INDEX creation_provision_offers_request ON creation_provision_offers(request_id,stage,created_at DESC);
