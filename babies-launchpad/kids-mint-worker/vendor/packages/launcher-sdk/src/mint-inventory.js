import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { compileLaunchTransaction } from "./compile.js";
import { assertSameLaunchIntent, serializeLaunchIntent } from "./intent.js";
import { Web3V0TransactionCodec } from "./v0-codec.js";
import { recordSchemaVersion } from "./sqlite-schema.js";
/** Bumped by any migration that widens or rebuilds a table in this store;
 * every bump needs an entry in scripts/hosting/schema-migrations.json. */
export const MINT_INVENTORY_SCHEMA_VERSION = 2;
import { assertSameDirectBatchLaunchIntent } from "./direct-batch-v2.js";
import { compileDirectBatchLaunchTransaction } from "./direct-batch-v2-compile.js";
import { assertVerifiedMintLookupCoverage, freezeMintLookupCoverage, mintLookupCoverageTables } from "./mint-lookup-coverage.js";
import { canonicalIntentJson } from "./canonical-json.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isZero = (bytes) => bytes.every((value) => value === 0);
const token = (value) => /^[A-Za-z0-9:_./-]{1,200}$/.test(value);
const verifier = Buffer.from("kids-mint-inventory-key-verifier:v1", "utf8");
export function assertLaunchMintAddress(address) {
    let key;
    try {
        if (typeof address !== "string")
            throw new Error();
        key = new PublicKey(address);
    }
    catch {
        throw new Error("Invalid launch mint address");
    }
    if (key.toBase58() !== address || key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes())) {
        throw new Error("Every reserved mint must be a canonical non-default on-curve address");
    }
}
export function assertPairMintAddress(address) {
    let key;
    try {
        key = new PublicKey(address);
    }
    catch {
        throw new Error("Invalid vanity mint address");
    }
    if (key.toBase58() !== address || !address.endsWith("kids") || !PublicKey.isOnCurve(key.toBytes())) {
        throw new Error("Every reserved mint must be an on-curve address ending in exact lowercase kids");
    }
}
function validateBinding(binding) {
    let key;
    try {
        key = new PublicKey(binding.creator);
    }
    catch {
        throw new Error("Invalid creator wallet");
    }
    if (key.toBase58() !== binding.creator || !PublicKey.isOnCurve(key.toBytes()))
        throw new Error("Invalid creator wallet");
    if (!token(binding.draftId) || !token(binding.idempotencyKey))
        throw new Error("Invalid draft or idempotency identifier");
}
function keyAddress(secret) {
    if (secret.length !== 64)
        throw new Error("Private key must contain exactly 64 bytes");
    const publicBytes = ed25519.getPublicKey(secret.subarray(0, 32));
    if (!Buffer.from(publicBytes).equals(Buffer.from(secret.subarray(32))))
        throw new Error("Private key encoding is inconsistent");
    const address = new PublicKey(publicBytes).toBase58();
    assertLaunchMintAddress(address);
    return address;
}
function openPrivateFile(path) {
    if (!isAbsolute(path))
        throw new Error("Private key path must be absolute");
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 2_048 || stat.size < 100) {
            throw new Error("Private key source must be a bounded regular file accessible only to its owner");
        }
        return descriptor;
    }
    catch (error) {
        closeSync(descriptor);
        throw error;
    }
}
/**
 * Single-host durable, encrypted, one-use signer inventory. It has no release,
 * export-key or send method. A reserved address is never returned to the pool,
 * even when no signature was requested. Run only in a server-owned private
 * directory; do not expose the DB/importer through web/static serving.
 */
export class SqliteVanityMintInventory {
    db;
    key;
    keyId;
    executionStore;
    allowNonAtomic;
    fallbackToOrdinaryMint;
    now;
    codec = new Web3V0TransactionCodec();
    closed = false;
    constructor(options) {
        if (!isAbsolute(options.databasePath) || options.encryptionKey.length !== 32 || !token(options.keyId)) {
            throw new Error("Inventory requires an absolute database path, key ID and injected 32-byte encryption key");
        }
        if (!options.executionStore.durable)
            throw new Error("Mint signing requires a durable execution store");
        const directory = dirname(options.databasePath);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const directoryStat = lstatSync(directory);
        if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0)
            throw new Error("Inventory directory must be private (0700)");
        const descriptor = openSync(options.databasePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try {
            const stat = fstatSync(descriptor);
            if (!stat.isFile() || (stat.mode & 0o077) !== 0)
                throw new Error("Inventory database must be private (0600)");
        }
        finally {
            closeSync(descriptor);
        }
        this.key = Buffer.from(options.encryptionKey);
        this.keyId = options.keyId;
        this.executionStore = options.executionStore;
        this.allowNonAtomic = options.allowNonAtomicLaunch === true;
        this.fallbackToOrdinaryMint = options.fallbackToOrdinaryMint !== false;
        this.now = options.now ?? Date.now;
        this.db = new DatabaseSync(options.databasePath);
        try {
            this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS kids_mint_key (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1), key_id TEXT NOT NULL,
          nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kids_mints (
          mint TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('available','reserved','signed','quarantined')),
          created_at TEXT NOT NULL, intent_hash TEXT
        );
        CREATE TABLE IF NOT EXISTS kids_mint_reservations (
          reservation_id TEXT PRIMARY KEY, creator TEXT NOT NULL, draft_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE, mint TEXT NOT NULL UNIQUE REFERENCES kids_mints(mint),
          UNIQUE(creator, draft_id)
        );
        CREATE INDEX IF NOT EXISTS kids_mint_available ON kids_mints(status, created_at, mint);
        CREATE TABLE IF NOT EXISTS kids_mint_lookup_coverage_v1 (
          mint TEXT PRIMARY KEY REFERENCES kids_mints(mint), policy_sha256 TEXT NOT NULL,
          coverage_json TEXT NOT NULL, installed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS kids_mint_lookup_policy ON kids_mint_lookup_coverage_v1(policy_sha256,mint);
        CREATE TABLE IF NOT EXISTS kids_mint_refill_lease (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL,
          fence INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kids_mint_signatures (
          mint TEXT NOT NULL REFERENCES kids_mints(mint), generation INTEGER NOT NULL,
          message_hash TEXT NOT NULL, signature BLOB NOT NULL,
          PRIMARY KEY(mint, generation), UNIQUE(mint, message_hash)
        );
      `);
            // DAT-06: this table decides how long a creator's coin address stays held
            // and used to record no time at all. Nullable and defaultless on purpose —
            // a reservation made before this release genuinely has no timestamp, and
            // `reservedAtMs` must stay null for it rather than claim "just now".
            if (!this.db.prepare("PRAGMA table_info(kids_mint_reservations)").all().some((row) => String(row.name) === "reserved_at_ms")) {
                this.db.exec("ALTER TABLE kids_mint_reservations ADD COLUMN reserved_at_ms INTEGER");
            }
            // DAT-24/DAT2-03: record what this file has been migrated to, so a
            // rollback can ask the volume instead of assuming.
            recordSchemaVersion(this.db, "mint-inventory", MINT_INVENTORY_SCHEMA_VERSION, "3.102", this.now());
            this.transaction(() => {
                const row = this.db.prepare("SELECT * FROM kids_mint_key WHERE singleton=1").get();
                if (row) {
                    if (row.key_id !== this.keyId)
                        throw new Error("Inventory encryption key ID does not match");
                    const clear = this.decrypt(row, "key-verifier");
                    try {
                        if (!clear.equals(verifier))
                            throw new Error("Inventory encryption key does not match");
                    }
                    finally {
                        clear.fill(0);
                    }
                }
                else {
                    const sealed = this.encrypt(verifier, "key-verifier");
                    this.db.prepare("INSERT INTO kids_mint_key VALUES(1,?,?,?,?)").run(this.keyId, sealed.nonce, sealed.ciphertext, sealed.tag);
                }
            });
        }
        catch (error) {
            this.db.close();
            this.key.fill(0);
            throw error;
        }
    }
    aad(identity) { return Buffer.from(JSON.stringify(["kids-mint-inventory", 1, this.keyId, identity])); }
    encrypt(clear, identity) {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        cipher.setAAD(this.aad(identity));
        return { nonce, ciphertext: Buffer.concat([cipher.update(clear), cipher.final()]), tag: cipher.getAuthTag() };
    }
    decrypt(row, identity) {
        try {
            const decipher = createDecipheriv("aes-256-gcm", this.key, row.nonce);
            decipher.setAAD(this.aad(identity));
            decipher.setAuthTag(row.tag);
            return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
        }
        catch {
            throw new Error("Inventory encrypted record failed authentication");
        }
    }
    transaction(operation) {
        if (this.closed)
            throw new Error("Inventory is closed");
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
    reservation(row) {
        return { reservationId: String(row.reservation_id), creator: String(row.creator), draftId: String(row.draft_id),
            idempotencyKey: String(row.idempotency_key), mintAddress: String(row.mint), status: row.status };
    }
    assertBinding(reservation, binding) {
        if (reservation.creator !== binding.creator || reservation.draftId !== binding.draftId || reservation.idempotencyKey !== binding.idempotencyKey) {
            throw new Error("Mint reservation is permanently bound to another wallet, draft or idempotency key");
        }
    }
    /** Explicit operator import only; never invoke with an HTTP-provided path. */
    importPrivateKeyFile(path) {
        const descriptor = openPrivateFile(path);
        let raw, secret;
        try {
            raw = readFileSync(descriptor);
            let parsed;
            try {
                parsed = JSON.parse(raw.toString("utf8"));
            }
            catch {
                throw new Error("Private key file is not a JSON byte array");
            }
            if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
                throw new Error("Private key file must contain exactly 64 integer bytes");
            }
            secret = Buffer.from(parsed);
            parsed.fill(0);
            const mintAddress = keyAddress(secret);
            assertPairMintAddress(mintAddress);
            return this.transaction(() => {
                const existing = this.db.prepare("SELECT status FROM kids_mints WHERE mint=?").get(mintAddress);
                if (existing)
                    return { mintAddress, imported: false, status: existing.status };
                const sealed = this.encrypt(secret, mintAddress);
                this.db.prepare("INSERT INTO kids_mints VALUES(?,?,?,?,'available',?,NULL)")
                    .run(mintAddress, sealed.nonce, sealed.ciphertext, sealed.tag, new Date().toISOString());
                return { mintAddress, imported: true, status: "available" };
            });
        }
        finally {
            raw?.fill(0);
            secret?.fill(0);
            closeSync(descriptor);
        }
    }
    reserve(binding, options) {
        validateBinding(binding);
        if (options && !/^[a-f0-9]{64}$/.test(options.requiredLookupPolicySha256))
            throw new Error("Exact mint lookup policy SHA256 required");
        if (options?.preferFrozenCoverage && options.allowUnpreparedInitialBuy)
            throw new Error("Lookup preference cannot enable preparation");
        return this.transaction(() => {
            const reservation = this.findReservation(binding);
            if (reservation) {
                if (reservation.status === "quarantined")
                    throw new Error("Mint reservation is quarantined");
                if (options && !options.preferFrozenCoverage) {
                    const covered = this.lookupCoverage(reservation.mintAddress);
                    if (covered?.policySha256 !== options.requiredLookupPolicySha256
                        && !(options.allowUnpreparedInitialBuy === true && covered === null && reservation.status === "reserved")) {
                        throw new Error("Existing mint reservation does not have the required initial-buy lookup coverage; no replacement is permitted");
                    }
                }
                return reservation;
            }
            // A reservation with no lookup requirement (the Direct lane, whose launch
            // packet loads only the shared static table) takes the oldest UNCOVERED
            // mint. The warm-up covers oldest-first too, so taking the oldest mint
            // outright consumed a covered one on every such launch and its frozen
            // per-mint table — paid by the operator wallet — was never loaded (63 of
            // the first 98 covered mints consumed, 11 Sep 2026). Covered mints stay
            // for the lanes that require coverage; an uncovered pool that is empty
            // falls back to the oldest available mint as before.
            let row = options ? this.db.prepare(`SELECT m.mint FROM kids_mints m JOIN kids_mint_lookup_coverage_v1 c USING(mint)
        WHERE m.status='available' AND c.policy_sha256=? AND (?=0 OR json_extract(c.coverage_json,'$.schemaVersion')=2) ORDER BY m.created_at,m.mint LIMIT 1`).get(options.requiredLookupPolicySha256, options.preferFrozenCoverage ? 1 : 0)
                : this.db.prepare(`SELECT m.mint FROM kids_mints m LEFT JOIN kids_mint_lookup_coverage_v1 c USING(mint)
          WHERE m.status='available' AND c.mint IS NULL ORDER BY m.created_at,m.mint LIMIT 1`).get()
                    ?? this.db.prepare("SELECT mint FROM kids_mints WHERE status='available' ORDER BY created_at,mint LIMIT 1").get();
            if (row && options?.preferFrozenCoverage) {
                const covered = this.lookupCoverage(String(row.mint));
                if (covered?.schemaVersion !== 2 || covered.policySha256 !== options.requiredLookupPolicySha256)
                    throw new Error("Preferred mint coverage differs");
            }
            if (!row && options?.preferFrozenCoverage)
                row = this.db.prepare("SELECT mint FROM kids_mints WHERE status='available' ORDER BY created_at,mint LIMIT 1").get();
            if (!row && options?.allowUnpreparedInitialBuy === true) {
                row = this.db.prepare(`SELECT m.mint FROM kids_mints m LEFT JOIN kids_mint_lookup_coverage_v1 c USING(mint)
          WHERE m.status='available' AND c.mint IS NULL ORDER BY m.created_at,m.mint LIMIT 1`).get();
            }
            // The database write lock covers both selection and generation. Concurrent
            // callers cannot consume the same mint, and an idempotent retry above
            // cannot replace the address even after the vanilla fallback was used.
            let mintAddress;
            if (row) {
                mintAddress = String(row.mint);
                assertLaunchMintAddress(mintAddress);
                const changed = this.db.prepare("UPDATE kids_mints SET status='reserved' WHERE mint=? AND status='available'").run(mintAddress);
                if (changed.changes !== 1)
                    throw new Error("Mint reservation changed concurrently");
            }
            else {
                if (options && options.allowUnpreparedInitialBuy !== true && !options.preferFrozenCoverage)
                    throw new Error("No available mint has finalized initial-buy lookup coverage; developer-buy preparation is required");
                if (!this.fallbackToOrdinaryMint)
                    throw new Error("Vanity mint inventory is empty; ordinary mint fallback is disabled");
                const seed = randomBytes(32), secret = Buffer.alloc(64);
                try {
                    seed.copy(secret);
                    secret.set(ed25519.getPublicKey(seed), 32);
                    mintAddress = keyAddress(secret);
                    const sealed = this.encrypt(secret, mintAddress);
                    this.db.prepare("INSERT INTO kids_mints VALUES(?,?,?,?,'reserved',?,NULL)")
                        .run(mintAddress, sealed.nonce, sealed.ciphertext, sealed.tag, new Date().toISOString());
                }
                finally {
                    seed.fill(0);
                    secret.fill(0);
                }
            }
            const reservationId = randomUUID();
            this.db.prepare("INSERT INTO kids_mint_reservations(reservation_id,creator,draft_id,idempotency_key,mint,reserved_at_ms) VALUES(?,?,?,?,?,?)")
                .run(reservationId, binding.creator, binding.draftId, binding.idempotencyKey, mintAddress, this.now());
            return { ...binding, reservationId, mintAddress, status: "reserved" };
        });
    }
    /** Returns an unsigned reservation's mint to the available pool (owner
     * decision, 9 Sep 2026: interrupted launches are abandoned silently and their
     * reserved addresses come back). Refused once the mint has co-signed anything,
     * because such a packet could still land, and for a quarantined mint. The
     * caller proves the mint has no on-chain account before asking. */
    releaseUnsignedReservation(binding) {
        validateBinding(binding);
        return this.transaction(() => {
            const reservation = this.findReservation(binding);
            if (!reservation)
                return { released: false, reason: "absent" };
            const mint = reservation.mintAddress;
            const signed = this.db.prepare("SELECT 1 FROM kids_mint_signatures WHERE mint=? LIMIT 1").get(mint);
            const row = this.db.prepare("SELECT status FROM kids_mints WHERE mint=?").get(mint);
            if (signed || row?.status === "signed")
                return { released: false, reason: "signed" };
            if (row?.status === "quarantined")
                return { released: false, reason: "quarantined" };
            const gone = this.db.prepare("DELETE FROM kids_mint_reservations WHERE reservation_id=? AND mint=?").run(reservation.reservationId, mint);
            const back = this.db.prepare("UPDATE kids_mints SET status='available' WHERE mint=? AND status='reserved'").run(mint);
            if (gone.changes !== 1 || back.changes !== 1)
                throw new Error("Mint release changed concurrently");
            return { released: true, mintAddress: mint };
        });
    }
    /** Same release, addressed by the reserved mint (a bare reservation whose
     * launch never got a binding). The creator must match the reservation. */
    releaseUnsignedReservationByMint(creator, mintAddress) {
        assertLaunchMintAddress(mintAddress);
        const row = this.db.prepare("SELECT r.creator, r.draft_id, r.idempotency_key FROM kids_mint_reservations r WHERE r.mint=?").get(mintAddress);
        if (!row || String(row.creator) !== creator)
            return { released: false, reason: "absent" };
        return this.releaseUnsignedReservation({ creator, draftId: String(row.draft_id), idempotencyKey: String(row.idempotency_key) });
    }
    /** Read-only: which creator holds the reservation for this address, or null.
     * Audit EXE2-02 - the recovery journal needs it to refuse funding evidence
     * that names a coin reserved by somebody else. No key material is touched. */
    reservationOwner(mintAddress) {
        assertLaunchMintAddress(mintAddress);
        const row = this.db.prepare("SELECT creator FROM kids_mint_reservations WHERE mint=?").get(mintAddress);
        return row ? String(row.creator) : null;
    }
    /** Explicit trusted installer only. No plaintext keys, HTTP path, replacement,
     * reservation or signing is exposed by this operation. */
    registerLookupCoverage(proof) {
        assertVerifiedMintLookupCoverage(proof);
        const serialized = JSON.stringify(freezeMintLookupCoverage(proof));
        return this.transaction(() => {
            const previous = this.db.prepare("SELECT coverage_json FROM kids_mint_lookup_coverage_v1 WHERE mint=?").get(proof.mint);
            if (previous) {
                const old = freezeMintLookupCoverage(JSON.parse(String(previous.coverage_json)));
                // A newer observation of precisely the same immutable identity is an
                // idempotent no-op; never rewrite the original installation evidence.
                if (JSON.stringify({ ...old, finalizedSlot: 0 }) !== JSON.stringify({ ...proof, finalizedSlot: 0 }))
                    throw new Error("Mint lookup coverage is permanently pinned");
                return { installed: false, mintAddress: proof.mint };
            }
            const mint = this.db.prepare("SELECT status,intent_hash FROM kids_mints WHERE mint=?").get(proof.mint);
            const unsignedReservation = proof.schemaVersion === 2 && mint?.status === "reserved" && mint.intent_hash === null
                && !this.db.prepare("SELECT 1 FROM kids_mint_signatures WHERE mint=? LIMIT 1").get(proof.mint);
            if (mint?.status !== "available" && !unsignedReservation)
                throw new Error("Lookup coverage can only be installed for an existing unused mint");
            this.db.prepare("INSERT INTO kids_mint_lookup_coverage_v1 VALUES(?,?,?,?)")
                .run(proof.mint, proof.policySha256, serialized, new Date().toISOString());
            return { installed: true, mintAddress: proof.mint };
        });
    }
    /** Public metadata only; never a signer or permission to replace its address. */
    lookupCoverage(mintAddress) {
        if (this.closed)
            throw new Error("Inventory is closed");
        assertLaunchMintAddress(mintAddress);
        const row = this.db.prepare("SELECT coverage_json FROM kids_mint_lookup_coverage_v1 WHERE mint=?").get(mintAddress);
        return row ? freezeMintLookupCoverage(JSON.parse(String(row.coverage_json))) : null;
    }
    /** Bounded public candidates for an operator's unsigned table setup plan. */
    lookupCandidates(limit = 20, afterMint) {
        if (this.closed)
            throw new Error("Inventory is closed");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
            throw new Error("Lookup candidate limit must be1–500");
        if (afterMint !== undefined)
            assertLaunchMintAddress(afterMint);
        // The immutable creation tuple remains a cursor even after its mint is
        // reserved or covered. Removing earlier candidates cannot shift a page.
        if (afterMint !== undefined)
            return Object.freeze(this.db.prepare(`SELECT m.mint FROM kids_mints m LEFT JOIN kids_mint_lookup_coverage_v1 c USING(mint)
      WHERE m.status='available' AND c.mint IS NULL
      AND (m.created_at,m.mint) > (SELECT created_at,mint FROM kids_mints WHERE mint=?)
      ORDER BY m.created_at,m.mint LIMIT ?`).all(afterMint, limit).map(row => String(row.mint)));
        return Object.freeze(this.db.prepare(`SELECT m.mint FROM kids_mints m LEFT JOIN kids_mint_lookup_coverage_v1 c USING(mint)
      WHERE m.status='available' AND c.mint IS NULL ORDER BY m.created_at,m.mint LIMIT ?`).all(limit).map(row => String(row.mint)));
    }
    /** Exact read-only eligibility, independent of a scheduler's current page. */
    isLookupCandidate(mintAddress) {
        if (this.closed)
            throw new Error("Inventory is closed");
        assertLaunchMintAddress(mintAddress);
        // Truthiness, not `!== undefined`: `node:sqlite`'s StatementSync.get()
        // returned null for no-row before Node 22.13 and undefined after, so the
        // strict comparison made EVERY mint a candidate on a permitted older Node
        // and burnt lookup-grant operations on tables nobody needed (COD-46).
        return Boolean(this.db.prepare(`SELECT 1 FROM kids_mints m LEFT JOIN kids_mint_lookup_coverage_v1 c USING(mint)
      WHERE m.mint=? AND m.status='available' AND c.mint IS NULL`).get(mintAddress));
    }
    /** Read-only listing of every live reservation, for operator sweeps that must
     * find an address held by no launch at all. Never allocates, releases or
     * decrypts a key.
     *
     * `reservedAtMs` is when THIS reservation was taken (`reserved_at_ms`, epoch
     * ms, added by DAT-06). It is **null for a reservation taken before that
     * release** — the table genuinely kept no clock then — so a caller must treat
     * null as "unknown" and fall back to its own first-sighting row, never read
     * it as new. `mintCreatedAtMs` is when the ADDRESS entered the pool
     * (`kids_mints.created_at`) and is reported for context only: a mint
     * generated months ago can have been reserved a second ago, so it must never
     * be used to age a reservation. */
    listReservations(limit = 100) {
        if (this.closed)
            throw new Error("Inventory is closed");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
            throw new Error("Invalid mint reservation listing limit");
        const rows = this.db.prepare(`SELECT r.reservation_id,r.creator,r.draft_id,r.idempotency_key,r.mint,r.reserved_at_ms,m.status,m.created_at,
      EXISTS(SELECT 1 FROM kids_mint_signatures s WHERE s.mint=r.mint) AS signed
      FROM kids_mint_reservations r JOIN kids_mints m USING(mint)
      ORDER BY m.created_at, r.mint LIMIT ?`).all(limit);
        const epochMs = (value) => {
            const parsed = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : null;
            return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
        };
        return rows.map((row) => {
            const created = Date.parse(String(row.created_at));
            return { ...this.reservation(row), signed: Number(row.signed) === 1, reservedAtMs: epochMs(row.reserved_at_ms),
                mintCreatedAtMs: Number.isSafeInteger(created) && created > 0 ? created : null };
        });
    }
    /** Read-only lookup: recovery must never allocate a replacement for a lost reservation. */
    findReservation(binding) {
        if (this.closed)
            throw new Error("Inventory is closed");
        validateBinding(binding);
        const rows = this.db.prepare(`SELECT r.*, m.status FROM kids_mint_reservations r JOIN kids_mints m USING(mint)
      WHERE r.idempotency_key=? OR (r.creator=? AND r.draft_id=?)`).all(binding.idempotencyKey, binding.creator, binding.draftId);
        if (rows.length === 0)
            return null;
        if (rows.length !== 1)
            throw new Error("Conflicting mint reservations");
        const reservation = this.reservation(rows[0]);
        this.assertBinding(reservation, binding);
        return reservation;
    }
    /** Read-only operator projection of how fast this pool is being filled.
     * `kids_mints.created_at` is the ISO instant this inventory accepted the
     * address, so it is the only honest "found at" this store holds: a generator
     * that produced an address earlier is not recorded here. `secondsPerMint` is
     * derived from the ten-minute window when that window has any address in it
     * and from the hour otherwise; with neither, it is null rather than guessed. */
    refillActivity(nowMs = Date.now()) {
        if (this.closed)
            throw new Error("Inventory is closed");
        if (!Number.isFinite(nowMs))
            throw new Error("A finite clock reading is required");
        const since = (milliseconds) => new Date(nowMs - milliseconds).toISOString();
        const count = (from) => Number(this.db.prepare("SELECT COUNT(*) AS n FROM kids_mints WHERE created_at >= ?").get(from).n);
        const addedLastHour = count(since(3_600_000)), addedLast10m = count(since(600_000));
        const newest = this.db.prepare("SELECT MAX(created_at) AS at FROM kids_mints").get();
        const secondsPerMint = addedLast10m > 0 ? Math.round(600 / addedLast10m)
            : addedLastHour > 0 ? Math.round(3_600 / addedLastHour) : null;
        return { addedLastHour, addedLast10m, lastAddedAt: newest?.at ?? null, secondsPerMint };
    }
    /** How many unused addresses already carry an installed lookup-table coverage
     * proof. An available address WITH coverage under the launch runtime's own
     * required policy is exactly the one a Pump-lane launch can spend on an atomic
     * developer buy, so `availableCovered` under that policy IS the
     * "developer-buy ready" count; `availableUncovered` is what warm-up still owes.
     *
     * The predicate is deliberately the same join `reserve()` uses to pick a
     * covered mint (policy digest, and schema version 2 for the frozen-mint mode),
     * so this count can never claim readiness a reservation would then refuse.
     * Without a policy digest it counts coverage of any policy, which is a weaker
     * statement and is reported as such by the caller. */
    lookupCoverageCounts(options = {}) {
        if (this.closed)
            throw new Error("Inventory is closed");
        const { policySha256, frozenOnly = false } = options;
        if (policySha256 !== undefined && !/^[0-9a-f]{64}$/.test(policySha256))
            throw new Error("Lookup policy digest must be lowercase hex sha256");
        const one = (sql, ...parameters) => Number(this.db.prepare(sql).get(...parameters).n);
        const filter = `${policySha256 === undefined ? "" : " AND c.policy_sha256=?"}${frozenOnly ? " AND json_extract(c.coverage_json,'$.schemaVersion')=2" : ""}`;
        const parameters = policySha256 === undefined ? [] : [policySha256];
        return {
            covered: one(`SELECT COUNT(*) AS n FROM kids_mint_lookup_coverage_v1 c WHERE 1=1${filter}`, ...parameters),
            availableCovered: one(`SELECT COUNT(*) AS n FROM kids_mints m JOIN kids_mint_lookup_coverage_v1 c USING(mint) WHERE m.status='available'${filter}`, ...parameters),
            availableUncovered: one("SELECT COUNT(*) AS n FROM kids_mints m LEFT JOIN kids_mint_lookup_coverage_v1 c USING(mint) WHERE m.status='available' AND c.mint IS NULL"),
        };
    }
    counts() {
        const result = { available: 0, reserved: 0, signed: 0, quarantined: 0 };
        for (const row of this.db.prepare("SELECT status,COUNT(*) AS count FROM kids_mints GROUP BY status").all()) {
            result[row.status] = Number(row.count);
        }
        return result;
    }
    /** One generator per durable inventory, including overlapping process restarts. */
    acquireRefillLease(owner) {
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(owner))
            throw new Error("Invalid refill lease owner");
        return this.transaction(() => {
            const now = Date.now(), row = this.db.prepare("SELECT * FROM kids_mint_refill_lease WHERE singleton=1").get();
            if (row && Number(row.expires_at_ms) > now && row.owner !== owner)
                return null;
            const fence = row ? Number(row.fence) + (row.owner === owner && Number(row.expires_at_ms) > now ? 0 : 1) : 1;
            if (!Number.isSafeInteger(fence))
                throw new Error("Refill lease fence exhausted");
            const lease = Object.freeze({ owner, fence, expiresAtMs: now + 30_000 });
            this.db.prepare("INSERT INTO kids_mint_refill_lease VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,expires_at_ms=excluded.expires_at_ms")
                .run(owner, fence, lease.expiresAtMs);
            return lease;
        });
    }
    releaseRefillLease(lease) {
        this.transaction(() => { this.db.prepare("UPDATE kids_mint_refill_lease SET expires_at_ms=0 WHERE singleton=1 AND owner=? AND fence=?").run(lease.owner, lease.fence); });
    }
    /** Internal generator only. Takes ownership and wipes the supplied bytes on
     * every outcome. Never write plaintext mint files or accept HTTP input here.
     * Existing reserved/signed/quarantined entries are never released or replaced. */
    importGeneratedMint(secret, lease, targetAvailable = 100_000) {
        try {
            if (!Number.isSafeInteger(targetAvailable) || targetAvailable < 1 || targetAvailable > 100_000)
                throw new Error("Refill target must be bounded by 100000");
            const mintAddress = keyAddress(secret);
            assertPairMintAddress(mintAddress);
            return this.transaction(() => {
                const current = this.db.prepare("SELECT * FROM kids_mint_refill_lease WHERE singleton=1").get();
                if (!current || current.owner !== lease.owner || Number(current.fence) !== lease.fence || Number(current.expires_at_ms) <= Date.now())
                    throw new Error("Refill lease lost");
                if (this.db.prepare("SELECT 1 FROM kids_mints WHERE mint=?").get(mintAddress))
                    return { imported: false, reason: "duplicate" };
                if (Number(this.db.prepare("SELECT COUNT(*) AS total FROM kids_mints WHERE status='available'").get().total) >= targetAvailable)
                    return { imported: false, reason: "full" };
                const sealed = this.encrypt(secret, mintAddress);
                this.db.prepare("INSERT INTO kids_mints VALUES(?,?,?,?,'available',?,NULL)")
                    .run(mintAddress, sealed.nonce, sealed.ciphertext, sealed.tag, new Date().toISOString());
                return { imported: true, reason: "imported" };
            });
        }
        finally {
            secret.fill(0);
        }
    }
    /** Install a server-only Raydium authorization capability. The callback must
     * load durable asset bindings and reconstruct the exact message independently.
     * HTTP input supplies only reservation identity; never a message or private key.
     * Asset messages remain immutable per generation. Only the trusted launch retry
     * capability may admit a contiguous successor after terminal chain proof.
     */
    assetMintSigner(authorize) {
        return async (input) => {
            validateBinding(input);
            if (!input.idempotencyKey.startsWith('asset:') || input.draftId !== input.idempotencyKey)
                throw new Error('Asset reservation namespace required');
            if (this.closed)
                throw new Error('Mint inventory is closed');
            const approved = await authorize(Object.freeze({ ...input }));
            if (this.closed)
                throw new Error('Mint inventory is closed');
            assertLaunchMintAddress(approved.mint);
            if (approved.creator !== input.creator || !/^[a-f0-9]{64}$/.test(approved.intentHash))
                throw new Error('Asset authorization identity mismatch');
            const raw = Buffer.from(approved.packet, 'base64');
            if (raw.length > 1232 || raw.toString('base64') !== approved.packet)
                throw new Error('Invalid asset packet');
            const tx = VersionedTransaction.deserialize(raw), message = tx.message.serialize();
            const allowedTables = new Set((approved.lookupTables ?? []).map(address => { let key; try {
                key = new PublicKey(address);
            }
            catch {
                throw new Error('Invalid authorized lookup table');
            } if (key.toBase58() !== address)
                throw new Error('Invalid authorized lookup table'); return address; }));
            if (allowedTables.size > 4)
                throw new Error('Invalid authorized lookup table');
            const lookups = tx.message.addressTableLookups.map(lookup => lookup.accountKey.toBase58());
            if (lookups.length > allowedTables.size || new Set(lookups).size !== lookups.length || lookups.some(address => !allowedTables.has(address)))
                throw new Error('Asset message differs from independently rebuilt authorization');
            if (tx.version !== 0 || !Buffer.from(message).equals(Buffer.from(approved.message)) || !Buffer.from(tx.serialize()).equals(raw))
                throw new Error('Asset message differs from independently rebuilt authorization');
            const keys = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
            if (keys.length !== 2 || keys[0].toBase58() !== input.creator || keys[1].toBase58() !== approved.mint || tx.signatures.length !== 2 || approved.mint === input.creator)
                throw new Error('Asset mint is not the independent reserved signer');
            tx.signatures.forEach((sig, i) => { if (!isZero(sig) && !ed25519.verify(sig, message, keys[i].toBytes()))
                throw new Error('Invalid asset signature'); });
            if (approved.retry && isZero(tx.signatures[0]))
                throw new Error('Fresh creator signature required for asset retry');
            const intentHash = hash('raydium-asset-v1:' + approved.intentHash), messageHash = hash(message), generation = approved.retry?.generation ?? 0;
            if (!Number.isInteger(generation) || generation < 0 || generation > 2 || (approved.retry && !/^[a-f0-9]{64}$/.test(approved.retry.previousMessageSha256)))
                throw new Error('Invalid bounded asset retry generation');
            let corruptMint;
            try {
                return this.transaction(() => {
                    approved.assertActive?.();
                    const row = this.db.prepare('SELECT r.*,m.status,m.intent_hash,m.nonce,m.ciphertext,m.tag FROM kids_mint_reservations r JOIN kids_mints m USING(mint) WHERE reservation_id=?').get(input.reservationId);
                    if (!row)
                        throw new Error('Unknown mint reservation');
                    const reservation = this.reservation(row);
                    this.assertBinding(reservation, input);
                    if (!['reserved', 'signed'].includes(reservation.status) || reservation.mintAddress !== approved.mint)
                        throw new Error('Asset mint reservation differs');
                    if (row.intent_hash !== null && row.intent_hash !== intentHash)
                        throw new Error('Mint already bound to another intent or route');
                    if (approved.retry) {
                        const prior = this.db.prepare('SELECT * FROM kids_mint_signatures WHERE mint=? AND generation=?').get(approved.mint, generation - 1);
                        if (!prior || prior.message_hash !== approved.retry.previousMessageSha256)
                            throw new Error('Asset retry must retain its exact preceding mint signature');
                    }
                    const previous = this.db.prepare('SELECT * FROM kids_mint_signatures WHERE mint=? AND generation=?').get(approved.mint, generation);
                    if (previous && previous.message_hash !== messageHash)
                        throw new Error('Asset reservation already signed another message');
                    let signature;
                    if (previous) {
                        signature = previous.signature;
                        if (!ed25519.verify(signature, message, keys[1].toBytes()))
                            throw new Error('Stored asset signature invalid');
                    }
                    else {
                        let clear;
                        try {
                            clear = this.decrypt(row, approved.mint);
                            if (keyAddress(clear) !== approved.mint)
                                throw new Error();
                            signature = ed25519.sign(message, clear.subarray(0, 32));
                        }
                        catch {
                            corruptMint = approved.mint;
                            throw new Error('Mint key authentication failed; reservation quarantined');
                        }
                        finally {
                            clear?.fill(0);
                        }
                        this.db.prepare('INSERT INTO kids_mint_signatures VALUES(?,?,?,?)').run(approved.mint, generation, messageHash, signature);
                        this.db.prepare("UPDATE kids_mints SET status='signed',intent_hash=? WHERE mint=?").run(intentHash, approved.mint);
                    }
                    tx.signatures[1] = signature;
                    return { reservation: { ...reservation, status: 'signed' }, generation, messageSha256: messageHash, transactionBase64: Buffer.from(tx.serialize()).toString('base64') };
                });
            }
            catch (error) {
                if (corruptMint)
                    this.db.prepare("UPDATE kids_mints SET status='quarantined' WHERE mint=?").run(corruptMint);
                throw error;
            }
        };
    }
    /** Only a server-rebuilt trusted plan and its durable prepared generation can be signed. */
    async signPreparedMint(input) {
        input.assertActive?.();
        validateBinding(input);
        const { plan, generation } = input;
        const direct = "executionMode" in plan;
        const assertLookupCoverage = () => {
            if (!direct || (plan.serializableIntent.schemaVersion !== 3 && plan.serializableIntent.zeroBuyLookupMode === undefined))
                return;
            const zeroBuy = plan.serializableIntent.zeroBuyLookupMode !== undefined;
            if (zeroBuy && (plan.serializableIntent.schemaVersion !== 2 || plan.serializableIntent.zeroBuyLookupMode !== "static-plus-frozen-mint-v1"
                || !input.requiredLookupGenesisHash || plan.intent.initialBuyLamports !== 0n))
                throw new Error("Zero-buy mint signing requires exact installed lookup identity");
            if (!input.requiredLookupPolicySha256 || !/^[a-f0-9]{64}$/.test(input.requiredLookupPolicySha256))
                throw new Error("Developer buy mint signing requires an explicit installed lookup policy");
            const coverage = this.lookupCoverage(plan.intent.mint.toBase58());
            const buy = plan.serializableIntent.developerBuy;
            const tables = coverage ? mintLookupCoverageTables(coverage) : [];
            if (!coverage || (zeroBuy ? Boolean(buy) || coverage.schemaVersion !== 2 : !buy) || coverage.policySha256 !== input.requiredLookupPolicySha256
                || (coverage.schemaVersion === 2 && input.requiredLookupMode !== "static-plus-frozen-mint-v1")
                || coverage.operator !== plan.registration.operator.toBase58() || coverage.routerProgramId !== plan.registration.programId.toBase58()
                || coverage.genesisHash !== (zeroBuy ? input.requiredLookupGenesisHash : buy.quote.genesisHash) || plan.lookupTables.length !== tables.length
                || plan.lookupTables.some((table, tableIndex) => {
                    const expected = tables[tableIndex];
                    return !expected || table.key.toBase58() !== expected.address || !table.isActive()
                        || table.state.lastExtendedSlot >= coverage.finalizedSlot || (table.state.authority?.toBase58() ?? null) !== expected.authority
                        || table.state.addresses.length !== expected.expectedAddresses.length
                        || table.state.addresses.some((address, i) => address.toBase58() !== expected.expectedAddresses[i]);
                })) {
                throw new Error("Developer buy mint signing requires the exact installed finalized lookup coverage");
            }
        };
        assertLookupCoverage();
        if (!direct)
            assertSameLaunchIntent(serializeLaunchIntent(plan.intent, plan.rewardRouter), plan.serializableIntent);
        if (!Number.isSafeInteger(generation) || generation < 0 || input.idempotencyKey !== plan.intent.idempotencyKey
            || input.creator !== plan.intent.creator.toBase58() || input.creator !== plan.intent.payer.toBase58()) {
            throw new Error("Mint signing identity does not match the trusted launch plan");
        }
        const prepared = await this.executionStore.load(input.idempotencyKey);
        if (input.creatorFirst && !direct)
            throw new Error("Creator-first mint signing requires a direct launch");
        if (!prepared?.attempt || prepared.launchId !== input.idempotencyKey || prepared.status !== (input.creatorFirst ? "signing" : "awaiting-signatures")
            || prepared.attempt.generation !== generation)
            throw new Error("No matching durable prepared mint generation");
        if (input.creatorFirst && (prepared.revision !== input.claimedRevision || prepared.attempt.transactionBase64 !== input.claimedTransactionBase64))
            throw new Error("Creator-first mint signing requires the exact durable signing claim");
        if (direct)
            assertSameDirectBatchLaunchIntent(prepared.intent, plan.serializableIntent);
        else
            assertSameLaunchIntent(prepared.intent, plan.serializableIntent);
        const attempt = prepared.attempt;
        if (attempt.stage !== "atomic" && !(attempt.stage === "create-mint" && this.allowNonAtomic)) {
            throw new Error("Mint signing requires atomic launch creation; non-atomic exception is not enabled");
        }
        const expected = direct ? compileDirectBatchLaunchTransaction(plan, attempt.stage, attempt.blockhash, this.codec)
            : compileLaunchTransaction(plan, attempt.stage, attempt.blockhash, this.codec);
        const encoded = attempt.transactionBase64;
        if (encoded.length > 1_644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
            throw new Error("Invalid prepared transaction encoding");
        const raw = Buffer.from(encoded, "base64");
        if (raw.length > 1_232 || raw.toString("base64") !== encoded)
            throw new Error("Invalid prepared transaction encoding");
        const transaction = VersionedTransaction.deserialize(raw);
        const message = transaction.message.serialize();
        if (transaction.version !== 0 || !Buffer.from(message).equals(Buffer.from(expected.message.serialize()))
            || hash(message) !== attempt.messageSha256)
            throw new Error("Prepared message does not exactly match the trusted launch plan");
        const signerKeys = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures);
        const mintIndex = signerKeys.findIndex((key) => key.equals(plan.intent.mint));
        if (mintIndex < 0 || plan.intent.mint.equals(plan.intent.payer) || plan.intent.mint.equals(direct ? plan.registration.operator : plan.rewardRouter.operator)
            || transaction.signatures.length !== signerKeys.length)
            throw new Error("Reserved mint is not an independent required signer");
        transaction.signatures.forEach((signature, index) => {
            if (!isZero(signature) && !ed25519.verify(signature, message, signerKeys[index].toBytes()))
                throw new Error("Invalid existing prepared signature");
        });
        if (input.creatorFirst) {
            const creatorIndex = signerKeys.findIndex(key => key.equals(plan.intent.creator));
            if (creatorIndex !== 0 || isZero(transaction.signatures[creatorIndex])
                || !ed25519.verify(transaction.signatures[creatorIndex], message, plan.intent.creator.toBytes()))
                throw new Error("Creator approval is required before mint signing");
        }
        // Sorted-key canonical JSON: `JSON.stringify` is key-order dependent, and
        // this hash is PERSISTED in kids_mints.intent_hash. Reordering or
        // inserting one field in serializeLaunchIntent — a routine change — used to
        // throw "Mint has already signed a different immutable intent" for every
        // reserved mint, permanently bricking those vanity addresses (COD-19).
        const intentHash = hash(canonicalIntentJson(plan.serializableIntent));
        // Migration: a mint reserved before the canonical hash landed carries the
        // legacy one. Accept it when re-verifying; only write canonical.
        const legacyIntentHash = hash(JSON.stringify(plan.serializableIntent));
        let corruptMint;
        try {
            return this.transaction(() => {
                const row = this.db.prepare(`SELECT r.*, m.status, m.intent_hash, m.nonce, m.ciphertext, m.tag
          FROM kids_mint_reservations r JOIN kids_mints m USING(mint) WHERE reservation_id=?`).get(input.reservationId);
                if (!row)
                    throw new Error("Unknown mint reservation");
                const reservation = this.reservation(row);
                this.assertBinding(reservation, input);
                assertLookupCoverage();
                if (!["reserved", "signed"].includes(reservation.status) || reservation.mintAddress !== plan.intent.mint.toBase58())
                    throw new Error("Mint reservation does not match the prepared launch");
                if (row.intent_hash !== null && row.intent_hash !== intentHash && row.intent_hash !== legacyIntentHash)
                    throw new Error("Mint has already signed a different immutable intent");
                const previous = this.db.prepare("SELECT * FROM kids_mint_signatures WHERE mint=? AND generation=?").get(reservation.mintAddress, generation);
                if (previous && previous.message_hash !== attempt.messageSha256)
                    throw new Error("Generation is already bound to a different message");
                const latest = this.db.prepare("SELECT MAX(generation) AS generation FROM kids_mint_signatures WHERE mint=?").get(reservation.mintAddress);
                if (!previous && latest?.generation !== null && Number(latest?.generation) >= generation)
                    throw new Error("Mint signing generation is stale");
                let signature;
                if (previous) {
                    signature = previous.signature;
                    if (!ed25519.verify(signature, message, plan.intent.mint.toBytes()))
                        throw new Error("Stored mint signature is invalid");
                }
                else {
                    // Last synchronous boundary after the awaited execution-store read.
                    // No await occurs through decrypt/sign/persist. An abort is not key
                    // corruption and must never quarantine or erase this reservation.
                    input.assertActive?.();
                    // The corrupt-marking catch covers decrypt and identity ONLY. A
                    // transient failure inside @noble/curves (OOM, a version bump
                    // tightening input validation, a Buffer/Uint8Array subarray change)
                    // must never permanently quarantine an intact vanity mint: that
                    // address is unrecoverable inventory (COD-18).
                    let clear, seed;
                    try {
                        clear = this.decrypt(row, reservation.mintAddress);
                        if (keyAddress(clear) !== reservation.mintAddress)
                            throw new Error("Encrypted mint identity does not match");
                        seed = Uint8Array.from(clear.subarray(0, 32));
                    }
                    catch {
                        corruptMint = reservation.mintAddress;
                        throw new Error("Mint key authentication failed; reservation quarantined");
                    }
                    finally {
                        clear?.fill(0);
                    }
                    try {
                        signature = ed25519.sign(message, seed);
                    }
                    finally {
                        seed.fill(0);
                    }
                    this.db.prepare("INSERT INTO kids_mint_signatures VALUES(?,?,?,?)").run(reservation.mintAddress, generation, attempt.messageSha256, signature);
                    this.db.prepare("UPDATE kids_mints SET status='signed',intent_hash=? WHERE mint=?").run(intentHash, reservation.mintAddress);
                }
                transaction.signatures[mintIndex] = signature;
                return { reservation: { ...reservation, status: "signed" }, generation, messageSha256: attempt.messageSha256,
                    transactionBase64: Buffer.from(transaction.serialize()).toString("base64") };
            });
        }
        catch (error) {
            if (corruptMint)
                this.db.prepare("UPDATE kids_mints SET status='quarantined' WHERE mint=?").run(corruptMint);
            throw error;
        }
    }
    close() {
        if (!this.closed) {
            this.closed = true;
            this.db.close();
            this.key.fill(0);
        }
    }
}
