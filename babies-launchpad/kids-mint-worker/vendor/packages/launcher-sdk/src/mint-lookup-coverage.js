import { createHash } from "node:crypto";
import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey } from "@solana/web3.js";
import { deriveDirectInitialBuyMintLookupAccounts } from "./direct-initial-buy.js";
import { deriveFrozenMintLookupTableSnapshot } from "./browser-launch-policy.js";
const verified = new WeakSet();
const check = (condition, reason) => { if (!condition)
    throw new Error(`Mint lookup coverage: ${reason}`); };
function exact(input, names) {
    check(input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype, "plain object required");
    const keys = Reflect.ownKeys(input);
    check(keys.length === names.length && keys.every(k => typeof k === "string" && names.includes(k)), "unexpected or missing fields");
    for (const name of names) {
        const d = Object.getOwnPropertyDescriptor(input, name);
        check(d && Object.hasOwn(d, "value") && d.enumerable, "accessors prohibited");
    }
}
function dense(input, max) {
    check(Array.isArray(input) && Object.getPrototypeOf(input) === Array.prototype && input.length > 0 && input.length <= max, "bounded nonempty array required");
    check(Reflect.ownKeys(input).length === input.length + 1, "dense array required");
    for (let i = 0; i < input.length; i++) {
        const d = Object.getOwnPropertyDescriptor(input, String(i));
        check(d && Object.hasOwn(d, "value") && d.enumerable, "array accessors prohibited");
    }
}
function key(input) {
    check(typeof input === "string", "canonical address required");
    const result = new PublicKey(input);
    check(result.toBase58() === input, "canonical address required");
    return result;
}
function snapshot(input) {
    exact(input, ["address", "authority", "expectedAddresses"]);
    key(input.address);
    if (input.authority !== null)
        key(input.authority);
    dense(input.expectedAddresses, 256);
    const addresses = input.expectedAddresses.map(address => key(address).toBase58());
    check(new Set(addresses).size === addresses.length, "duplicate lookup entries");
    return Object.freeze({ address: input.address, authority: input.authority, expectedAddresses: Object.freeze(addresses) });
}
export function freezeMintLookupPolicy(input) {
    exact(input, ["schemaVersion", "genesisHash", "operator", "routerProgramId", "tables"]);
    check(input.schemaVersion === 1, "unsupported schema");
    key(input.genesisHash);
    key(input.routerProgramId);
    check(PublicKey.isOnCurve(key(input.operator).toBytes()) && input.operator !== input.routerProgramId, "independent on-curve operator required");
    dense(input.tables, 32);
    const tables = input.tables.map(snapshot);
    check(new Set(tables.map(t => t.address)).size === tables.length, "duplicate table");
    return Object.freeze({ schemaVersion: 1, genesisHash: input.genesisHash, operator: input.operator,
        routerProgramId: input.routerProgramId, tables: Object.freeze(tables) });
}
export function mintLookupPolicySha256(input) {
    return createHash("sha256").update(JSON.stringify(freezeMintLookupPolicy(input))).digest("hex");
}
export function freezeMintLookupCoverage(input) {
    check(input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype, "plain object required");
    const schema = Object.getOwnPropertyDescriptor(input, "schemaVersion")?.value;
    exact(input, ["schemaVersion", "policySha256", "mint", "operator", "routerProgramId", "genesisHash", "finalizedSlot", "table",
        ...(schema === 2 ? ["lookupMode", "staticTable"] : [])]);
    check((input.schemaVersion === 1 || input.schemaVersion === 2) && /^[a-f0-9]{64}$/.test(input.policySha256), "invalid coverage policy");
    check(Number.isSafeInteger(input.finalizedSlot) && input.finalizedSlot > 0, "finalized slot required");
    key(input.genesisHash);
    if (input.schemaVersion === 2) {
        check(input.lookupMode === "static-plus-frozen-mint-v1", "explicit frozen mint lookup mode required");
        const table = snapshot(input.table), staticTable = snapshot(input.staticTable);
        const expected = deriveFrozenMintLookupTableSnapshot({ mint: input.mint, operator: input.operator,
            routerProgramId: input.routerProgramId, tableAddress: table.address });
        check(table.authority === null && table.address !== staticTable.address
            && table.expectedAddresses.length === expected.expectedAddresses.length
            && table.expectedAddresses.every((address, index) => address === expected.expectedAddresses[index]), "frozen table differs from exact ordered canonical mint accounts");
        return Object.freeze({ schemaVersion: 2, lookupMode: input.lookupMode, policySha256: input.policySha256,
            mint: input.mint, operator: input.operator, routerProgramId: input.routerProgramId, genesisHash: input.genesisHash,
            finalizedSlot: input.finalizedSlot, table, staticTable });
    }
    check(input.mint.endsWith("pair") && PublicKey.isOnCurve(key(input.mint).toBytes()), "on-curve pair mint required");
    const expected = Object.values(deriveDirectInitialBuyMintLookupAccounts({ mint: input.mint, operator: input.operator, routerProgramId: input.routerProgramId }));
    const table = snapshot(input.table);
    check(expected.every(address => table.expectedAddresses.includes(address)), "table lacks canonical mint accounts");
    return Object.freeze({ schemaVersion: 1, policySha256: input.policySha256, mint: input.mint, operator: input.operator,
        routerProgramId: input.routerProgramId, genesisHash: input.genesisHash, finalizedSlot: input.finalizedSlot, table });
}
/** Exact compilation order. This does not replace runtime chain verification. */
export function mintLookupCoverageTables(input) {
    const coverage = freezeMintLookupCoverage(input);
    return Object.freeze(coverage.schemaVersion === 2 ? [coverage.staticTable, coverage.table] : [coverage.table]);
}
export function assertVerifiedMintLookupCoverage(input) {
    check(verified.has(input), "finalized proof from the trusted reader is required");
}
/** Read-only, exact policy + genesis + owner + authority + full indexed contents.
 * The returned process-local proof is accepted by the inventory installer, not
 * JSON from a browser. Runtime must still re-read its configured tables before
 * signing; installation does not promise that a mutable ALT stays active. */
export async function verifyMintLookupCoverage(connection, input) {
    const policy = freezeMintLookupPolicy(input.policy), policySha256 = mintLookupPolicySha256(policy);
    check(Number.isSafeInteger(input.minimumFinalizedSlot) && input.minimumFinalizedSlot > 0, "explicit finalized floor required");
    const selected = policy.tables.find(table => table.address === input.tableAddress);
    check(selected, "table not approved by the lookup policy");
    const candidate = freezeMintLookupCoverage({ schemaVersion: 1, policySha256, mint: input.mint, operator: policy.operator,
        routerProgramId: policy.routerProgramId, genesisHash: policy.genesisHash, finalizedSlot: input.minimumFinalizedSlot, table: selected });
    const [genesis, response] = await Promise.all([
        connection.getGenesisHash(),
        connection.getMultipleAccountsInfoAndContext([key(selected.address)], { commitment: "finalized", minContextSlot: input.minimumFinalizedSlot }),
    ]);
    check(genesis === policy.genesisHash, "wrong cluster");
    check(Number.isSafeInteger(response.context.slot) && response.context.slot >= input.minimumFinalizedSlot && response.value.length === 1, "stale or incomplete finalized response");
    const account = response.value[0];
    check(account && !account.executable && account.owner.equals(AddressLookupTableProgram.programId)
        && account.data.length >= 56 && account.data.length <= 56 + 32 * 256 && (account.data.length - 56) % 32 === 0, "wrong lookup account");
    const state = AddressLookupTableAccount.deserialize(account.data);
    check(state.deactivationSlot === (1n << 64n) - 1n && Number.isSafeInteger(state.lastExtendedSlot)
        && state.lastExtendedSlot < response.context.slot && state.lastExtendedSlotStartIndex <= state.addresses.length, "lookup table is inactive or not fully warmed");
    check((state.authority?.toBase58() ?? null) === selected.authority, "wrong lookup authority");
    check(state.addresses.length === selected.expectedAddresses.length
        && state.addresses.every((address, i) => address.toBase58() === selected.expectedAddresses[i]), "lookup indexes differ from approved snapshot");
    const result = freezeMintLookupCoverage({ ...candidate, finalizedSlot: response.context.slot });
    verified.add(result);
    return result;
}
/** Explicit opt-in for an additional frozen mint-only table. Both complete
 * snapshots are checked in one finalized bank; neither caller contents nor a
 * mutable/partial ALT can acquire the existing inventory proof brand. */
export async function verifyFrozenMintLookupCoverage(connection, input) {
    check(input.lookupMode === "static-plus-frozen-mint-v1", "explicit frozen mint lookup mode required");
    const policy = freezeMintLookupPolicy(input.policy), policySha256 = mintLookupPolicySha256(policy), minimum = input.minimumFinalizedSlot;
    check(Number.isSafeInteger(minimum) && minimum > 0, "explicit finalized floor required");
    const staticTable = policy.tables.find(table => table.address === input.staticTableAddress);
    check(staticTable, "static table not approved by the lookup policy");
    check(!policy.tables.some(table => table.address === input.tableAddress), "additional mint table must differ from the static policy tables");
    const table = deriveFrozenMintLookupTableSnapshot({ mint: input.mint, operator: policy.operator,
        routerProgramId: policy.routerProgramId, tableAddress: input.tableAddress });
    const candidate = freezeMintLookupCoverage({ schemaVersion: 2, lookupMode: input.lookupMode,
        policySha256, mint: input.mint, operator: policy.operator, routerProgramId: policy.routerProgramId,
        genesisHash: policy.genesisHash, finalizedSlot: minimum, staticTable: staticTable, table });
    const snapshots = mintLookupCoverageTables(candidate);
    const [genesis, response] = await Promise.all([
        connection.getGenesisHash(),
        connection.getMultipleAccountsInfoAndContext(snapshots.map(table => key(table.address)), { commitment: "finalized", minContextSlot: minimum }),
    ]);
    check(genesis === policy.genesisHash, "wrong cluster");
    check(Number.isSafeInteger(response.context.slot) && response.context.slot >= minimum && response.value.length === snapshots.length, "stale or incomplete finalized response");
    for (let index = 0; index < snapshots.length; index++) {
        const expected = snapshots[index], account = response.value[index];
        check(account && !account.executable && account.owner.equals(AddressLookupTableProgram.programId)
            && account.data.length >= 56 && account.data.length <= 56 + 32 * 256 && (account.data.length - 56) % 32 === 0, "wrong lookup account");
        const state = AddressLookupTableAccount.deserialize(account.data);
        check(state.deactivationSlot === (1n << 64n) - 1n && Number.isSafeInteger(state.lastExtendedSlot)
            && state.lastExtendedSlot < response.context.slot && state.lastExtendedSlotStartIndex <= state.addresses.length, "lookup table is inactive or not fully warmed");
        check((state.authority?.toBase58() ?? null) === expected.authority, "wrong lookup authority");
        check(state.addresses.length === expected.expectedAddresses.length
            && state.addresses.every((address, i) => address.toBase58() === expected.expectedAddresses[i]), "lookup indexes differ from approved snapshot");
    }
    const result = freezeMintLookupCoverage({ ...candidate, finalizedSlot: response.context.slot });
    verified.add(result);
    return result;
}
