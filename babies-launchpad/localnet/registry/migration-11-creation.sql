CREATE TABLE IF NOT EXISTS creation_quotes(
 quote_id TEXT PRIMARY KEY,owner TEXT NOT NULL,request_key TEXT NOT NULL,
 draft_id TEXT NOT NULL,draft_revision BIGINT NOT NULL,draft_hash TEXT NOT NULL,
 descriptor_hash TEXT NOT NULL,body TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,
 UNIQUE(owner,request_key)
);
CREATE INDEX IF NOT EXISTS creation_quotes_draft ON creation_quotes(owner,draft_id,created_at DESC);
CREATE TABLE IF NOT EXISTS creation_requests(
 request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,draft_id TEXT NOT NULL,quote_id TEXT NOT NULL,
 state TEXT NOT NULL,body TEXT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 UNIQUE(owner,draft_id),UNIQUE(quote_id),
 FOREIGN KEY(quote_id) REFERENCES creation_quotes(quote_id)
);
