import { PublicKey } from "@solana/web3.js";
import { KIDS_FEE_SPLITS } from "../../fee-policy/index.js";
import { LaunchIntentConflictError, LaunchValidationError } from "./errors.js";
import { canonicalIntentJson } from "./canonical-json.js";
const DEFAULT_PUBLIC_KEY = new PublicKey("11111111111111111111111111111111");
const utf8 = new TextEncoder();
function validateBoundedUtf8(value, field, maximumBytes) {
    if (value.trim().length === 0) {
        throw new LaunchValidationError(`${field} must not be empty`);
    }
    const bytes = utf8.encode(value).byteLength;
    if (bytes > maximumBytes) {
        throw new LaunchValidationError(`${field} is ${bytes} UTF-8 bytes; maximum is ${maximumBytes}`);
    }
}
function validatePublicKey(key, field) {
    if (key.equals(DEFAULT_PUBLIC_KEY)) {
        throw new LaunchValidationError(`${field} must not be the default public key`);
    }
}
function rejectFeePolicyOverride(request) {
    const input = request;
    if (Object.prototype.hasOwnProperty.call(input, "feeCollector")) {
        throw new LaunchValidationError("feeCollector is trusted deployment configuration; pass it through BuildLaunchPlanOptions");
    }
    for (const legacyField of ["feeShares", "splits", "feeSplitBps", "potBps", "buybackBps"]) {
        if (Object.prototype.hasOwnProperty.call(input, legacyField)) {
            throw new LaunchValidationError(`${legacyField} is not accepted; Kids fixes creator fees at 80% holders and 20% protocol`);
        }
    }
    for (const trustedField of [
        "rewardRouter",
        "routerProgramId",
        "operator",
        "rewardMint",
        "rewardTokenProgram",
        "pauseAuthority",
        "protocolRecipient",
        "unclaimedRecipient",
    ]) {
        if (Object.prototype.hasOwnProperty.call(input, trustedField)) {
            throw new LaunchValidationError(`${trustedField} is trusted deployment configuration and cannot be supplied by a launch request`);
        }
    }
    for (const unsupportedBuyField of [
        "initialBuy",
        "initialBuyAmount",
        "initialBuySol",
        "buyAmount",
        "solAmount",
    ]) {
        if (Object.prototype.hasOwnProperty.call(input, unsupportedBuyField)) {
            throw new LaunchValidationError(`${unsupportedBuyField} is unsupported; launcher v1 does not perform an initial buy`);
        }
    }
}
export function normalizeLaunchRequest(request, feeCollector) {
    validatePublicKey(request.mint, "mint");
    validatePublicKey(request.payer, "payer");
    validatePublicKey(request.creator, "creator");
    if (feeCollector === undefined) {
        throw new LaunchValidationError("feeCollector is required trusted deployment configuration");
    }
    validatePublicKey(feeCollector, "feeCollector");
    validateBoundedUtf8(request.name, "name", 32);
    validateBoundedUtf8(request.symbol, "symbol", 13);
    validateBoundedUtf8(request.metadataUri, "metadataUri", 200);
    rejectFeePolicyOverride(request);
    if (request.idempotencyKey !== undefined) {
        validateBoundedUtf8(request.idempotencyKey, "idempotencyKey", 200);
    }
    if (request.quote !== undefined && request.quote.kind !== "sol") {
        throw new LaunchValidationError("launcher v1 supports only SOL quote assets; non-SOL quotes are disabled");
    }
    if (request.initialBuyLamports !== undefined &&
        (typeof request.initialBuyLamports !== "bigint" ||
            request.initialBuyLamports !== 0n)) {
        throw new LaunchValidationError("initialBuyLamports must be zero; launcher v1 does not perform an initial buy");
    }
    return {
        idempotencyKey: request.idempotencyKey ?? `pump-launch:${request.mint.toBase58()}`,
        mint: request.mint,
        payer: request.payer,
        creator: request.creator,
        feeCollector,
        name: request.name,
        symbol: request.symbol,
        metadataUri: request.metadataUri,
        feeSplitBps: { ...KIDS_FEE_SPLITS },
        quote: request.quote ?? { kind: "sol" },
        initialBuyLamports: 0n,
        mayhemMode: request.mayhemMode ?? false,
        cashback: request.cashback ?? false,
    };
}
export function serializeLaunchIntent(intent, rewardRouter) {
    return {
        idempotencyKey: intent.idempotencyKey,
        mint: intent.mint.toBase58(),
        payer: intent.payer.toBase58(),
        creator: intent.creator.toBase58(),
        feeCollector: intent.feeCollector.toBase58(),
        name: intent.name,
        symbol: intent.symbol,
        metadataUri: intent.metadataUri,
        feeSplitBps: { ...intent.feeSplitBps },
        quote: { kind: "sol" },
        initialBuyLamports: "0",
        rewardRouter: {
            programId: rewardRouter.programId.toBase58(),
            operator: rewardRouter.operator.toBase58(),
            rewardMint: rewardRouter.rewardMint.toBase58(),
            rewardTokenProgram: rewardRouter.rewardTokenProgram.toBase58(),
            pauseAuthority: rewardRouter.pauseAuthority.toBase58(),
            protocolRecipient: rewardRouter.protocolRecipient.toBase58(),
            unclaimedRecipient: rewardRouter.unclaimedRecipient.toBase58(),
            version: rewardRouter.version,
            configAddress: rewardRouter.configAddress.toBase58(),
            rewardVaultAddress: rewardRouter.rewardVaultAddress.toBase58(),
        },
        mayhemMode: intent.mayhemMode,
        cashback: intent.cashback,
    };
}
export function assertSameLaunchIntent(stored, candidate) {
    // Canonical (sorted-key) comparison: a stored intent is parsed back in the
    // key order its JSON text had, while the candidate follows the builder's
    // construction order, so a plain stringify compare turns any field reordering
    // into "already bound to a different launch intent" (COD-19).
    if (canonicalIntentJson(stored) !== canonicalIntentJson(candidate)) {
        throw new LaunchIntentConflictError(`idempotency key ${candidate.idempotencyKey} is already bound to a different launch intent`);
    }
}
