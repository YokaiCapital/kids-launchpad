import { parseDirectInitialBuySnapshot, serializeDirectInitialBuySnapshot } from "./direct-initial-buy.js";
import { deriveDirectInitialBuyMintLookupAccounts } from "./direct-initial-buy.js";
import { PublicKey } from "@solana/web3.js";
export function validateAtomicDeveloperBuyPolicy(value) {
    const fields = ["mode", "maximumSolInputLamports", "slippageBps", "maximumSlippageBps", "maximumCreatorDebitLamports", "maximumCreatorOverheadLamports", "maximumNetworkFeeLamports", "lookupPolicySha256", "snapshot"];
    const hasLookupMode = value !== null && typeof value === "object" && Object.hasOwn(value, "lookupMode");
    if (hasLookupMode)
        fields.push("lookupMode");
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length
        || fields.some(field => { const d = Object.getOwnPropertyDescriptor(value, field); return !d || !Object.hasOwn(d, "value") || !d.enumerable; }))
        throw new Error("Exact atomic developer buy policy required");
    for (const amount of [value.maximumSolInputLamports, value.maximumCreatorDebitLamports, value.maximumCreatorOverheadLamports, value.maximumNetworkFeeLamports]) {
        if (typeof amount !== "string" || !/^[1-9][0-9]{0,15}$/.test(amount) || BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error("Bounded exact developer buy policy amount required");
    }
    if (value.mode !== "pump-exact-sol-after-sharing-v1" || (hasLookupMode && value.lookupMode !== "static-plus-frozen-mint-v1") || !/^[a-f0-9]{64}$/.test(value.lookupPolicySha256)
        || !Number.isSafeInteger(value.slippageBps) || !Number.isSafeInteger(value.maximumSlippageBps)
        || value.slippageBps < 0 || value.slippageBps > value.maximumSlippageBps || value.maximumSlippageBps > 9999
        || BigInt(value.maximumCreatorDebitLamports) <= BigInt(value.maximumSolInputLamports)
        || BigInt(value.maximumCreatorDebitLamports) !== BigInt(value.maximumSolInputLamports) + BigInt(value.maximumCreatorOverheadLamports)
        || BigInt(value.maximumNetworkFeeLamports) >= BigInt(value.maximumCreatorDebitLamports))
        throw new Error("Atomic developer buy policy differs");
    const result = { ...value, snapshot: serializeDirectInitialBuySnapshot(parseDirectInitialBuySnapshot(value.snapshot)) };
    const freeze = (v) => { if (v && typeof v === "object") {
        Object.values(v).forEach(freeze);
        Object.freeze(v);
    } };
    freeze(result);
    return result;
}
/** Browser-safe deterministic contents, not an on-chain proof. An unknown table
 * must independently be read as finalized, frozen, active and fully warmed with
 * exactly these indexes before a wallet relies on it to interpret a message. */
export function deriveFrozenMintLookupTableSnapshot(input) {
    const fields = ["mint", "operator", "routerProgramId", "tableAddress"];
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== fields.length
        || fields.some(field => { const d = Object.getOwnPropertyDescriptor(input, field); return !d || !Object.hasOwn(d, "value") || !d.enumerable; })) {
        throw new Error("Exact frozen mint lookup identity required");
    }
    for (const field of fields) {
        const value = input[field];
        if (typeof value !== "string")
            throw new Error("Canonical frozen mint lookup identity required");
        const key = new PublicKey(value);
        if (key.toBase58() !== value || key.equals(PublicKey.default)
            || ((field === "mint" || field === "operator") && !PublicKey.isOnCurve(key.toBytes()))) {
            throw new Error("Canonical non-default on-curve mint and operator required");
        }
    }
    if (new Set(Object.values(input)).size !== fields.length)
        throw new Error("Distinct frozen mint lookup identities required");
    const expectedAddresses = Object.freeze(Object.values(deriveDirectInitialBuyMintLookupAccounts({
        mint: input.mint, operator: input.operator, routerProgramId: input.routerProgramId,
    })));
    return Object.freeze({ address: input.tableAddress, authority: null, expectedAddresses });
}
/** Canonical key order; array order (especially ALT indices) is significant.
 * The browser compares its SHA-256 to a separately approved build-time pin. */
export function canonicalBrowserLaunchPolicyJson(policy) {
    const canonical = (value) => {
        if (value === null || typeof value === "string" || typeof value === "boolean")
            return value;
        if (typeof value === "number" && Number.isSafeInteger(value))
            return value;
        if (Array.isArray(value))
            return value.map(canonical);
        if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
        }
        throw new Error("Browser launch policy must contain only canonical public JSON values");
    };
    return JSON.stringify(canonical(policy));
}
