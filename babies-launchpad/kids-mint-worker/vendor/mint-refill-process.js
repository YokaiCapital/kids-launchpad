import { generateKidsMintCandidate } from "./mint-refill-core.js";
// No inventory, encryption keys, RPC credentials or environment are passed to
// these compute-only children. Winners travel only over the private IPC pipe.
if (!process.send)
    throw new Error("Private generator IPC required");
let busy = false;
const watchdog = setTimeout(() => process.exit(0), 5_000);
process.on("disconnect", () => process.exit(0));
process.on("message", message => {
    if (message !== "generate" || busy) {
        process.exit(1);
    }
    busy = true;
    watchdog.refresh();
    const winners = [];
    let trials = 0;
    try {
        const end = performance.now() + 250;
        while (trials < 16_384 && performance.now() < end) {
            const candidate = generateKidsMintCandidate();
            trials++;
            if (candidate)
                winners.push(candidate);
            if (winners.length >= 4)
                break;
        }
        busy = false;
        process.send({ trials, winners }, error => {
            for (const winner of winners)
                winner.fill(0);
            if (error)
                process.exit(1);
            watchdog.refresh();
        });
    }
    catch {
        for (const winner of winners)
            winner.fill(0);
        process.exit(1);
    }
});
