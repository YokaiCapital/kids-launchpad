-- Explicitly reviewed retries; never overwrite the original native-custody plan.
CREATE TABLE creation_provision_revisions(
 request_id TEXT NOT NULL REFERENCES creation_provision_plans(request_id),
 generation INTEGER NOT NULL CHECK(generation>=2),
 owner TEXT NOT NULL,base_intent_hash TEXT NOT NULL,previous_intent_hash TEXT NOT NULL,
 intent_hash TEXT NOT NULL,intent_json TEXT NOT NULL,evidence_json TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 PRIMARY KEY(request_id,generation)
);
