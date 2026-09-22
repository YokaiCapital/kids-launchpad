import { generateKeyPairSync, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
// Owner decision 10 Sep 2026: keep 100 000 coin addresses ready and refill whenever the reserve dips below.
export const MINT_REFILL_POLICY = Object.freeze({ targetAvailable: 100_000, workMilliseconds: 25,
    minimumPauseMilliseconds: 100, fullPollMilliseconds: 1_000, maximumTrialsPerSlice: 512 });
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const modulus = 58 ** 4, wanted = [..."kids"].reduce((n, char) => n * 58 + alphabet.indexOf(char), 0);
/** Equivalent to exact case-sensitive Base58 suffix, without encoding every losing candidate. */
export function mintHasKidsSuffix(publicBytes) {
    if (publicBytes.length !== 32)
        return false;
    let remainder = 0;
    for (const byte of publicBytes)
        remainder = (remainder * 256 + byte) % modulus;
    return remainder === wanted;
}
/** Native CSPRNG/Ed25519. Losing private KeyObjects never leave the crypto
 * engine; only a winning mint seed is exported, then consumed by encryption. */
export function generateKidsMintCandidate() {
    const generated = generateKeyPairSync("ed25519");
    const publicDer = generated.publicKey.export({ format: "der", type: "spki" });
    if (publicDer.length !== 44 || publicDer.subarray(0, 12).toString("hex") !== "302a300506032b6570032100")
        throw new Error("Unexpected native mint public encoding");
    const publicBytes = publicDer.subarray(12);
    if (!mintHasKidsSuffix(publicBytes))
        return null;
    const privateDer = generated.privateKey.export({ format: "der", type: "pkcs8" });
    try {
        if (privateDer.length !== 48 || privateDer.subarray(0, 16).toString("hex") !== "302e020100300506032b657004220420")
            throw new Error("Unexpected native mint private encoding");
        return Buffer.concat([privateDer.subarray(16), publicBytes]);
    }
    finally {
        privateDer.fill(0);
    }
}
/** Injected clock/candidate are for offline tests. Production always uses the
 * fixed native generator in one isolated thread, with no network capability. */
export async function runMintRefill(options) {
    const { inventory, signal } = options, owner = options.owner ?? randomUUID();
    const generate = options.generate ?? generateKidsMintCandidate, now = options.now ?? (() => performance.now());
    const wait = options.wait ?? (async (ms, abort) => { await delay(ms, undefined, { signal: abort }); });
    let lease = null, reportedAt = -Infinity, previous = "";
    const report = (state, available) => {
        const identity = `${state}:${available}`, time = now();
        if (identity !== previous || time - reportedAt >= 60_000) {
            options.report?.({ state, available, target: MINT_REFILL_POLICY.targetAvailable });
            reportedAt = time;
            previous = identity;
        }
    };
    try {
        while (!signal.aborted) {
            const available = inventory.counts().available;
            if (available >= MINT_REFILL_POLICY.targetAvailable) {
                if (lease) {
                    inventory.releaseRefillLease(lease);
                    lease = null;
                }
                report("full", available);
                await wait(MINT_REFILL_POLICY.fullPollMilliseconds, signal);
                continue;
            }
            lease = inventory.acquireRefillLease(owner);
            if (!lease) {
                report("standby", available);
                await wait(1_000, signal);
                continue;
            }
            report("refilling", available);
            const start = now();
            for (let trials = 0; trials < MINT_REFILL_POLICY.maximumTrialsPerSlice && now() - start < MINT_REFILL_POLICY.workMilliseconds && !signal.aborted; trials++) {
                const candidate = generate();
                if (candidate) {
                    try {
                        if (signal.aborted)
                            break;
                        const inserted = inventory.importGeneratedMint(candidate, lease, MINT_REFILL_POLICY.targetAvailable);
                        if (inserted.reason === "full")
                            break;
                    }
                    finally {
                        candidate.fill(0);
                    }
                }
            }
            // At least four times the work slice is idle: <=20% intended CPU duty,
            // including encryption/SQLite time, without blocking the API event loop.
            await wait(Math.max(MINT_REFILL_POLICY.minimumPauseMilliseconds, Math.ceil(Math.max(0, now() - start) * 4)), signal);
        }
    }
    catch (error) {
        if (!signal.aborted)
            throw error;
    }
    finally {
        if (lease)
            inventory.releaseRefillLease(lease);
    }
}
