export class LauncherSdkError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "LauncherSdkError";
    }
}
export class LaunchValidationError extends LauncherSdkError {
    constructor(message) {
        super("INVALID_LAUNCH", message);
        this.name = "LaunchValidationError";
    }
}
export class LaunchNotReadyError extends LauncherSdkError {
    reasons;
    constructor(reasons) {
        super("LAUNCH_NOT_READY", `launch plan is not ready for submission: ${reasons.join(", ")}`);
        this.reasons = reasons;
        this.name = "LaunchNotReadyError";
    }
}
export class TransactionTooLargeError extends LauncherSdkError {
    stage;
    serializedBytes;
    maximumBytes;
    constructor(stage, serializedBytes, maximumBytes) {
        super("TRANSACTION_TOO_LARGE", `${stage} is ${serializedBytes} bytes; maximum is ${maximumBytes} bytes`);
        this.stage = stage;
        this.serializedBytes = serializedBytes;
        this.maximumBytes = maximumBytes;
        this.name = "TransactionTooLargeError";
    }
}
export class SignerSetMismatchError extends LauncherSdkError {
    stage;
    expected;
    actual;
    constructor(stage, expected, actual) {
        super("SIGNER_SET_MISMATCH", `${stage} requires [${actual.join(", ")}], expected [${expected.join(", ")}]`);
        this.stage = stage;
        this.expected = expected;
        this.actual = actual;
        this.name = "SignerSetMismatchError";
    }
}
export class TransactionVersionError extends LauncherSdkError {
    stage;
    constructor(stage) {
        super("EXPECTED_V0_TRANSACTION", `${stage} did not compile to a v0 transaction`);
        this.stage = stage;
        this.name = "TransactionVersionError";
    }
}
export class LaunchIntentConflictError extends LauncherSdkError {
    constructor(message) {
        super("LAUNCH_INTENT_CONFLICT", message);
        this.name = "LaunchIntentConflictError";
    }
}
export class LaunchJournalConflictError extends LauncherSdkError {
    constructor(message) {
        super("LAUNCH_JOURNAL_CONFLICT", message);
        this.name = "LaunchJournalConflictError";
    }
}
