-- Native ATA retries have a separate generation sequence from campaign creation.
-- The mint/caps/schedule/reserve are unchanged; only the approved packet changes.
CREATE TABLE creation_native_setup_revisions(
 request_id TEXT NOT NULL REFERENCES creation_provision_plans(request_id),
 generation INTEGER NOT NULL CHECK(generation>=2),
 owner TEXT NOT NULL,base_intent_hash TEXT NOT NULL,previous_intent_hash TEXT NOT NULL,
 intent_hash TEXT NOT NULL,intent_json TEXT NOT NULL,evidence_json TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 PRIMARY KEY(request_id,generation)
);
