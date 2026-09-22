import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_QUOTE_CONTROL, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WRAPPED_SOL_MINT } from "./constants.js";
/**
 * Pump "Custom Pairs" (non-SOL quote assets), shipped 9 September 2026.
 *
 * `create_v2` keeps its discriminator and gains four APPENDED account metas.
 * `@pump-fun/pump-sdk@1.36.0` predates the upgrade: given a `quoteMint` it emits
 * only NINETEEN metas (no `quote_control`) and derives the quote ATA with the
 * SPL token program even when the quote mint is Token-2022 — wrong for all 66
 * Token-2022 quotes. So the four metas are pinned HERE, from the verified chain
 * shape, and the official SDK is still the only encoder of the instruction data.
 *
 * Verified against mainnet transaction
 * 3hpWSasa8F5aa7676tt2tsJubGbTyQqS1eamUQDqsqVbdUh8fuRcW2KSqhVMQnqKX5xBAympGAQG1ocumGax16eV
 * (coin MACROHARD `HvtsJkZx…pump`, quote SPYx `XsoCS1Tf…`, slot 445819539):
 *
 *   [16] quote_mint                      readonly
 *   [17] associated_quote_bonding_curve  WRITABLE  = ATA(bonding_curve, quote, quoteTokenProgram)
 *   [18] quote_token_program             readonly
 *   [19] quote_control                   readonly  = 6z6GDdfb… (constant)
 *
 * The optional trailing `u64` argument is deliberately OMITTED: its meaning is
 * unconfirmed, and the two-byte argument tail is proven on chain for custom
 * pairs (MSFTx, WBTC, SPCX launches). This module refuses any instruction whose
 * data carries it.
 */
export const PUMP_CREATE_V2_DISCRIMINATOR = Object.freeze([214, 144, 76, 236, 95, 139, 49, 180]);
/** SOL-quoted `create_v2`: the legacy shape, unchanged by the September upgrade. */
export const PUMP_CREATE_V2_SOL_ACCOUNTS = 16;
/** Custom-pair `create_v2`: the legacy sixteen plus the four appended quote metas. */
export const PUMP_CREATE_V2_CUSTOM_PAIR_ACCOUNTS = 20;
/** Curve geometry is identical across quotes: 1073/279.9 − 1. */
export const PUMP_GRADUATION_RESERVE_MULTIPLIER = 2.8335119685;
/** Protocol hard limit for one serialized transaction. */
export const SOLANA_MAX_TRANSACTION_BYTES = 1_232;
/**
 * Phantom's transaction guard appends Lighthouse assertions before it simulates
 * and cannot fit them into a packet at the ceiling
 * (release log, 8 September 2026). The Pump lane measured 1200 of
 * 1232 bytes with 32 bytes free; a custom-pair packet must not grow past it.
 */
/** The default packet ceiling for a BROWSER-SIGNED lane.
 *
 * `MAX_SOLANA_TRANSACTION_BYTES` (1232) is the protocol maximum, not what a
 * wallet will sign: Phantom appends Lighthouse assertions before it simulates
 * and cannot fit them into a packet at the ceiling. A plan compiling to
 * 1201-1232 bytes passed every SDK gate, `mode` was set to `atomic`, and
 * Phantom then refused to sign — a user-visible dead launch with no SDK error,
 * which is the packet-size regression already on record (COD-20).
 *
 * `PHANTOM_PUMP_LANE_MEASURED_BYTES` existed for exactly this and was
 * referenced only by a test. Server-signed packets may still pass the protocol
 * maximum explicitly through `maxSerializedBytes`. */
export const PHANTOM_PUMP_LANE_MEASURED_BYTES = 1_200;
function check(value, reason) {
    if (!value)
        throw new Error(`Pump custom pair: ${reason}`);
}
/** The canonical bonding curve for a launch mint, `["bonding-curve", mint]`. */
export function pumpBondingCurveAddress(mint) {
    return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}
/** ATA of a quote asset for an owner, derived with the quote's OWN token program. */
export function pumpQuoteAta(owner, quote) {
    return getAssociatedTokenAddressSync(quote.mint, owner, true, quote.tokenProgram);
}
/**
 * A non-SOL quote asset accepted by this release. SOL is not a custom pair: it
 * keeps the sixteen-account form, so passing WSOL or the default key here is a
 * caller mistake rather than a supported no-op.
 */
export function validatePumpCustomPairQuote(value) {
    check(value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === 2, "exact {mint, tokenProgram} required");
    const { mint, tokenProgram } = value;
    check(mint instanceof PublicKey && tokenProgram instanceof PublicKey, "quote mint and token program must be public keys");
    check(!mint.equals(PublicKey.default) && !mint.equals(WRAPPED_SOL_MINT), "SOL keeps the sixteen-account create_v2; it is not a custom pair");
    check(tokenProgram.equals(SPL_TOKEN_PROGRAM_ID) || tokenProgram.equals(TOKEN_2022_PROGRAM_ID), "quote token program must be Token or Token-2022");
    return Object.freeze({ mint, tokenProgram });
}
/** The four appended metas, in their pinned on-chain order. */
export function pumpCustomPairCreateAccounts(mint, quote) {
    const validated = validatePumpCustomPairQuote(quote);
    check(mint instanceof PublicKey && !mint.equals(PublicKey.default), "launch mint required");
    check(!mint.equals(validated.mint), "launch mint and quote mint must differ");
    return Object.freeze([
        { pubkey: validated.mint, isSigner: false, isWritable: false },
        { pubkey: pumpQuoteAta(pumpBondingCurveAddress(mint), validated), isSigner: false, isWritable: true },
        { pubkey: validated.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: PUMP_QUOTE_CONTROL, isSigner: false, isWritable: false },
    ]);
}
/**
 * Exact byte length of a `create_v2` argument buffer with the trailing `u64`
 * omitted: discriminator, three borsh strings, the creator pubkey, then the
 * `is_mayhem_mode` bool and the `is_cashback` Option tag.
 */
export function pumpCreateV2DataLength(input) {
    const utf8 = new TextEncoder();
    return 8 + [input.name, input.symbol, input.uri].reduce((sum, value) => sum + 4 + utf8.encode(value).byteLength, 0) + 32 + 2;
}
/**
 * Take the official SDK's SOL-quoted `create_v2` and append the four quote metas.
 * Everything the SDK produced is re-checked first: an SDK upgrade that changes
 * the account count, the discriminator or the argument tail fails here rather
 * than silently shipping a differently shaped instruction to a wallet.
 */
export function appendPumpCustomPairAccounts(instruction, input) {
    check(instruction instanceof TransactionInstruction, "official create_v2 instruction required");
    check(instruction.programId.equals(PUMP_PROGRAM_ID), "create_v2 must be the pinned Pump program");
    check(instruction.keys.length === PUMP_CREATE_V2_SOL_ACCOUNTS, `official create_v2 must supply exactly ${PUMP_CREATE_V2_SOL_ACCOUNTS} accounts`);
    const data = Buffer.from(instruction.data);
    check(data.subarray(0, 8).equals(Buffer.from(PUMP_CREATE_V2_DISCRIMINATOR)), "create_v2 discriminator differs from the pinned ABI");
    check(data.length === pumpCreateV2DataLength(input), "create_v2 arguments must omit the unconfirmed trailing u64");
    check(instruction.keys[0].pubkey.equals(input.mint) && instruction.keys[0].isSigner, "create_v2 account 0 must be the launch mint signer");
    check(instruction.keys[2].pubkey.equals(pumpBondingCurveAddress(input.mint)), "create_v2 account 2 must be the canonical bonding curve");
    check(instruction.keys[15].pubkey.equals(PUMP_PROGRAM_ID), "create_v2 account 15 must be the Pump program");
    const appended = pumpCustomPairCreateAccounts(input.mint, input.quote);
    const keys = [...instruction.keys, ...appended];
    check(keys.length === PUMP_CREATE_V2_CUSTOM_PAIR_ACCOUNTS, "custom-pair create_v2 must carry exactly twenty accounts");
    return new TransactionInstruction({ programId: instruction.programId, keys, data });
}
/**
 * Graduation raise for a quote, in raw quote units, from the catalogue's
 * `initial_virtual_quote_reserves`. Display maths only — never an admission.
 */
export function pumpGraduationRaise(initialVirtualQuoteReserves) {
    check(typeof initialVirtualQuoteReserves === "bigint" && initialVirtualQuoteReserves > 0n
        && initialVirtualQuoteReserves <= (1n << 64n) - 1n, "positive u64 virtual quote reserves required");
    return BigInt(Math.round(Number(initialVirtualQuoteReserves) * PUMP_GRADUATION_RESERVE_MULTIPLIER));
}
/** The pair's token accounts the fee-share update needs (11 Sep 2026, found by
 * mainnet simulation: `update_fee_shares_v2` first distributes accrued fees,
 * which reads the creator's, the pump creator vault's and the coin creator
 * vault's token accounts for the QUOTE as token accounts, and none exists for
 * a fresh coin; pump.fun's own flow creates the vaults' on the first trade,
 * after its fee shares are set). The launch creates the three idempotently, at
 * the creator's rent (about 0.002 SOL each, returned if ever closed). Verified
 * for WBTC (SPL), SPYx and a Backpack security (Token-2022 with extensions):
 * the packet simulates clean with them and fails with InvalidAccountData without. */
export function pumpCustomPairFeeShareAccountInstructions(creator, mint, quote) {
    const sharing = PublicKey.findProgramAddressSync([Buffer.from("sharing-config"), mint.toBuffer()], PUMP_FEES_PROGRAM_ID)[0];
    const pumpCreatorVault = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), sharing.toBuffer()], PUMP_PROGRAM_ID)[0];
    const coinCreatorVaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), sharing.toBuffer()], PUMP_AMM_PROGRAM_ID)[0];
    return [creator, pumpCreatorVault, coinCreatorVaultAuthority].map(owner => createAssociatedTokenAccountIdempotentInstruction(creator, getAssociatedTokenAddressSync(quote.mint, owner, true, quote.tokenProgram), owner, quote.mint, quote.tokenProgram));
}
