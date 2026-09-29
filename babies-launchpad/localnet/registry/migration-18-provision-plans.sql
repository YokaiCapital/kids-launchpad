-- Server-owned provisioning intent, bound to the accepted creator request.
-- No private key, provider credential or signed packet is stored in this table.
CREATE TABLE creation_provision_plans(
 request_id TEXT PRIMARY KEY REFERENCES creation_requests(request_id),
 owner TEXT NOT NULL,request_hash TEXT NOT NULL,mint_intent_hash TEXT NOT NULL,
 intent_hash TEXT NOT NULL,intent_json TEXT NOT NULL,source_slot BIGINT NOT NULL,
 created_at BIGINT NOT NULL
);
