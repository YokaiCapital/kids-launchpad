import { PublicKey, SystemProgram } from "@solana/web3.js";
import { deriveLaunchIntentName } from "../../coin-identity/index.js";
import { DIRECT_BATCH_V2, buildRegisterDirectBatchV2Instruction, createDirectBatchV2InstructionFactory } from "../../router-client/src/direct-batch-v2.js";
import { PUMP_FEE_COLLECTOR_BPS, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WRAPPED_SOL_MINT, pumpFeeSharingAddress } from "./constants.js";
import { normalizeLaunchRequest } from "./intent.js";
import { LaunchIntentConflictError, LaunchValidationError, TransactionTooLargeError } from "./errors.js";
import { buildDirectInitialBuyInstructions, parseDirectInitialBuyEnvelope, serializeDirectInitialBuyEnvelope } from "./direct-initial-buy.js";
import { assertZeroBuyLookupTables } from "./zero-buy-lookup.js";
import { appendPumpCustomPairAccounts, validatePumpCustomPairQuote, pumpCustomPairFeeShareAccountInstructions } from "./pump-custom-pairs.js";
import { canonicalIntentJson } from "./canonical-json.js";
import { PHANTOM_PUMP_LANE_MEASURED_BYTES } from "./pump-custom-pairs.js";
function sameInstruction(a, b) {
    return a.programId.equals(b.programId) && a.data.equals(b.data) && a.keys.length === b.keys.length
        && a.keys.every((key, i) => key.pubkey.equals(b.keys[i].pubkey) && key.isSigner === b.keys[i].isSigner && key.isWritable === b.keys[i].isWritable);
}
function registrationInput(intent, deployment) {
    return { programId: deployment.programId, operator: deployment.operator, launchMint: intent.mint, launchTokenProgram: TOKEN_2022_PROGRAM_ID,
        rewardMint: deployment.rewardMint, rewardTokenProgram: deployment.rewardTokenProgram, feeCollector: intent.feeCollector,
        protocolRecipient: deployment.protocolRecipient, pauseAuthority: deployment.pauseAuthority };
}
export async function buildDirectBatchLaunchPlan(request, pump, codec, options) {
    if (!options || options.registration?.mode !== "direct-batch-v2"
        || !["deployed", "not-deployed"].includes(options.registration.deploymentStatus))
        throw new LaunchValidationError("Explicit trusted direct-batch-v2 deployment required");
    for (const field of ["executionMode", "registration", "policyVersion", "allocationBasis", "payoutIntervalSeconds", "mode", "registrationRentReimbursement", "developerBuy", "zeroBuyLookupMode"]) {
        if (Object.prototype.hasOwnProperty.call(request, field))
            throw new LaunchValidationError(`${field} is trusted configuration, not a launch request field`);
    }
    const customPair = options.pumpCustomPair ? validatePumpCustomPairQuote(options.pumpCustomPair) : undefined;
    const buy = options.developerBuy ? parseDirectInitialBuyEnvelope(serializeDirectInitialBuyEnvelope(options.developerBuy)) : undefined;
    if (customPair && buy)
        throw new LaunchValidationError("A creator buy is not available on a custom pair yet: the launch packet would pass the 1200-byte limit Phantom leaves for its checks. Launch with no creator buy, then buy from the coin page.");
    // A custom pair uses the same static-plus-frozen-mint tables as a SOL launch:
    // the frozen per-mint table holds mint-derived accounts only (curve, sharing
    // config, registration, vaults), none of them quote-specific, and with it a
    // paired packet measures 1,102 bytes against 1,316 with the lane table alone
    // (11 Sep 2026, live tables). The quote's own accounts stay static keys.
    if (buy && (request.initialBuyLamports !== buy.approval.spendableSolIn || buy.approval.mint !== request.mint.toBase58()
        || buy.approval.creator !== request.creator.toBase58() || !request.payer.equals(request.creator)
        || request.mayhemMode === true || request.cashback === true || !options.registrationRentReimbursement))
        throw new LaunchValidationError("Atomic initial buy requires exact creator approval, SOL mode and registration reimbursement");
    const normalized = normalizeLaunchRequest({ ...request, ...(buy ? { initialBuyLamports: 0n } : {}), name: deriveLaunchIntentName(request.symbol, options.rewardSymbol, request.name), symbol: request.symbol.trim() }, options.feeCollector);
    const intent = buy ? { ...normalized, initialBuyLamports: buy.approval.spendableSolIn } : normalized;
    const quoted = options.registrationRentReimbursement && { ...options.registrationRentReimbursement };
    if (quoted && (typeof quoted.lamports !== "bigint" || quoted.lamports <= 0n || quoted.lamports > 18446744073709551615n
        || !Number.isSafeInteger(quoted.quotedAtSlot) || quoted.quotedAtSlot < 0))
        throw new LaunchValidationError("Exact positive finalized registration rent quote required");
    const input = registrationInput(intent, options.registration), canonical = buildRegisterDirectBatchV2Instruction(input);
    const factory = options.registrationFactory ?? createDirectBatchV2InstructionFactory(input.programId);
    // A browser-signed Direct packet must leave room for the wallet guard's own
    // assertions; 1232 is the protocol maximum, not a signable ceiling (COD-20).
    const maxBytes = options.maxSerializedBytes ?? PHANTOM_PUMP_LANE_MEASURED_BYTES, lookupTables = [...(options.lookupTables ?? [])];
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1232)
        throw new RangeError("maxSerializedBytes must be a positive integer no larger than 1232");
    const zeroBuyLookupMode = options.zeroBuyLookupMode;
    if (zeroBuyLookupMode !== undefined) {
        if (buy || !quoted || intent.initialBuyLamports !== 0n)
            throw new LaunchValidationError("Zero-buy lookup requires reimbursed zero-buy intent");
        assertZeroBuyLookupTables(zeroBuyLookupMode, lookupTables, { mint: intent.mint.toBase58(), operator: input.operator.toBase58(), routerProgramId: input.programId.toBase58() });
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1232)
        throw new LaunchValidationError("Direct packet cap must be 1..1232 bytes");
    const [register, create, sharing, finalize] = await Promise.all([
        factory.registerDirectBatchV2(input),
        pump.createV2Instruction({ mint: intent.mint, name: intent.name, symbol: intent.symbol, uri: intent.metadataUri, creator: intent.creator,
            user: intent.payer, mayhemMode: intent.mayhemMode, cashback: intent.cashback }),
        pump.createFeeSharingConfig({ creator: intent.creator, mint: intent.mint, pool: null }),
        pump.updateFeeSharesV2({ authority: intent.creator, mint: intent.mint, currentShareholders: [intent.creator],
            newShareholders: [{ address: intent.feeCollector, shareBps: PUMP_FEE_COLLECTOR_BPS }],
            quoteMint: customPair?.mint ?? WRAPPED_SOL_MINT, quoteTokenProgram: customPair?.tokenProgram ?? SPL_TOKEN_PROGRAM_ID }),
    ]);
    if (!register.registrationAddress.equals(canonical.registrationAddress) || !sameInstruction(register.instruction, canonical.instruction)) {
        throw new LaunchValidationError("Direct registration factory differs from exact canonical instruction");
    }
    // SOL keeps the official sixteen-account instruction untouched. A custom pair
    // reuses the official argument encoding and appends the four pinned quote metas.
    const createInstruction = customPair
        ? appendPumpCustomPairAccounts(create, { mint: intent.mint, quote: customPair, name: intent.name, symbol: intent.symbol, uri: intent.metadataUri })
        : create;
    const stage = (id, instructions, signers) => ({ id, instructions,
        requiredSignerAddresses: [...new Map(signers.map(key => [key.toBase58(), key])).values()],
        estimatedSerializedBytes: codec.estimateSerializedBytes({ payer: intent.payer, instructions, lookupTables }) });
    const reimburse = quoted && !intent.payer.equals(input.operator)
        ? [SystemProgram.transfer({ fromPubkey: intent.payer, toPubkey: input.operator, lamports: quoted.lamports })] : [];
    // A custom pair: the fee-share update reads the pair's token accounts of the
    // creator and both creator vaults; a fresh coin has none, so the coin creation
    // step creates them (idempotently, at the creator's rent). See pump-custom-pairs.ts.
    const pairAccounts = customPair ? pumpCustomPairFeeShareAccountInstructions(intent.creator, intent.mint, customPair) : [];
    // (After registration: the compiler pins the registration's index right after
    // the creation; the two-step "create-mint" stage carries them with the creation.)
    const atomicInstructions = [...reimburse, createInstruction, register.instruction, sharing, ...pairAccounts, finalize, ...(buy ? buildDirectInitialBuyInstructions({ quote: buy.quote, snapshot: buy.snapshot, approval: buy.approval }) : [])];
    const atomicSigners = [intent.payer, intent.mint, intent.creator, input.operator];
    let atomic;
    try {
        atomic = stage("atomic", atomicInstructions, atomicSigners);
    }
    catch {
        atomic = { id: "atomic", instructions: atomicInstructions, requiredSignerAddresses: [...new Map(atomicSigners.map(key => [key.toBase58(), key])).values()], estimatedSerializedBytes: Number.POSITIVE_INFINITY };
    }
    const transactions = { atomic,
        "create-mint": stage("create-mint", [createInstruction, ...pairAccounts], [intent.payer, intent.mint]),
        "configure-fee-sharing": stage("configure-fee-sharing", [...reimburse, register.instruction, sharing, finalize], [intent.payer, input.operator, intent.creator]),
        "finalize-fee-shares": stage("finalize-fee-shares", [...reimburse, register.instruction, finalize], [intent.payer, input.operator, intent.creator]),
        "register-direct-batch": stage("register-direct-batch", [...reimburse, register.instruction], [intent.payer, input.operator]),
    };
    for (const transaction of Object.values(transactions).filter(value => value.id !== "atomic")) {
        if (!Number.isSafeInteger(transaction.estimatedSerializedBytes) || transaction.estimatedSerializedBytes > maxBytes) {
            throw new TransactionTooLargeError(transaction.id, transaction.estimatedSerializedBytes, maxBytes);
        }
    }
    const mode = Number.isSafeInteger(atomic.estimatedSerializedBytes) && atomic.estimatedSerializedBytes <= maxBytes ? "atomic" : "two-step";
    if (buy && mode !== "atomic")
        throw new TransactionTooLargeError("atomic", atomic.estimatedSerializedBytes, maxBytes);
    const registration = { ...options.registration, address: canonical.registrationAddress };
    if (zeroBuyLookupMode && mode !== "atomic")
        throw new LaunchValidationError("Zero-buy lookup launch must remain atomic");
    const serializableIntent = { executionMode: "direct-batch-v2", schemaVersion: buy ? 3 : quoted ? 2 : 1,
        ...(zeroBuyLookupMode ? { zeroBuyLookupMode } : {}),
        ...(buy ? { developerBuy: serializeDirectInitialBuyEnvelope(buy) } : {}),
        ...(quoted ? { registrationRentReimbursement: { lamports: quoted.lamports.toString(), quotedAtSlot: quoted.quotedAtSlot,
                accountBytes: DIRECT_BATCH_V2.accountLength, basis: "finalized-rent-quote" } } : {}),
        idempotencyKey: intent.idempotencyKey, mint: intent.mint.toBase58(), payer: intent.payer.toBase58(), creator: intent.creator.toBase58(),
        feeCollector: intent.feeCollector.toBase58(), name: intent.name, symbol: intent.symbol, metadataUri: intent.metadataUri,
        initialBuyLamports: intent.initialBuyLamports.toString(),
        quote: customPair ? { kind: "pump-custom-pair-v1", mint: customPair.mint.toBase58(), tokenProgram: customPair.tokenProgram.toBase58() } : "sol",
        mayhemMode: intent.mayhemMode, cashback: intent.cashback,
        registration: { programId: input.programId.toBase58(), address: registration.address.toBase58(), version: 2, operator: input.operator.toBase58(),
            rewardMint: input.rewardMint.toBase58(), rewardTokenProgram: input.rewardTokenProgram.toBase58(), launchTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
            pauseAuthority: input.pauseAuthority.toBase58(), protocolRecipient: input.protocolRecipient.toBase58(), policyVersion: 2,
            allocationBasis: "net-after-operating-costs", holdersBps: 8000, protocolBps: 2000, payoutIntervalSeconds: 300, pooledDeferredRewards: true } };
    return { executionMode: "direct-batch-v2", mode, intent, serializableIntent, registration, initialStage: mode === "atomic" ? "atomic" : "create-mint",
        transactions, lookupTables, maxSerializedBytes: maxBytes, readiness: { readyForSubmission: false, reason: "DIRECT_BATCH_RUNTIME_VERIFICATION_REQUIRED" } };
}
export function assertSameDirectBatchLaunchIntent(stored, candidate) {
    if (stored.executionMode !== "direct-batch-v2" || candidate.executionMode !== "direct-batch-v2"
        || canonicalIntentJson(stored) !== canonicalIntentJson(candidate)) {
        throw new LaunchIntentConflictError("Direct idempotency key is bound to a different immutable mode or launch intent");
    }
}
/** Read-only recovery decision. `prepare` is not permission to replace any
 * unknown/signed attempt: the direct executor additionally enforces durable CAS,
 * canonical signed bytes and signature finality before using this decision. */
export function resolveDirectBatchLaunchRecovery(plan, observation) {
    const conflict = (reason) => ({ kind: "conflict", reason });
    if (plan.executionMode !== "direct-batch-v2" || !observation.registration)
        return conflict("Explicit direct registration observation required; escrow is not a substitute");
    if ((observation.registration.exists || observation.feeSharing.exists) && !observation.mint.exists)
        return conflict("Configuration exists without launch mint/curve");
    if (plan.serializableIntent.developerBuy && observation.mint.exists && (!observation.registration.exists || !observation.feeSharing.exists || !observation.feeSharing.adminRevoked))
        return conflict("Atomic developer buy cannot recover a partial launch or execute a separate trade");
    if (observation.mint.exists && !observation.mint.bondingCurveCreator.equals(observation.feeSharing.exists ? pumpFeeSharingAddress(plan.intent.mint) : plan.intent.creator))
        return conflict("Pump creator differs");
    if (observation.registration.exists) {
        const actual = observation.registration.value, expected = registrationInput(plan.intent, plan.registration);
        if (actual.mode !== "direct-batch-v2" || !actual.initialized || actual.version !== 2 || actual.policyVersion !== 2
            || actual.allocationBasis !== DIRECT_BATCH_V2.allocationBasis || actual.holderBps !== 8000 || actual.protocolBps !== 2000
            || actual.payoutIntervalSeconds !== 300 || actual.pooledDeferredRewards !== true || !actual.address.equals(plan.registration.address)
            || Object.entries(expected).some(([field, key]) => !(actual[field] instanceof PublicKey)
                || !actual[field].equals(key)))
            return conflict("Direct registration immutable identity or net policy differs");
    }
    const prepare = (stage, reason) => ({ kind: "prepare", stage, transaction: plan.transactions[stage], reason });
    if (observation.feeSharing.exists) {
        const fees = observation.feeSharing;
        if (!fees.admin.equals(plan.intent.creator))
            return conflict("Pump fee admin differs");
        const share = fees.shareholders[0];
        if (fees.adminRevoked) {
            if (fees.shareholders.length !== 1 || !share?.address.equals(plan.intent.feeCollector) || share.shareBps !== 10000)
                return conflict("Final Pump collector route differs");
            return observation.registration.exists ? { kind: "complete", reason: "Finalized identities and immutable fee routing registered; no payout execution is implied" }
                : prepare("register-direct-batch", "Register direct mode after existing immutable Pump routing");
        }
        if (fees.shareholders.length !== 1 || !share?.address.equals(plan.intent.creator) || share.shareBps !== 10000)
            return conflict("Unexpected mutable Pump shareholders");
        if (observation.registration.exists)
            return conflict("Direct registration exists outside canonical fee-finalization boundary");
        return prepare("finalize-fee-shares", "Register direct mode and finalize fee shares atomically");
    }
    if (observation.registration.exists)
        return conflict("Direct registration exists before fee sharing");
    return observation.mint.exists ? prepare("configure-fee-sharing", "Register direct mode and create/finalize fee sharing atomically")
        : prepare(plan.initialStage, "Create the explicit direct-mode launch");
}
