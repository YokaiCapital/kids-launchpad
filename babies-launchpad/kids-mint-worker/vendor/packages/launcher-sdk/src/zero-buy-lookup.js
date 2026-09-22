import { deriveDirectInitialBuyMintLookupAccounts } from "./direct-initial-buy.js";
/** Structural compiler guard, not a finalized chain proof or release approval.
 * Runtime and browser independently enforce static policy and finalized state. */
export function assertZeroBuyLookupTables(mode, tables, identity) {
    if (mode !== "static-plus-frozen-mint-v1" || tables.length !== 2 || tables[0].key.equals(tables[1].key))
        throw new Error("Zero-buy lookup requires distinct static and frozen mint tables");
    const expected = Object.values(deriveDirectInitialBuyMintLookupAccounts(identity));
    const table = tables[1];
    if (table.state.authority !== undefined || table.state.deactivationSlot !== (1n << 64n) - 1n
        || table.state.addresses.length !== expected.length
        || table.state.addresses.some((key, index) => key.toBase58() !== expected[index]))
        throw new Error("Zero-buy lookup requires exact frozen canonical mint coverage");
}
