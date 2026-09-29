import { TransactionMessage, VersionedTransaction, } from "@solana/web3.js";
const SIZE_ESTIMATE_BLOCKHASH = "11111111111111111111111111111111";
export class Web3V0TransactionCodec {
    estimateSerializedBytes(input) {
        const transaction = this.compile({
            ...input,
            recentBlockhash: SIZE_ESTIMATE_BLOCKHASH,
        });
        // web3 serializes into a packet-sized scratch buffer. Estimating by
        // serializing throws before the planner can select a split transaction.
        const compact = (length) => {
            let bytes = 1;
            while (length >= 128) {
                bytes += 1;
                length >>>= 7;
            }
            return bytes;
        };
        const message = transaction.message;
        return compact(transaction.signatures.length) + 64 * transaction.signatures.length
            + 1 + 3 + compact(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length + 32
            + compact(message.compiledInstructions.length)
            + message.compiledInstructions.reduce((size, ix) => size + 1
                + compact(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length
                + compact(ix.data.length) + ix.data.length, 0)
            + compact(message.addressTableLookups.length)
            + message.addressTableLookups.reduce((size, lookup) => size + 32
                + compact(lookup.writableIndexes.length) + lookup.writableIndexes.length
                + compact(lookup.readonlyIndexes.length) + lookup.readonlyIndexes.length, 0);
    }
    compile(input) {
        const message = new TransactionMessage({
            payerKey: input.payer,
            recentBlockhash: input.recentBlockhash,
            instructions: [...input.instructions],
        }).compileToV0Message([...input.lookupTables]);
        return new VersionedTransaction(message);
    }
}
