/** KIDS Babies claims through the Solana Foundation `rewards` Merkle distributor
 * (`REWArDioXgQJ2fZKkfu9LCLjQfRwYWVVfsvcsR5hoXi`): the tree the API builds over a
 * coin's published allocations and the proof the browser sends with `ClaimMerkle`.
 *
 * Every byte here mirrors the program source at commit aa1cfd9 (verified 16 Sep 2026):
 * - leaf  = keccak256(0x00 || keccak256(claimant[32] || total_amount u64 LE || schedule_bytes))
 *           (`program/src/utils/merkle_utils.rs`, `compute_leaf_hash`; LEAF_PREFIX = [0])
 * - node  = keccak256(min(a, b) || max(a, b)) (`hash_pair`, byte-wise comparison)
 * - odd node at a level is promoted unchanged; a single leaf is its own root with an empty
 *   proof (`tests/integration-tests/src/utils/merkle_utils.rs`, `MerkleTree`)
 * - the `Immediate` vesting schedule encodes as the single byte 0x00
 *   (`program/src/utils/vesting_utils.rs`, `VestingSchedule::to_bytes`)
 *
 * Browser-safe: no `node:` imports and no Buffer; `@noble/hashes` is already a dependency.
 * `packages/router-client/src/merkle.ts` hashes with different domain prefixes, so it cannot
 * be reused here. Design: docs/design/KIDS_BABIES_MERKLE_CLAIMS_20260916.md §2. */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { PublicKey } from '@solana/web3.js';

const MAX_U64 = (1n << 64n) - 1n;
/** `VestingSchedule::Immediate` as the program serialises it: one byte, 0x00. */
export const IMMEDIATE_SCHEDULE: Uint8Array = Uint8Array.from([0]);
/** Second-preimage guard the program prepends to every leaf's inner hash. */
export const REWARDS_LEAF_PREFIX: Uint8Array = Uint8Array.from([0]);

export function u64le(value: bigint): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) throw new RangeError('Amount must fit an unsigned 64-bit integer');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
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

/** Byte-wise comparison, as Rust compares `[u8; 32]`: negative when a < b. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) { const d = (a[i] as number) - (b[i] as number); if (d !== 0) return d; }
  return a.length - b.length;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && compareBytes(a, b) === 0; }

export function toHex(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += b.toString(16).padStart(2, '0'); return s; }
export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new RangeError('Invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The program's `compute_leaf_hash`: claimant || total_amount LE || schedule, hashed twice with the leaf prefix. */
export function rewardsLeafHash(claimant: PublicKey, totalAmount: bigint, schedule: Uint8Array = IMMEDIATE_SCHEDULE): Uint8Array {
  if (schedule.length < 1 || schedule.length > 25) throw new RangeError('Vesting schedule must be 1 to 25 bytes');
  const inner = keccak_256(concat(claimant.toBytes(), u64le(totalAmount), schedule));
  return keccak_256(concat(REWARDS_LEAF_PREFIX, inner));
}

/** The program's `hash_pair`: keccak256 of the two nodes in byte order, smaller first. */
export function rewardsPairHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const left = bytes32(a, 'Left node'), right = bytes32(b, 'Right node');
  return compareBytes(left, right) < 0 ? keccak_256(concat(left, right)) : keccak_256(concat(right, left));
}

/** The program's `verify_proof`: fold the siblings from the leaf up and compare with the root. */
export function verifyCommunityProof(leafHash: Uint8Array, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  let hash = bytes32(leafHash, 'Leaf hash');
  for (const sibling of proof) hash = rewardsPairHash(hash, sibling);
  return bytesEqual(hash, bytes32(root, 'Root'));
}

export interface CommunityMerkleInput { readonly owner: string; readonly amountRaw: bigint; }
export interface CommunityMerkleLeaf { readonly owner: string; readonly amountRaw: bigint; readonly index: number; readonly leafHash: Uint8Array; readonly proof: readonly Uint8Array[]; }
export interface CommunityMerkleTree { readonly root: Uint8Array; readonly rootHex: string; readonly totalRaw: bigint; readonly leaves: readonly CommunityMerkleLeaf[]; }

function nextLevel(hashes: readonly Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < hashes.length; i += 2) {
    const right = hashes[i + 1];
    out.push(right === undefined ? (hashes[i] as Uint8Array) : rewardsPairHash(hashes[i] as Uint8Array, right));
  }
  return out;
}

/** Build the claim tree over a coin's allocations, every leaf on the `Immediate` schedule.
 * Leaves sit in owner code-unit order (the order `computeCommunityAllocation` publishes);
 * duplicate owners and non-positive amounts are refused (a zero leaf is unclaimable, and the
 * sum must be exactly the vault's balance). Proofs are computed with the program's own test
 * builder rule: at each level the sibling if it exists, and an odd node promoted unchanged. */
export function buildCommunityMerkleTree(inputs: readonly CommunityMerkleInput[]): CommunityMerkleTree {
  if (inputs.length === 0) throw new RangeError('A community claim tree needs at least one leaf');
  const seen = new Set<string>();
  for (const input of inputs) {
    if (typeof input.owner !== 'string' || input.owner.length === 0) throw new RangeError('Every leaf needs an owner');
    if (seen.has(input.owner)) throw new RangeError(`Duplicate owner in the claim tree: ${input.owner}`);
    seen.add(input.owner);
    if (typeof input.amountRaw !== 'bigint' || input.amountRaw <= 0n) throw new RangeError(`Leaf amount must be positive: ${input.owner}`);
  }
  const ordered = [...inputs].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const hashes = ordered.map(input => rewardsLeafHash(new PublicKey(input.owner), input.amountRaw));
  const levels: Uint8Array[][] = [hashes];
  while ((levels[levels.length - 1] as Uint8Array[]).length > 1) levels.push(nextLevel(levels[levels.length - 1] as Uint8Array[]));
  const root = (levels[levels.length - 1] as Uint8Array[])[0] as Uint8Array;
  let totalRaw = 0n;
  const leaves = ordered.map((input, index) => {
    totalRaw += input.amountRaw;
    const proof: Uint8Array[] = [];
    let position = index;
    for (let depth = 0; depth < levels.length - 1; depth += 1) {
      const level = levels[depth] as Uint8Array[];
      const sibling = level[position % 2 === 0 ? position + 1 : position - 1];
      if (sibling !== undefined) proof.push(sibling);
      position = Math.floor(position / 2);
    }
    return { owner: input.owner, amountRaw: input.amountRaw, index, leafHash: hashes[index] as Uint8Array, proof };
  });
  if (totalRaw > MAX_U64) throw new RangeError('The claim tree total exceeds an unsigned 64-bit integer');
  return { root, rootHex: toHex(root), totalRaw, leaves };
}
