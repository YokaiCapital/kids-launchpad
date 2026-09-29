-- Private operator audit. Financial packets, grants, budgets and prior failures
-- are retained; this only records explicit bounded execution retry decisions.
CREATE TABLE IF NOT EXISTS job_recoveries(
 recovery_id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES jobs(job_id),
 genesis_hash TEXT NOT NULL,
 program_id TEXT NOT NULL,
 campaign TEXT NOT NULL,
 actor TEXT NOT NULL,
 reason TEXT NOT NULL,
 prior_token BIGINT NOT NULL,
 prior_result_hash TEXT NOT NULL,
 prior_result_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(job_id,prior_token)
);
