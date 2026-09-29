-- Proof-bound retries reuse the encrypted key and immutable mint intent.
-- Generation 0 is the original signature; The signer permits only generations 1 and 2.
CREATE TABLE creation_mint_retries(
 request_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 2),
 owner TEXT NOT NULL,intent_hash TEXT NOT NULL,operation_id TEXT NOT NULL,
 previous_message_hash TEXT NOT NULL,previous_signature TEXT NOT NULL,
 evidence_json TEXT NOT NULL,created_at BIGINT NOT NULL,
 PRIMARY KEY(request_id,generation),
 FOREIGN KEY(operation_id,generation) REFERENCES operator_packets(operation_id,attempt)
);
