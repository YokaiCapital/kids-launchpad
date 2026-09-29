-- Monitor active work without repeatedly scanning completed job history.
CREATE INDEX IF NOT EXISTS jobs_observe_scope
 ON jobs(genesis_hash,program_id,job_class,state)
 WHERE state IN ('queued','leased','failed');
