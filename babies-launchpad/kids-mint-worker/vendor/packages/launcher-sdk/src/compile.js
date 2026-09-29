import { SignerSetMismatchError, TransactionTooLargeError, TransactionVersionError, } from "./errors.js";
import { assertLaunchPlanReady } from "./readiness.js";
/** Compile only after recovery has selected a stage and RPC returned a fresh hash. */
export function compileLaunchTransaction(plan, stage, recentBlockhash, codec) {
    assertLaunchPlanReady(plan);
    const planned = plan.transactions[stage];
    const transaction = codec.compile({
        payer: plan.intent.payer,
        recentBlockhash,
        instructions: planned.instructions,
        lookupTables: plan.lookupTables,
    });
    if (transaction.version !== 0 ||
        !("staticAccountKeys" in transaction.message)) {
        throw new TransactionVersionError(stage);
    }
    const expectedSigners = planned.requiredSignerAddresses
        .map((address) => address.toBase58())
        .sort();
    const actualSigners = transaction.message.staticAccountKeys
        .slice(0, transaction.message.header.numRequiredSignatures)
        .map((address) => address.toBase58())
        .sort();
    if (expectedSigners.length !== actualSigners.length ||
        expectedSigners.some((address, index) => address !== actualSigners[index])) {
        throw new SignerSetMismatchError(stage, expectedSigners, actualSigners);
    }
    const actualBytes = transaction.serialize().byteLength;
    if (actualBytes > plan.maxSerializedBytes) {
        throw new TransactionTooLargeError(stage, actualBytes, plan.maxSerializedBytes);
    }
    return transaction;
}
