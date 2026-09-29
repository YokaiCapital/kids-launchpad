import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { startPrivateMintImportServer } from "./mint-import-server.js";
import { MINT_REFILL_POLICY } from "./mint-refill-core.js";
const MiB = 1_048_576;
/** Children are stateless CPU-bound ed25519 generators: a 64 MiB old space is
 * ample (measured RSS is well under 100 MiB) and 96 MiB is the budgeted worst
 * case per child. The watchdog thresholds are fractions of the cgroup limit. */
export const MINT_REFILL_POOL_POLICY = Object.freeze({
    childExecArgv: Object.freeze(["--max-old-space-size=64", "--max-semi-space-size=4"]),
    perChildBytes: 96 * MiB, reserveBytes: 384 * MiB, webReserveBytes: 768 * MiB,
    watchMilliseconds: 5_000, pauseRatio: 0.85, shedRatio: 0.92, resumeRatio: 0.75,
    recycleJobs: 2_000, maximumReplacements: 5, replacementWindowMilliseconds: 60_000,
});
const readBytes = (read, paths) => {
    for (const path of paths) {
        try {
            const value = Number(read(path).trim());
            if (Number.isFinite(value) && value > 0)
                return value;
        }
        catch { /* next source */ }
    }
    return null;
};
/** cgroup v2, then v1, then host memory. Usage is unknown outside a cgroup
 * (child RSS is not cheaply visible to the parent), so the watchdog skips. */
export function systemMemoryReaders(read = path => readFileSync(path, "utf8")) {
    return { limitBytes: () => Math.min(readBytes(read, ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) ?? Infinity, totalmem()),
        currentBytes: () => readBytes(read, ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]), parallelism: availableParallelism };
}
/** min(configured, CPUs, floor((limit - reserve) / perChild)), never below 1.
 * The reserve is what the parent keeps for itself; an HTTP-serving API parent
 * keeps twice as much as a compute-only parent would. */
export function deriveMintRefillProcesses(input) {
    const reserveBytes = input.webParent ? MINT_REFILL_POOL_POLICY.webReserveBytes : MINT_REFILL_POOL_POLICY.reserveBytes, perChildBytes = MINT_REFILL_POOL_POLICY.perChildBytes;
    const limitBytes = Number.isFinite(input.limitBytes) && input.limitBytes > 0 ? Math.floor(input.limitBytes) : 0;
    const parallelism = Number.isInteger(input.parallelism) && input.parallelism > 0 ? input.parallelism : 1;
    const budget = Math.max(1, Math.floor((limitBytes - reserveBytes) / perChildBytes));
    return { processes: Math.max(1, Math.min(input.configured, parallelism, budget)), configured: input.configured, parallelism, budget, limitBytes, reserveBytes, perChildBytes };
}
/** One fenced importer owns the encrypted inventory; children only search.
 * Each child gets a bounded job and must return before receiving another.
 * Lease loss, abort, malformed IPC and saturation stop the pool. Children hold
 * no state, so a crashed, stalled, memory-shed or aged child is replaced
 * individually; only a crash burst (more than maximumReplacements within the
 * window) fails the run. The cgroup watchdog pauses job dispatch above
 * pauseRatio, sheds the oldest child above shedRatio and grows back one child
 * per check once usage is below resumeRatio.
 */
export async function runParallelMintRefill(options) {
    if (!Number.isInteger(options.processes) || options.processes < 1 || options.processes > 20)
        throw new Error("Invalid compute count");
    const { inventory, signal } = options, owner = randomUUID(), now = options.now ?? Date.now, memory = options.memory ?? systemMemoryReaders(), policy = MINT_REFILL_POOL_POLICY;
    // This pool only runs inside the API process (start.mjs loads main.js after
    // it, whether or not the private import server is enabled), so the parent
    // keeps the HTTP-serving reserve unless a caller states otherwise.
    const derived = deriveMintRefillProcesses({ configured: options.processes, parallelism: memory.parallelism(), limitBytes: memory.limitBytes(), webParent: options.webParent ?? true });
    let lease = null;
    const children = new Set(), pending = new Map(), jobs = new Map(), failures = [];
    let stopping = false, lastReport = 0, lastIdentity = "", trials = 0, startedAt = now();
    let poolActive = false, memoryPaused = false, recycling = false, shed = 0, recycled = 0, replaced = 0, watchedAt = -Infinity, usedBytes = null;
    let fail = () => { };
    let importer;
    const terminate = (child) => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 1_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
    });
    const stopChildren = async () => {
        const current = [...children];
        children.clear();
        pending.clear();
        jobs.clear();
        poolActive = false;
        memoryPaused = false;
        recycling = false;
        shed = 0;
        await Promise.all(current.map(terminate));
    };
    const request = (child) => {
        if (stopping || signal.aborted || !lease || !children.has(child) || pending.has(child) || memoryPaused)
            return;
        if (lease.expiresAtMs <= now()) {
            fail(Error("Refill lease expired"));
            return;
        }
        if (inventory.counts().available >= MINT_REFILL_POLICY.targetAvailable)
            return;
        pending.set(child, now());
        child.send("generate", error => { if (error && !stopping)
            retire(child, "failed"); });
    };
    const retire = (child, reason) => {
        if (!children.has(child))
            return;
        children.delete(child);
        pending.delete(child);
        jobs.delete(child);
        const exited = terminate(child);
        if (reason === "idle" || reason === "shed") {
            shed++;
            return;
        }
        if (reason === "recycled") {
            recycled++;
            recycling = true;
            void exited.then(() => { recycling = false; }, () => { recycling = false; });
            return;
        }
        const since = now() - policy.replacementWindowMilliseconds;
        while (failures.length && failures[0] < since)
            failures.shift();
        failures.push(now());
        if (failures.length > policy.maximumReplacements) {
            fail(Error("Compute processes failing"));
            return;
        }
        replaced++;
        // Reached from child event handlers: a spawn failure must fail the run, not the thread.
        if (poolActive && !stopping)
            try {
                spawnChild();
            }
            catch {
                fail(Error("Compute scheduling failed"));
            }
    };
    const spawnChild = () => {
        const child = (options.spawn ?? fork)(fileURLToPath(new URL("./mint-refill-process.js", import.meta.url)), [], {
            env: { NODE_ENV: "production" }, execArgv: [...policy.childExecArgv], serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        children.add(child);
        jobs.set(child, 0);
        child.on("error", () => { if (!stopping)
            retire(child, "failed"); });
        // A child that idles out (its own 5 s watchdog) while dispatch is paused
        // has simply returned its memory; it is regrown by the watchdog, not
        // counted as a crash.
        child.on("exit", code => { if (!stopping && children.has(child))
            retire(child, code === 0 && memoryPaused && !pending.has(child) ? "idle" : "failed"); });
        child.on("message", (message) => {
            const value = message;
            const winners = Array.isArray(value?.winners) ? value.winners : [];
            try {
                if (stopping || signal.aborted || !children.has(child))
                    return;
                if (!pending.has(child) || !value || !Number.isSafeInteger(value.trials) || Number(value.trials) < 1
                    || Number(value.trials) > 16_384 || !Array.isArray(value.winners) || winners.length > 4
                    || winners.some(w => !(w instanceof Uint8Array) || w.length !== 64))
                    throw Error("Invalid compute response");
                pending.delete(child);
                trials += Number(value.trials);
                const done = (jobs.get(child) ?? 0) + 1;
                jobs.set(child, done);
                if (!lease)
                    throw Error("Refill lease absent");
                for (const winner of winners) {
                    if (signal.aborted || inventory.counts().available >= MINT_REFILL_POLICY.targetAvailable)
                        break;
                    inventory.importGeneratedMint(winner, lease, MINT_REFILL_POLICY.targetAvailable);
                }
                // Avoid sending the next job before the child's send callback runs.
                // Recycling spawns the successor first so throughput never reaches zero.
                setImmediate(() => {
                    try {
                        if (stopping || !children.has(child))
                            return;
                        if (done >= policy.recycleJobs && !recycling && !memoryPaused) {
                            spawnChild();
                            retire(child, "recycled");
                        }
                        else
                            request(child);
                    }
                    catch {
                        fail(Error("Compute scheduling failed"));
                    }
                });
            }
            catch {
                fail(Error("Refill process failed"));
            }
            finally {
                for (const winner of winners)
                    if (winner instanceof Uint8Array)
                        winner.fill(0);
            }
        });
        request(child);
        return child;
    };
    const startChildren = () => {
        startedAt = now();
        trials = 0;
        poolActive = true;
        for (let i = 0; i < derived.processes; i++)
            spawnChild();
    };
    const watch = () => {
        if (now() - watchedAt < policy.watchMilliseconds)
            return;
        watchedAt = now();
        const current = memory.currentBytes();
        usedBytes = current;
        if (current === null || !derived.limitBytes)
            return;
        const ratio = current / derived.limitBytes;
        if (ratio > policy.shedRatio) {
            memoryPaused = true;
            const oldest = children.values().next().value;
            if (oldest)
                retire(oldest, "shed");
        }
        else if (ratio > policy.pauseRatio)
            memoryPaused = true;
        else if (ratio < policy.resumeRatio) {
            if (memoryPaused) {
                memoryPaused = false;
                for (const child of [...children])
                    request(child);
            }
            if (shed > 0 && poolActive && !stopping) {
                shed--;
                spawnChild();
            }
        }
    };
    let timer;
    let abort = () => { };
    try {
        if (options.remoteImport)
            importer = await startPrivateMintImportServer({ ...options.remoteImport,
                status: () => ({ available: inventory.counts().available, accepting: !stopping && !signal.aborted
                        && !options.paused?.() && !!lease && lease.expiresAtMs > Date.now() && inventory.counts().available < MINT_REFILL_POLICY.targetAvailable }),
                importMint: secret => {
                    if (!lease || stopping || signal.aborted || options.paused?.())
                        throw Error("Importer inactive");
                    return inventory.importGeneratedMint(secret, lease, MINT_REFILL_POLICY.targetAvailable);
                },
            });
        await new Promise((resolve, reject) => {
            fail = error => { stopping = true; reject(error); };
            abort = () => { stopping = true; resolve(); };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
                abort();
                return;
            }
            let ticking = false;
            const tick = async () => {
                if (ticking || stopping)
                    return;
                ticking = true;
                try {
                    const available = inventory.counts().available;
                    let state;
                    if (available >= MINT_REFILL_POLICY.targetAvailable || options.paused?.()) {
                        await stopChildren();
                        if (lease) {
                            inventory.releaseRefillLease(lease);
                            lease = null;
                        }
                        state = available >= MINT_REFILL_POLICY.targetAvailable ? "full" : "paused";
                    }
                    else {
                        lease = inventory.acquireRefillLease(owner);
                        if (!lease) {
                            await stopChildren();
                            state = "standby";
                        }
                        else {
                            if (!poolActive)
                                startChildren();
                            watch();
                            for (const [child, since] of [...pending])
                                if (now() - since > 5_000)
                                    retire(child, "failed");
                            state = memoryPaused ? "memory-paused" : "refilling";
                        }
                    }
                    if (stopping)
                        return;
                    const identity = `${state}:${available}:${shed}:${replaced}`;
                    if (identity !== lastIdentity || now() - lastReport >= 30_000) {
                        lastReport = now();
                        lastIdentity = identity;
                        options.report({ state, available, target: MINT_REFILL_POLICY.targetAvailable, processes: Math.min(20, children.size),
                            candidatesPerSecond: Math.round(trials / Math.max(1, (now() - startedAt) / 1_000)),
                            configuredProcesses: derived.configured, derivedProcesses: derived.processes, parallelism: derived.parallelism,
                            memoryLimitMiB: Math.round(derived.limitBytes / MiB), memoryReserveMiB: Math.round(derived.reserveBytes / MiB), memoryPerChildMiB: Math.round(derived.perChildBytes / MiB),
                            ...(usedBytes === null ? {} : { memoryUsedMiB: Math.round(usedBytes / MiB) }), shed, recycled, replaced });
                    }
                }
                catch {
                    fail(Error("Parallel refill unavailable"));
                }
                finally {
                    ticking = false;
                }
            };
            timer = setInterval(() => { void tick(); }, options.tickMilliseconds ?? 1_000);
            void tick();
        });
    }
    finally {
        stopping = true;
        if (timer)
            clearInterval(timer);
        signal.removeEventListener("abort", abort);
        await stopChildren();
        await importer?.close();
        options.remoteImport?.token.fill(0);
        if (lease)
            inventory.releaseRefillLease(lease);
    }
}
