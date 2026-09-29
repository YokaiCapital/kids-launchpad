import { PublicKey, SystemProgram } from "@solana/web3.js";
import { assertSameDirectBatchLaunchIntent } from "./direct-batch-v2.js";
import { PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./constants.js";
import { PUMP_CREATE_V2_CUSTOM_PAIR_ACCOUNTS, PUMP_CREATE_V2_DISCRIMINATOR, PUMP_CREATE_V2_SOL_ACCOUNTS, pumpCustomPairCreateAccounts, validatePumpCustomPairQuote } from "./pump-custom-pairs.js";
import { buildRegisterDirectBatchV2Instruction } from "../../router-client/src/direct-batch-v2.js";
import { assertDirectInitialBuyInstructions, parseDirectInitialBuyEnvelope } from "./direct-initial-buy.js";
import { assertZeroBuyLookupTables } from "./zero-buy-lookup.js";
/** Explicit direct-mode compiler; never impersonates a legacy escrow plan. */
export function compileDirectBatchLaunchTransaction(plan, stage, recentBlockhash, codec) {
    if (plan.executionMode !== "direct-batch-v2" || plan.registration.mode !== "direct-batch-v2"
        || !Number.isSafeInteger(plan.maxSerializedBytes) || plan.maxSerializedBytes < 1 || plan.maxSerializedBytes > 1232)
        throw new Error("Invalid trusted direct launch plan");
    const { intent, registration } = plan;
    const reimbursement = plan.serializableIntent.registrationRentReimbursement;
    if (plan.serializableIntent.zeroBuyLookupMode !== undefined) {
        if (plan.serializableIntent.schemaVersion !== 2 || !reimbursement || plan.serializableIntent.developerBuy !== undefined
            || intent.initialBuyLamports !== 0n || stage !== "atomic" || plan.mode !== "atomic")
            throw new Error("Zero-buy lookup is exclusively a reimbursed atomic zero-buy intent");
        assertZeroBuyLookupTables(plan.serializableIntent.zeroBuyLookupMode, plan.lookupTables, { mint: intent.mint.toBase58(), operator: registration.operator.toBase58(), routerProgramId: registration.programId.toBase58() });
    }
    const buy = plan.serializableIntent.developerBuy ? parseDirectInitialBuyEnvelope(plan.serializableIntent.developerBuy) : undefined;
    if (Boolean(buy) !== (plan.serializableIntent.schemaVersion === 3))
        throw new Error("Versioned developer buy intent required");
    if (reimbursement ? plan.serializableIntent.schemaVersion !== (buy ? 3 : 2) || reimbursement.accountBytes !== 289 || reimbursement.basis !== "finalized-rent-quote"
        || !/^[1-9][0-9]{0,19}$/.test(reimbursement.lamports) || BigInt(reimbursement.lamports) > 18446744073709551615n
        || !Number.isSafeInteger(reimbursement.quotedAtSlot) || reimbursement.quotedAtSlot < 0 : plan.serializableIntent.schemaVersion !== 1)
        throw new Error("Invalid versioned registration reimbursement");
    if (intent.initialBuyLamports !== (buy?.approval.spendableSolIn ?? 0n) || intent.quote.kind !== "sol")
        throw new Error("Direct launch initial buy differs from exact approved SOL quote");
    // A Pump custom pair is the only alternative to the "sol" literal, and only as
    // a zero-buy launch (with or without the lane's static-plus-frozen-mint tables).
    const customQuote = plan.serializableIntent.quote;
    if (customQuote !== "sol") {
        if (customQuote?.kind !== "pump-custom-pair-v1" || buy || intent.initialBuyLamports !== 0n)
            throw new Error("Unknown or unsupported direct launch quote asset");
        validatePumpCustomPairQuote({ mint: new PublicKey(customQuote.mint), tokenProgram: new PublicKey(customQuote.tokenProgram) });
        if (new PublicKey(customQuote.mint).toBase58() !== customQuote.mint
            || new PublicKey(customQuote.tokenProgram).toBase58() !== customQuote.tokenProgram)
            throw new Error("Custom pair quote identity is not canonical");
    }
    if (buy && (stage !== "atomic" || plan.mode !== "atomic" || plan.initialStage !== "atomic" || !reimbursement || !intent.payer.equals(intent.creator)
        || intent.mayhemMode || intent.cashback || buy.approval.mint !== intent.mint.toBase58() || buy.approval.creator !== intent.creator.toBase58()))
        throw new Error("Developer buy is exclusively atomic with exact creator/mint identity");
    assertSameDirectBatchLaunchIntent(plan.serializableIntent, { ...plan.serializableIntent,
        executionMode: "direct-batch-v2", schemaVersion: buy ? 3 : reimbursement ? 2 : 1, idempotencyKey: intent.idempotencyKey, mint: intent.mint.toBase58(), payer: intent.payer.toBase58(),
        creator: intent.creator.toBase58(), feeCollector: intent.feeCollector.toBase58(), name: intent.name, symbol: intent.symbol,
        metadataUri: intent.metadataUri, initialBuyLamports: intent.initialBuyLamports.toString(), quote: customQuote, mayhemMode: intent.mayhemMode, cashback: intent.cashback,
        registration: { ...plan.serializableIntent.registration, address: registration.address.toBase58(), programId: registration.programId.toBase58(),
            operator: registration.operator.toBase58(), rewardMint: registration.rewardMint.toBase58(), rewardTokenProgram: registration.rewardTokenProgram.toBase58(),
            pauseAuthority: registration.pauseAuthority.toBase58(), protocolRecipient: registration.protocolRecipient.toBase58(), version: 2,
            launchTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(), policyVersion: 2, allocationBasis: "net-after-operating-costs",
            holdersBps: 8000, protocolBps: 2000, payoutIntervalSeconds: 300, pooledDeferredRewards: true } });
    const planned = plan.transactions[stage];
    if (!planned || planned.id !== stage)
        throw new Error("Unknown direct launch stage");
    // The create_v2 shape is the whole custom-pair change, so it is pinned here as
    // well as at build time: sixteen accounts for SOL, twenty for a custom pair
    // whose last four are exactly the derived quote metas.
    const creates = planned.instructions.filter(instruction => instruction.programId.equals(PUMP_PROGRAM_ID)
        && instruction.data.length >= 8 && instruction.data.subarray(0, 8).equals(Buffer.from(PUMP_CREATE_V2_DISCRIMINATOR)));
    if (creates.length > 1)
        throw new Error("A direct launch carries at most one create_v2");
    const create = creates[0];
    if (create) {
        const expectedAccounts = customQuote === "sol" ? PUMP_CREATE_V2_SOL_ACCOUNTS : PUMP_CREATE_V2_CUSTOM_PAIR_ACCOUNTS;
        if (create.keys.length !== expectedAccounts)
            throw new Error(`create_v2 must carry exactly ${expectedAccounts} accounts for this quote asset`);
        if (customQuote !== "sol") {
            const expected = pumpCustomPairCreateAccounts(intent.mint, { mint: new PublicKey(customQuote.mint), tokenProgram: new PublicKey(customQuote.tokenProgram) });
            const appended = create.keys.slice(PUMP_CREATE_V2_SOL_ACCOUNTS);
            if (appended.some((meta, index) => !meta.pubkey.equals(expected[index].pubkey) || meta.isSigner !== expected[index].isSigner
                || meta.isWritable !== expected[index].isWritable))
                throw new Error("create_v2 quote accounts differ from the pinned custom-pair layout");
        }
    }
    if (buy) {
        if (planned.instructions.length !== (intent.payer.equals(registration.operator) ? 6 : 7))
            throw new Error("Exact create/register/share/finalize/ATA/buy sequence required");
        assertDirectInitialBuyInstructions(planned.instructions.slice(-2), { quote: buy.quote, snapshot: buy.snapshot, approval: buy.approval });
    }
    if (reimbursement && stage !== "create-mint" && !intent.payer.equals(registration.operator)) {
        const expected = SystemProgram.transfer({ fromPubkey: intent.payer, toPubkey: registration.operator, lamports: BigInt(reimbursement.lamports) });
        const first = planned.instructions[0];
        if (!first?.programId.equals(expected.programId) || !first.data.equals(expected.data) || first.keys.length !== expected.keys.length
            || !first.keys.every((key, i) => key.pubkey.equals(expected.keys[i].pubkey) && key.isSigner === expected.keys[i].isSigner && key.isWritable === expected.keys[i].isWritable)
            || planned.instructions.slice(1).some(ix => ix.programId.equals(SystemProgram.programId)))
            throw new Error("Exact registration reimbursement must accompany registration once");
    }
    else if (reimbursement && planned.instructions.some(ix => ix.programId.equals(SystemProgram.programId)))
        throw new Error("No separate reimbursement for mint-only stage or same-wallet operator");
    if (reimbursement && stage !== "create-mint") {
        const register = buildRegisterDirectBatchV2Instruction({ programId: registration.programId, operator: registration.operator,
            launchMint: intent.mint, launchTokenProgram: TOKEN_2022_PROGRAM_ID, rewardMint: registration.rewardMint, rewardTokenProgram: registration.rewardTokenProgram,
            feeCollector: intent.feeCollector, protocolRecipient: registration.protocolRecipient, pauseAuthority: registration.pauseAuthority }).instruction;
        const index = (intent.payer.equals(registration.operator) ? 0 : 1) + (stage === "atomic" ? 1 : 0), actual = planned.instructions[index];
        if (!actual?.programId.equals(register.programId) || !actual.data.equals(register.data) || actual.keys.length !== register.keys.length
            || !actual.keys.every((key, i) => key.pubkey.equals(register.keys[i].pubkey) && key.isSigner === register.keys[i].isSigner && key.isWritable === register.keys[i].isWritable)
            || planned.instructions.filter(ix => ix.programId.equals(register.programId)).length !== 1)
            throw new Error("Reimbursement requires the exact same-packet registration");
    }
    const transaction = codec.compile({ payer: intent.payer, recentBlockhash, instructions: planned.instructions, lookupTables: plan.lookupTables });
    const required = planned.requiredSignerAddresses.map(key => key.toBase58()).sort();
    const actual = transaction.message.staticAccountKeys.slice(0, transaction.message.header.numRequiredSignatures).map(key => key.toBase58()).sort();
    if (transaction.version !== 0 || required.length !== actual.length || required.some((key, index) => key !== actual[index]))
        throw new Error("Direct transaction signer set differs");
    if (transaction.serialize().length > plan.maxSerializedBytes)
        throw new Error("Direct transaction exceeds packet cap");
    return transaction;
}
