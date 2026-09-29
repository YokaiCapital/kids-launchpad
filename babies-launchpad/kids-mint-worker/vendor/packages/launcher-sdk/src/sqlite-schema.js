/** `kids_schema` for this package's stores (DAT-24 / DAT2-03).
 *
 * The same record `packages/asset-pools/src/sqlite-schema.ts` keeps, written by
 * the migrations in this package. It is a second copy on purpose:
 * `@kids/launcher-sdk` does not depend on `@kids/asset-pools` and must not
 * start to for four small functions, because that edge would make the mint
 * inventory — the most safety-critical store in the tree — depend on the whole
 * Direct-lane package. `packages/launcher-sdk/test/schema-version.test.ts`
 * asserts the two produce the identical table and the identical rows, so the
 * copy cannot drift into a second, subtly different record.
 *
 * The rules, restated because they are the point of the file: one row per
 * logical store, carrying the HIGHEST version that file has ever been migrated
 * to; never lowered, because a rollback does not un-widen a table and recording
 * that it did would hide the hazard.
 */
import { DatabaseSync } from "node:sqlite";
export const KIDS_SCHEMA_TABLE = "kids_schema";
export const KIDS_SCHEMA_DDL = `CREATE TABLE IF NOT EXISTS ${KIDS_SCHEMA_TABLE}(`
    + "store TEXT PRIMARY KEY,version INTEGER NOT NULL,migrated_at_ms INTEGER NOT NULL,release TEXT NOT NULL);";
const epochMs = (value) => {
    const parsed = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : null;
    return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
/** What this file records for `store`, or null when it has never been stamped. */
export function readSchemaVersion(db, store) {
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(KIDS_SCHEMA_TABLE);
    if (!table)
        return null;
    const row = db.prepare(`SELECT store,version,migrated_at_ms,release FROM ${KIDS_SCHEMA_TABLE} WHERE store=?`).get(store);
    if (!row)
        return null;
    const version = Number(row.version), migratedAtMs = epochMs(row.migrated_at_ms);
    if (!Number.isSafeInteger(version) || version < 1 || migratedAtMs === null)
        return null;
    return { store, version, migratedAtMs, release: String(row.release) };
}
/** Stamp `store` at `version`; never lower what the file already records. */
export function recordSchemaVersion(db, store, version, release, nowMs = Date.now()) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(store))
        throw new Error("Unsafe schema store name");
    if (!Number.isSafeInteger(version) || version < 1)
        throw new Error("Invalid schema version");
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0)
        throw new Error("Invalid schema migration clock");
    db.exec(KIDS_SCHEMA_DDL);
    const previous = readSchemaVersion(db, store);
    if (previous === null) {
        db.prepare(`INSERT INTO ${KIDS_SCHEMA_TABLE}(store,version,migrated_at_ms,release) VALUES(?,?,?,?)`).run(store, version, nowMs, release);
        return { previous: null, current: version, rolledBack: false };
    }
    if (version > previous.version) {
        db.prepare(`UPDATE ${KIDS_SCHEMA_TABLE} SET version=?,migrated_at_ms=?,release=? WHERE store=?`).run(version, nowMs, release, store);
        return { previous: previous.version, current: version, rolledBack: false };
    }
    return { previous: previous.version, current: previous.version, rolledBack: version < previous.version };
}
