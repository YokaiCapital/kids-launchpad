/** Client for the Solana Foundation `rewards` program's Merkle distribution instructions,
 * pinned to the audited commit aa1cfd9 (verified from source 16 Sep 2026; program id in
 * `program/src/lib.rs`). Shared by the API (fund and close legs) and the browser (the holder's
 * own `ClaimMerkle`), so it is browser-safe: no `node:` imports, no Buffer.
 *
 * Verified layouts:
 * - instruction discriminators: `program/src/traits/instruction.rs` (CreateMerkleDistribution 5,
 *   ClaimMerkle 6, CloseMerkleDistribution 8), one byte ahead of the data
 *   (`program/src/entrypoint.rs`, `split_first`).
 * - account orders and flags: `program/src/instructions/merkle/{create_distribution,claim,
 *   close_distribution}/accounts.rs`.
 * - instruction data: the matching `data.rs` files (create 58 bytes; claim 22 bytes minimum with
 *   a variable schedule and proof; close empty).
 * - account state: `program/src/state/{merkle_distribution,merkle_claim}.rs`. Every account has a
 *   TWO-BYTE HEADER (discriminator, version) before the struct
 *   (`program/src/traits/account.rs`, `LEN = 1 + 1 + DATA_LEN`).
 * - PDA seeds: the `PdaSeeds` impls in `program/src/state`; the event authority is
 *   `["event_authority"]` (`program/src/events/shared.rs`, EVENT_AUTHORITY_SEED). The codama docs
 *   say `__event_authority`; the code that the program checks against is the constant.
 * - error codes: `program/src/errors.rs`, numbered from 0 in declaration order.
 * Design: docs/design/KIDS_BABIES_MERKLE_CLAIMS_20260916.md §0. */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { IMMEDIATE_SCHEDULE, u64le } from './community-merkle.js';

export const REWARDS_PROGRAM_ID = new PublicKey('REWArDioXgQJ2fZKkfu9LCLjQfRwYWVVfsvcsR5hoXi');
/** The commit of github.com/solana-foundation/rewards these builders were verified against. */
export const REWARDS_PROGRAM_SOURCE_COMMIT = 'aa1cfd9276375e44e57d1917d110ff095fb6d475';

export const REWARDS_INSTRUCTION = Object.freeze({ createMerkleDistribution: 5, claimMerkle: 6, closeMerkleClaim: 7, closeMerkleDistribution: 8, revokeMerkleClaim: 10 } as const);
export const REWARDS_ACCOUNT_DISCRIMINATOR = Object.freeze({ merkleDistribution: 2, merkleClaim: 3, revocation: 4 } as const);
export const REWARDS_ACCOUNT_VERSION = 1;
/** `RewardsProgramError` custom codes the claim path branches on. */
export const REWARDS_ERROR = Object.freeze({ invalidAmount: 0, unauthorizedAuthority: 3, insufficientFunds: 5, nothingToClaim: 6, invalidAccountData: 8, invalidMerkleProof: 12, clawbackNotReached: 13, claimantAlreadyRevoked: 19 } as const);

export const MERKLE_DISTRIBUTION_SEED = 'merkle_distribution';
export const MERKLE_CLAIM_SEED = 'merkle_claim';
export const REVOCATION_SEED = 'revocation';
export const EVENT_AUTHORITY_SEED = 'event_authority';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export function findMerkleDistributionAddress(mint: PublicKey, authority: PublicKey, seed: PublicKey, programId: PublicKey = REWARDS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(MERKLE_DISTRIBUTION_SEED), mint.toBytes(), authority.toBytes(), seed.toBytes()], programId);
}
export function findMerkleClaimAddress(distribution: PublicKey, claimant: PublicKey, programId: PublicKey = REWARDS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(MERKLE_CLAIM_SEED), distribution.toBytes(), claimant.toBytes()], programId);
}
export function findRevocationAddress(distribution: PublicKey, claimant: PublicKey, programId: PublicKey = REWARDS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(REVOCATION_SEED), distribution.toBytes(), claimant.toBytes()], programId);
}
export function findEventAuthorityAddress(programId: PublicKey = REWARDS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8(EVENT_AUTHORITY_SEED)], programId);
}

function i64le(value: bigint): Uint8Array {
  if (typeof value !== 'bigint' || value < -(1n << 63n) || value > (1n << 63n) - 1n) throw new RangeError('Timestamp must fit a signed 64-bit integer');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value, true);
  return out;
}
function u32le(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError('Length must fit an unsigned 32-bit integer');
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}
function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function bytes32(value: Uint8Array, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new RangeError(`${what} must be exactly 32 bytes`);
  return value;
}
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });
const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export interface CreateMerkleDistributionParams {
  readonly payer: PublicKey; readonly authority: PublicKey;
  /** An arbitrary signer that makes the distribution address unique; it controls nothing afterwards. */
  readonly seed: PublicKey;
  readonly mint: PublicKey; readonly tokenProgram: PublicKey;
  /** The authority's token account the deposit is `TransferChecked` from. */
  readonly authorityTokenAccount: PublicKey;
  readonly merkleRoot: Uint8Array;
  /** Tokens moved into the vault now (gross, before a transfer fee). */
  readonly amount: bigint;
  /** Sum of every leaf; the program overwrites it with the vault's received balance. */
  readonly totalAmount: bigint;
  /** Unix seconds after which the authority may close; 0 = no gate. */
  readonly clawbackTs: bigint;
  /** Bitmask of allowed revoke modes; 0 = not revocable. */
  readonly revocable?: number;
  readonly programId?: PublicKey;
}
export interface CreateMerkleDistributionResult { readonly instruction: TransactionInstruction; readonly distribution: PublicKey; readonly bump: number; readonly vault: PublicKey; }

/** `CreateMerkleDistribution` (5): data `bump u8, revocable u8, amount u64, merkle_root [32], total_amount u64, clawback_ts i64`. */
export function createMerkleDistributionInstruction(params: CreateMerkleDistributionParams): CreateMerkleDistributionResult {
  const programId = params.programId ?? REWARDS_PROGRAM_ID;
  const revocable = params.revocable ?? 0;
  if (!Number.isInteger(revocable) || revocable < 0 || revocable > 255) throw new RangeError('revocable must be a byte');
  if (params.amount <= 0n || params.totalAmount <= 0n) throw new RangeError('The distribution amounts must be positive');
  const [distribution, bump] = findMerkleDistributionAddress(params.mint, params.authority, params.seed, programId);
  const vault = associatedTokenAddress(params.mint, distribution, params.tokenProgram);
  const [eventAuthority] = findEventAuthorityAddress(programId);
  const data = concat(Uint8Array.from([REWARDS_INSTRUCTION.createMerkleDistribution, bump, revocable]), u64le(params.amount), bytes32(params.merkleRoot, 'Merkle root'), u64le(params.totalAmount), i64le(params.clawbackTs));
  const keys: AccountMeta[] = [
    meta(params.payer, true, true), meta(params.authority, true, false), meta(params.seed, true, false),
    meta(distribution, false, true), meta(params.mint, false, false), meta(vault, false, true), meta(params.authorityTokenAccount, false, true),
    meta(SystemProgram.programId, false, false), meta(params.tokenProgram, false, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    meta(eventAuthority, false, false), meta(programId, false, false),
  ];
  return { instruction: new TransactionInstruction({ programId, keys, data: asBuffer(data) }), distribution, bump, vault };
}

export interface ClaimMerkleParams {
  readonly payer: PublicKey; readonly claimant: PublicKey; readonly distribution: PublicKey;
  readonly mint: PublicKey; readonly tokenProgram: PublicKey;
  /** The claimant's own token account; the program only checks the token program owns it. */
  readonly claimantTokenAccount: PublicKey;
  /** The leaf's total allocation (gross). */
  readonly totalAmount: bigint;
  /** Amount to claim now; 0 = everything vested. */
  readonly amount?: bigint;
  readonly schedule?: Uint8Array;
  readonly proof: readonly Uint8Array[];
  readonly programId?: PublicKey;
}
export interface ClaimMerkleResult { readonly instruction: TransactionInstruction; readonly claimAccount: PublicKey; readonly claimBump: number; readonly revocationMarker: PublicKey; readonly vault: PublicKey; }

/** `ClaimMerkle` (6): data `claim_bump u8, total_amount u64, amount u64, schedule, proof_len u32, proof [32]*n`. */
export function claimMerkleInstruction(params: ClaimMerkleParams): ClaimMerkleResult {
  const programId = params.programId ?? REWARDS_PROGRAM_ID;
  const amount = params.amount ?? 0n;
  const schedule = params.schedule ?? IMMEDIATE_SCHEDULE;
  if (params.totalAmount <= 0n) throw new RangeError('The leaf amount must be positive');
  if (params.proof.length > 32) throw new RangeError('Merkle proof exceeds 32 siblings');
  const [claimAccount, claimBump] = findMerkleClaimAddress(params.distribution, params.claimant, programId);
  const [revocationMarker] = findRevocationAddress(params.distribution, params.claimant, programId);
  const vault = associatedTokenAddress(params.mint, params.distribution, params.tokenProgram);
  const [eventAuthority] = findEventAuthorityAddress(programId);
  const data = concat(Uint8Array.from([REWARDS_INSTRUCTION.claimMerkle, claimBump]), u64le(params.totalAmount), u64le(amount), schedule, u32le(params.proof.length), ...params.proof.map((node, i) => bytes32(node, `Proof node ${i}`)));
  const keys: AccountMeta[] = [
    meta(params.payer, true, true), meta(params.claimant, true, false), meta(params.distribution, false, true), meta(claimAccount, false, true),
    meta(revocationMarker, false, false), meta(params.mint, false, false), meta(vault, false, true), meta(params.claimantTokenAccount, false, true),
    meta(SystemProgram.programId, false, false), meta(params.tokenProgram, false, false), meta(eventAuthority, false, false), meta(programId, false, false),
  ];
  return { instruction: new TransactionInstruction({ programId, keys, data: asBuffer(data) }), claimAccount, claimBump, revocationMarker, vault };
}

export interface CloseMerkleDistributionParams {
  readonly authority: PublicKey; readonly distribution: PublicKey; readonly mint: PublicKey; readonly tokenProgram: PublicKey;
  /** Receives the vault's remainder (taxed again on a transfer-fee mint). */
  readonly authorityTokenAccount: PublicKey;
  readonly programId?: PublicKey;
}
/** `CloseMerkleDistribution` (8): no data; authority only, after `clawback_ts`. */
export function closeMerkleDistributionInstruction(params: CloseMerkleDistributionParams): { readonly instruction: TransactionInstruction; readonly vault: PublicKey } {
  const programId = params.programId ?? REWARDS_PROGRAM_ID;
  const vault = associatedTokenAddress(params.mint, params.distribution, params.tokenProgram);
  const [eventAuthority] = findEventAuthorityAddress(programId);
  const keys: AccountMeta[] = [
    meta(params.authority, true, true), meta(params.distribution, false, true), meta(params.mint, false, false), meta(vault, false, true),
    meta(params.authorityTokenAccount, false, true), meta(params.tokenProgram, false, false), meta(eventAuthority, false, false), meta(programId, false, false),
  ];
  return { instruction: new TransactionInstruction({ programId, keys, data: asBuffer(Uint8Array.from([REWARDS_INSTRUCTION.closeMerkleDistribution])) }), vault };
}

/** The distribution's associated token account, derived here so the browser needs no spl-token helper with a Buffer dependency. */
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

export const MERKLE_DISTRIBUTION_ACCOUNT_LEN = 2 + 160;
export const MERKLE_CLAIM_ACCOUNT_LEN = 2 + 16;

export interface MerkleDistributionState {
  readonly bump: number; readonly revocable: number; readonly authority: PublicKey; readonly mint: PublicKey; readonly seed: PublicKey;
  readonly merkleRoot: Uint8Array; readonly totalAmount: bigint; readonly totalClaimed: bigint; readonly clawbackTs: bigint;
}
function header(data: Uint8Array, discriminator: number, length: number, what: string): DataView {
  if (!(data instanceof Uint8Array) || data.length < length) throw new RangeError(`${what} account data is too short`);
  if (data[0] !== discriminator) throw new RangeError(`${what} account has the wrong discriminator`);
  if (data[1] !== REWARDS_ACCOUNT_VERSION) throw new RangeError(`${what} account has an unknown version`);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
/** `MerkleDistribution`: header 0..2, bump 2, revocable 3, pad 4..10, authority 10..42, mint 42..74, seed 74..106, root 106..138, total_amount 138..146, total_claimed 146..154, clawback_ts 154..162. */
export function decodeMerkleDistribution(data: Uint8Array): MerkleDistributionState {
  const view = header(data, REWARDS_ACCOUNT_DISCRIMINATOR.merkleDistribution, MERKLE_DISTRIBUTION_ACCOUNT_LEN, 'MerkleDistribution');
  return {
    bump: data[2] as number, revocable: data[3] as number,
    authority: new PublicKey(data.subarray(10, 42)), mint: new PublicKey(data.subarray(42, 74)), seed: new PublicKey(data.subarray(74, 106)),
    merkleRoot: data.slice(106, 138), totalAmount: view.getBigUint64(138, true), totalClaimed: view.getBigUint64(146, true), clawbackTs: view.getBigInt64(154, true),
  };
}
export interface MerkleClaimState { readonly bump: number; readonly claimedAmount: bigint; }
/** `MerkleClaim`: header 0..2, bump 2, pad 3..10, claimed_amount 10..18. */
export function decodeMerkleClaim(data: Uint8Array): MerkleClaimState {
  const view = header(data, REWARDS_ACCOUNT_DISCRIMINATOR.merkleClaim, MERKLE_CLAIM_ACCOUNT_LEN, 'MerkleClaim');
  return { bump: data[2] as number, claimedAmount: view.getBigUint64(10, true) };
}
