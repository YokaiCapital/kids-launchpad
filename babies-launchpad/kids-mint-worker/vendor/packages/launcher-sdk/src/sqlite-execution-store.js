import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
/** Durable single-host CAS journal. For multiple hosts supply a transactional shared DB. */
export class SqliteLaunchExecutionStore {
    durable;
    db;
    constructor(path) {
        this.durable = path !== ":memory:";
        if (this.durable)
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS kids_execution (
        launch_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kids_execution_history (
        launch_id TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY (launch_id, revision)
      );
      -- The admin creators panel groups this journal by creator and status,
      -- both of which live inside record_json. With no index that was
      -- SCAN kids_execution + USE TEMP B-TREE FOR GROUP BY, and the LIMIT is
      -- applied after the grouping so it removed no work: 100.2 ms at 100k
      -- launches, synchronously on the loop that serves the public site
      -- (audit SPD2-07, 10 Sep 2026).
      --
      -- An expression index over exactly the three paths the panel reads makes
      -- it a covering index scan in group order. The cost is three JSON
      -- extractions per write to this table, and a write here is one step of
      -- one launch — the read it replaces was over every launch ever made.
      CREATE INDEX IF NOT EXISTS kids_execution_creator_status_v1 ON kids_execution(
        json_extract(record_json,'$.intent.creator'),
        json_extract(record_json,'$.status'),
        json_extract(record_json,'$.updatedAt')
      );
    `);
    }
    async load(launchId) {
        const row = this.db.prepare("SELECT record_json FROM kids_execution WHERE launch_id = ?").get(launchId);
        return row ? JSON.parse(String(row.record_json)) : null;
    }
    transaction(operation) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = operation();
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            try {
                this.db.exec("ROLLBACK");
            }
            catch { /* the statement already unwound it; never mask the real error */ }
            throw error;
        }
    }
    async insert(record) {
        if (record.revision !== 0)
            throw new Error("Initial execution revision must be zero");
        return this.transaction(() => {
            const json = JSON.stringify(record);
            const result = this.db.prepare("INSERT OR IGNORE INTO kids_execution VALUES (?, ?, ?)").run(record.launchId, record.revision, json);
            if (result.changes === 0)
                return false;
            this.db.prepare("INSERT INTO kids_execution_history VALUES (?, ?, ?)").run(record.launchId, record.revision, json);
            return true;
        });
    }
    async compareAndSwap(launchId, revision, record) {
        if (record.launchId !== launchId || record.revision !== revision + 1)
            throw new Error("Invalid execution CAS revision or identity");
        return this.transaction(() => {
            const json = JSON.stringify(record);
            const result = this.db.prepare("UPDATE kids_execution SET revision = ?, record_json = ? WHERE launch_id = ? AND revision = ?")
                .run(record.revision, json, launchId, revision);
            if (result.changes === 0)
                return false;
            this.db.prepare("INSERT INTO kids_execution_history VALUES (?, ?, ?)").run(launchId, record.revision, json);
            return true;
        });
    }
    close() { this.db.close(); }
}
