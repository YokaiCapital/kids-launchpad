import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveDirectBatchRegistrationV2 } from "../../router-client/src/direct-batch-v2.js";
import { PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID, PUMP_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WRAPPED_SOL_MINT, pumpFeeSharingAddress } from "./constants.js";
/** Opt-in construction foundation ONLY. No RPC, keys, signing, sending, table
 * creation, intent-schema migration or existing zero-buy execution is enabled.
 * Caller must independently attest snapshot bytes/finality and current policies.
 * ABI: official @pump-fun/pump-sdk 1.36.0, buy_exact_sol_in (not quote-v2).
 * Tests compare the complete account metas and data to its official IDL coder. */
const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n, BPS = 10000n;
const MAYHEM = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const EXACT_SOL_DISCRIMINATOR = [56, 252, 116, 8, 158, 223, 205, 95];
function check(value, reason) { if (!value)
    throw new Error(`Direct initial buy: ${reason}`); }
function exact(value, fields) {
    check(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "plain exact object required");
    const keys = Reflect.ownKeys(value);
    check(keys.length === fields.length && keys.every(k => typeof k === "string" && fields.includes(k)), "unexpected or missing fields");
    for (const name of fields) {
        const d = Object.getOwnPropertyDescriptor(value, name);
        check(d && Object.hasOwn(d, "value") && d.enumerable, "accessors and hidden fields prohibited");
    }
}
function uint(value, maximum = U64, minimum = 0n) {
    check(typeof value === "bigint" && value >= minimum && value <= maximum, "bounded bigint required");
}
function integer(value, maximum, minimum = 0) {
    check(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum, "bounded integer required");
}
function address(value, onCurve = false) {
    check(typeof value === "string" && value.length >= 32 && value.length <= 44, "canonical address required");
    const result = new PublicKey(value);
    check(result.toBase58() === value && !result.equals(PublicKey.default) && (!onCurve || PublicKey.isOnCurve(result.toBytes())), "canonical nondefault identity required");
    return result;
}
function dense(value, maximum) {
    check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length > 0 && value.length <= maximum
        && Reflect.ownKeys(value).length === value.length + 1, "dense bounded array required");
    for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        check(d && Object.hasOwn(d, "value") && d.enumerable, "array accessors prohibited");
    }
}
function hash(value) { check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "exact account SHA256 required"); }
const pda = (program, seed, ...keys) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map(k => k.toBuffer())], program)[0];
const ata = (mint, owner, tokenProgram = SPL_TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
/** Exact decimal parsing; optional trailing fractional zeroes are harmless.
 * Use formatDirectInitialBuySol for the unique canonical display/intent string. */
export function parseDirectInitialBuySol(value) {
    check(typeof value === "string" && value.length <= 21 && /^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,9})?$/.test(value), "SOL needs a plain decimal with at most nine decimals");
    const [whole, fraction = ""] = value.split(".");
    const lamports = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
    uint(lamports);
    return lamports;
}
export function formatDirectInitialBuySol(lamports) {
    uint(lamports);
    const whole = lamports / 1000000000n, fraction = (lamports % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
}
/** Validated frozen VALUE snapshot, not a chain-proof brand. No fallback to
 * stale/global flat fees or an absent fee schedule is permitted. */
export function freezeDirectInitialBuySnapshot(input) {
    exact(input, ["mode", "genesisHash", "slot", "globalSha256", "feeConfigSha256", "initialVirtualTokenReserves", "initialVirtualSolReserves",
        "initialRealTokenReserves", "tokenTotalSupply", "feeTiers", "feeRecipients", "buybackFeeRecipients"]);
    check(input.mode === "new-native-sol-curve-v1", "only a fresh native-SOL curve is supported");
    address(input.genesisHash);
    integer(input.slot, Number.MAX_SAFE_INTEGER, 1);
    hash(input.globalSha256);
    hash(input.feeConfigSha256);
    for (const value of [input.initialVirtualTokenReserves, input.initialVirtualSolReserves, input.initialRealTokenReserves, input.tokenTotalSupply])
        uint(value, U64, 1n);
    check(input.initialRealTokenReserves <= input.tokenTotalSupply && input.tokenTotalSupply < input.initialVirtualTokenReserves, "invalid new-curve inventory/reserves");
    dense(input.feeTiers, 128);
    let previous = -1n;
    const feeTiers = input.feeTiers.map(value => {
        exact(value, ["marketCapLamportsThreshold", "protocolFeeBps", "creatorFeeBps"]);
        uint(value.marketCapLamportsThreshold, U128);
        uint(value.protocolFeeBps, BPS);
        uint(value.creatorFeeBps, BPS);
        check(value.marketCapLamportsThreshold > previous && value.protocolFeeBps + value.creatorFeeBps <= BPS, "fee tiers must be strictly ordered with bounded total fees");
        previous = value.marketCapLamportsThreshold;
        return Object.freeze({ ...value });
    });
    function recipients(value) {
        dense(value, 8);
        const copied = value.map(item => { address(item); return item; });
        check(new Set(copied).size === copied.length, "fee recipient list must be unique");
        return Object.freeze(copied);
    }
    return Object.freeze({ ...input, feeTiers: Object.freeze(feeTiers), feeRecipients: recipients(input.feeRecipients), buybackFeeRecipients: recipients(input.buybackFeeRecipients) });
}
function approval(input, snapshot) {
    exact(input, ["mint", "creator", "spendableSolIn", "maximumSpendableSolIn", "slippageBps", "maximumSlippageBps", "feeRecipient", "buybackFeeRecipient"]);
    const mint = address(input.mint, true), creator = address(input.creator, true);
    uint(input.spendableSolIn, U64, 1n);
    uint(input.maximumSpendableSolIn, U64, 1n);
    integer(input.slippageBps, 9999);
    integer(input.maximumSlippageBps, 9999);
    check(input.spendableSolIn <= input.maximumSpendableSolIn && input.slippageBps <= input.maximumSlippageBps, "creator spend or slippage exceeds explicit ceiling");
    address(input.feeRecipient);
    address(input.buybackFeeRecipient);
    check(snapshot.feeRecipients.includes(input.feeRecipient) && snapshot.buybackFeeRecipients.includes(input.buybackFeeRecipient), "fee recipients differ from finalized snapshot");
    const ids = [input.mint, input.creator, input.feeRecipient, input.buybackFeeRecipient];
    check(new Set(ids).size === ids.length && !mint.equals(PUMP_PROGRAM_ID) && !creator.equals(PUMP_PROGRAM_ID), "distinct mint, buyer and fee identities required");
    return Object.freeze({ ...input });
}
const snapshotAmounts = ["initialVirtualTokenReserves", "initialVirtualSolReserves", "initialRealTokenReserves", "tokenTotalSupply"];
const approvalAmounts = ["spendableSolIn", "maximumSpendableSolIn"];
const quoteAmounts = ["spendableSolIn", "minTokensOut", "expectedTokensOut", "protocolFeeBps", "creatorFeeBps"];
function decimal(v) { check(typeof v === "string" && /^(0|[1-9][0-9]{0,38})$/.test(v), "canonical bigint decimal required"); return BigInt(v); }
function convert(v, names) {
    check(v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype, "plain amount object required");
    for (const k of Reflect.ownKeys(v)) {
        const d = Object.getOwnPropertyDescriptor(v, k);
        check(typeof k === "string" && Object.hasOwn(d, "value") && d.enumerable, "exact data fields required");
    }
    const copy = { ...v };
    for (const name of names)
        copy[name] = decimal(copy[name]);
    return copy;
}
export function serializeDirectInitialBuySnapshot(value) {
    return JSON.parse(JSON.stringify(freezeDirectInitialBuySnapshot(value), (_key, v) => typeof v === "bigint" ? v.toString() : v));
}
export function parseDirectInitialBuySnapshot(value) {
    const s = convert(value, snapshotAmounts);
    dense(s.feeTiers, 128);
    s.feeTiers = s.feeTiers.map(tier => convert(tier, ["marketCapLamportsThreshold", "protocolFeeBps", "creatorFeeBps"]));
    return freezeDirectInitialBuySnapshot(s);
}
/** Release-pinned pricing inputs, not a self-reported server price. Only the
 * read-only observed bank may advance; every raw hash, reserve and fee stays. */
export function assertDirectInitialBuySnapshotMatchesPolicy(candidate, pinned) {
    const c = serializeDirectInitialBuySnapshot(candidate), p = serializeDirectInitialBuySnapshot(parseDirectInitialBuySnapshot(pinned));
    const canonical = (v) => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
    check(c.slot >= p.slot && canonical({ ...c, slot: p.slot }) === canonical(p), "current quote snapshot differs from release-pinned pricing inputs");
}
/** Canonical JSON-only durable intent boundary. All bigint fields are exact
 * decimal strings, never JSON numbers or caller-selected instruction bytes. */
export function serializeDirectInitialBuyEnvelope(input) {
    exact(input, ["snapshot", "approval", "quote", "maximumCreatorDebitLamports", "maximumNetworkFeeLamports"]);
    assertDirectInitialBuyQuote(input.quote, input.snapshot, input.approval);
    uint(input.maximumCreatorDebitLamports, BigInt(Number.MAX_SAFE_INTEGER), 1n);
    uint(input.maximumNetworkFeeLamports, BigInt(Number.MAX_SAFE_INTEGER), 1n);
    check(input.maximumCreatorDebitLamports > input.approval.spendableSolIn && input.maximumNetworkFeeLamports < input.maximumCreatorDebitLamports, "explicit total-debit/network-fee ceilings required");
    return JSON.parse(JSON.stringify(input, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}
export function parseDirectInitialBuyEnvelope(value) {
    exact(value, ["snapshot", "approval", "quote", "maximumCreatorDebitLamports", "maximumNetworkFeeLamports"]);
    const result = { snapshot: parseDirectInitialBuySnapshot(value.snapshot),
        approval: Object.freeze(convert(value.approval, approvalAmounts)),
        quote: Object.freeze(convert(value.quote, quoteAmounts)),
        maximumCreatorDebitLamports: decimal(value.maximumCreatorDebitLamports), maximumNetworkFeeLamports: decimal(value.maximumNetworkFeeLamports) };
    serializeDirectInitialBuyEnvelope(result);
    return Object.freeze(result);
}
/** Official exact-SOL IDL rounding, intentionally NOT the SDK's generic buy
 * estimator. Rent and network fees are additional; no permission to pay them is
 * implied. Reaching real inventory/graduation is deliberately unsupported. */
export function quoteDirectInitialBuy(input, requested) {
    const s = freezeDirectInitialBuySnapshot(input), a = approval(requested, s);
    const marketCap = s.tokenTotalSupply * s.initialVirtualSolReserves / s.initialVirtualTokenReserves;
    let tier = s.feeTiers[0];
    for (const next of s.feeTiers) {
        if (next.marketCapLamportsThreshold > marketCap)
            break;
        tier = next;
    }
    const { protocolFeeBps: p, creatorFeeBps: c } = tier;
    let net = a.spendableSolIn * BPS / (BPS + p + c);
    const fee = (bps) => (net * bps + BPS - 1n) / BPS;
    const excess = net + fee(p) + fee(c) - a.spendableSolIn;
    if (excess > 0n)
        net -= excess;
    check(net > 1n, "input cannot produce nonzero tokens");
    check(s.initialVirtualSolReserves + net <= U64, "resulting virtual SOL reserve overflows u64");
    const out = (net - 1n) * s.initialVirtualTokenReserves / (s.initialVirtualSolReserves + net - 1n);
    uint(out, U64, 1n);
    check(out < s.initialRealTokenReserves, "initial buy reaches unsupported real-inventory/graduation boundary");
    const minimum = out * (BPS - BigInt(a.slippageBps)) / BPS;
    uint(minimum, U64, 1n);
    const mint = address(a.mint), sharing = pumpFeeSharingAddress(mint);
    return Object.freeze({ schemaVersion: 1, mode: "pump-exact-sol-after-sharing-v1", pumpSdkVersion: "1.36.0", mint: a.mint, creator: a.creator,
        spendableSolIn: a.spendableSolIn, slippageBps: a.slippageBps, minTokensOut: minimum, expectedTokensOut: out, protocolFeeBps: p, creatorFeeBps: c,
        genesisHash: s.genesisHash, quotedAtSlot: s.slot, globalSha256: s.globalSha256, feeConfigSha256: s.feeConfigSha256,
        feeRecipient: a.feeRecipient, buybackFeeRecipient: a.buybackFeeRecipient, buyerAta: ata(mint, address(a.creator), TOKEN_2022_PROGRAM_ID).toBase58(),
        curveCreator: sharing.toBase58(), creatorFeeVault: pda(PUMP_PROGRAM_ID, "creator-vault", sharing).toBase58() });
}
/** Comparison is against independently supplied approval+snapshot, never the
 * caller's claimed minimum, buyer, vault, fee owner or self-reported bounds. */
export function assertDirectInitialBuyQuote(quote, snapshot, expected) {
    const canonical = quoteDirectInitialBuy(snapshot, expected), fields = Object.keys(canonical);
    exact(quote, fields);
    for (const name of fields)
        check(quote[name] === canonical[name], "quote differs from immutable creator approval/snapshot");
}
export function buildDirectInitialBuyInstructions(input) {
    exact(input, ["quote", "snapshot", "approval"]);
    assertDirectInitialBuyQuote(input.quote, input.snapshot, input.approval);
    const q = input.quote, mint = address(q.mint), creator = address(q.creator), curve = pda(PUMP_PROGRAM_ID, "bonding-curve", mint);
    // Official 1.36 IDL: discriminator + u64 spendable_sol_in + u64 min_tokens_out
    // + OptionBool tuple(bool). This version fixes track_volume=true.
    const data = Buffer.alloc(25);
    Buffer.from(EXACT_SOL_DISCRIMINATOR).copy(data);
    data.writeBigUInt64LE(q.spendableSolIn, 8);
    data.writeBigUInt64LE(q.minTokensOut, 16);
    data[24] = 1;
    const account = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
    const buy = new TransactionInstruction({ programId: PUMP_PROGRAM_ID, data, keys: [
            account(pda(PUMP_PROGRAM_ID, "global")), account(address(q.feeRecipient), true), account(mint), account(curve, true),
            account(ata(mint, curve, TOKEN_2022_PROGRAM_ID), true), account(address(q.buyerAta), true), account(creator, true, true),
            account(SystemProgram.programId), account(TOKEN_2022_PROGRAM_ID), account(address(q.creatorFeeVault), true),
            account(pda(PUMP_PROGRAM_ID, "__event_authority")), account(PUMP_PROGRAM_ID), account(pda(PUMP_PROGRAM_ID, "global_volume_accumulator")),
            account(pda(PUMP_PROGRAM_ID, "user_volume_accumulator", creator), true), account(pda(PUMP_FEES_PROGRAM_ID, "fee_config", PUMP_PROGRAM_ID)),
            account(PUMP_FEES_PROGRAM_ID), account(pda(PUMP_PROGRAM_ID, "bonding-curve-v2", mint)), account(address(q.buybackFeeRecipient), true),
        ] });
    return Object.freeze([createAssociatedTokenAccountIdempotentInstruction(creator, address(q.buyerAta), creator, mint, TOKEN_2022_PROGRAM_ID), buy]);
}
/** No arbitrary instructions are admitted. Useful for browser/server checks of
 * the two NEW suffix instructions before integrating a versioned full plan. */
export function assertDirectInitialBuyInstructions(instructions, input) {
    dense(instructions, 2);
    check(instructions.length === 2, "exact ATA and buy suffix required");
    const expected = buildDirectInitialBuyInstructions(input);
    instructions.forEach((ix, index) => {
        const correct = expected[index];
        check(ix instanceof TransactionInstruction && ix.programId.equals(correct.programId) && ix.data.equals(correct.data)
            && ix.keys.length === correct.keys.length && ix.keys.every((meta, i) => meta.pubkey.equals(correct.keys[i].pubkey)
            && meta.isSigner === correct.keys[i].isSigner && meta.isWritable === correct.keys[i].isWritable), "instruction differs from canonical creator ATA/exact-SOL buy");
    });
}
/** Exact canonical subset from the pinned official create/sharing/finalize/buy
 * account layouts, independently compared to the real trusted factory in tests.
 * No caller instruction array, buyer address or public metadata is an input.
 * These are lookup CONTENTS, not proof of any existing/finalized ALT account. */
export function deriveDirectInitialBuyMintLookupAccounts(input) {
    exact(input, ["mint", "operator", "routerProgramId"]);
    const mint = address(input.mint, true), operator = address(input.operator, true), router = address(input.routerProgramId);
    check(new Set([input.mint, input.operator, input.routerProgramId]).size === 3, "distinct mint/operator/router required");
    const curve = pda(PUMP_PROGRAM_ID, "bonding-curve", mint), sharing = pumpFeeSharingAddress(mint);
    const pumpVault = pda(PUMP_PROGRAM_ID, "creator-vault", sharing), ammVault = pda(PUMP_AMM_PROGRAM_ID, "creator_vault", sharing);
    return Object.freeze({ bondingCurve: curve.toBase58(), associatedBondingCurve: ata(mint, curve, TOKEN_2022_PROGRAM_ID).toBase58(),
        mayhemState: pda(MAYHEM, "mayhem-state", mint).toBase58(), mayhemTokenVault: ata(mint, pda(MAYHEM, "sol-vault"), TOKEN_2022_PROGRAM_ID).toBase58(),
        directRegistration: deriveDirectBatchRegistrationV2(mint, operator, router)[0].toBase58(), sharingConfig: sharing.toBase58(),
        pumpCreatorVault: pumpVault.toBase58(), pumpCreatorVaultAta: ata(WRAPPED_SOL_MINT, pumpVault).toBase58(),
        coinCreatorVaultAuthority: ammVault.toBase58(), coinCreatorVaultAta: ata(WRAPPED_SOL_MINT, ammVault).toBase58(),
        bondingCurveV2: pda(PUMP_PROGRAM_ID, "bonding-curve-v2", mint).toBase58() });
}
