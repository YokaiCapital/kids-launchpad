import { sha256 } from "@noble/hashes/sha2.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
/** Registration-only ABI. This does not modify the deployed v1 IDL. */
export const DIRECT_BATCH_V2 = Object.freeze({ version: 2, mode: "direct-batch-v2", policyVersion: 2,
    allocationBasis: "net-after-operating-costs", holderBps: 8_000, protocolBps: 2_000,
    payoutIntervalSeconds: 300, pooledDeferredRewards: true, accountLength: 289 });
const IX = Buffer.from(sha256(Buffer.from("global:register_direct_batch_v2")).slice(0, 8));
const ACCOUNT = Buffer.from(sha256(Buffer.from("account:DirectBatchRegistrationV2")).slice(0, 8));
export function deriveDirectBatchRegistrationV2(launchMint, operator, programId) {
    return PublicKey.findProgramAddressSync([Buffer.from("direct_batch_v2"), launchMint.toBuffer(), operator.toBuffer()], programId);
}
function validate(input) {
    for (const [field, key] of Object.entries(input)) {
        if (!(key instanceof PublicKey) || key.equals(PublicKey.default))
            throw new Error(`Invalid direct registration ${field}`);
    }
    if (!PublicKey.isOnCurve(input.operator.toBytes()))
        throw new Error("Direct operator must be a transaction signer");
    for (const key of [input.launchTokenProgram, input.rewardTokenProgram]) {
        if (!key.equals(TOKEN_PROGRAM_ID) && !key.equals(TOKEN_2022_PROGRAM_ID))
            throw new Error("Noncanonical direct token program");
    }
    if (input.launchMint.equals(input.rewardMint))
        throw new Error("Direct launch/reward mints must differ");
    if (!input.feeCollector.equals(input.operator))
        throw new Error("Direct fee collector must equal operator");
    if (input.protocolRecipient.equals(input.operator))
        throw new Error("Direct protocol recipient must differ from operator");
}
/** Unsigned construction only. No RPC, wallet, transaction, or generated v1 IDL. */
export function buildRegisterDirectBatchV2Instruction(input) {
    validate(input);
    const [registrationAddress] = deriveDirectBatchRegistrationV2(input.launchMint, input.operator, input.programId);
    return { registrationAddress, instruction: new TransactionInstruction({ programId: input.programId,
            keys: [
                { pubkey: input.operator, isSigner: true, isWritable: true },
                { pubkey: input.launchMint, isSigner: false, isWritable: false },
                { pubkey: input.rewardMint, isSigner: false, isWritable: false },
                { pubkey: registrationAddress, isSigner: false, isWritable: true },
                { pubkey: input.launchTokenProgram, isSigner: false, isWritable: false },
                { pubkey: input.rewardTokenProgram, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ], data: Buffer.concat([IX, input.feeCollector.toBuffer(), input.protocolRecipient.toBuffer(), input.pauseAuthority.toBuffer()]) }) };
}
export function createDirectBatchV2InstructionFactory(programId) {
    return { async registerDirectBatchV2(input) {
            if (!input.programId.equals(programId))
                throw new Error("Direct registration program ID differs from factory");
            return buildRegisterDirectBatchV2Instruction(input);
        } };
}
/** Exact fixed-layout decoder. RPC ownership/finality must be checked by caller.
 * An unknown discriminator/version is never interpreted as legacy escrow. */
export function decodeDirectBatchRegistrationV2(data, address, programId) {
    const bytes = Buffer.from(data);
    if (bytes.length !== DIRECT_BATCH_V2.accountLength || !bytes.subarray(0, 8).equals(ACCOUNT))
        throw new Error("Invalid direct registration discriminator or length");
    if (bytes.readUInt16LE(8) !== 2 || bytes[11] !== 1 || bytes[12] !== 2 || bytes.readUInt16LE(269) !== 2
        || bytes[271] !== 1 || bytes.readUInt16LE(272) !== 8000 || bytes.readUInt16LE(274) !== 2000
        || bytes.readUInt32LE(276) !== 300 || bytes[280] !== 1)
        throw new Error("Invalid direct registration mode or immutable policy");
    const key = (offset) => new PublicKey(bytes.subarray(offset, offset + 32));
    const input = { programId, launchMint: key(13), launchTokenProgram: key(45), rewardMint: key(77), rewardTokenProgram: key(109),
        operator: key(141), feeCollector: key(173), protocolRecipient: key(205), pauseAuthority: key(237) };
    validate(input);
    const [expected, bump] = deriveDirectBatchRegistrationV2(input.launchMint, input.operator, programId);
    if (!expected.equals(address) || bytes[10] !== bump)
        throw new Error("Direct registration PDA or bump differs");
    return Object.freeze({ ...input, ...DIRECT_BATCH_V2, address, bump, initialized: true, createdAtSlot: bytes.readBigUInt64LE(281) });
}
