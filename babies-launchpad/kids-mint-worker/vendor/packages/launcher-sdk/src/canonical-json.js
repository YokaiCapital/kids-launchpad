/** Key-order-independent JSON for launch identity (COD-19).
 *
 * `JSON.stringify` preserves insertion order, so reordering or inserting one
 * field in `serializeLaunchIntent`/`serializeDirectBatchV2Intent` — a routine
 * change — used to make every in-flight record throw "already bound to a
 * different launch intent" and every reserved mint throw "Mint has already
 * signed a different immutable intent", permanently bricking those vanity
 * addresses. `direct-initial-buy.ts` already compared its snapshot this way;
 * this is that replacer, in one place, for every intent hash and comparison.
 */
export function canonicalIntentJson(value) {
    return JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))
        : entry);
}
