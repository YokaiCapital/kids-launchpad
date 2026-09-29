// The smallest piece of Solana the vault needs: base58, an Ed25519 keypair on
// top of node:crypto, one legacy SystemProgram transfer, and JSON-RPC over
// fetch. Nothing else.
//
// Why not @solana/web3.js: it does resolve from here today, but only because npm
// hoists it out of the workspaces that declare it into the root node_modules —
// it is not a dependency of this repo's root package, so an install that
// reshuffles hoisting takes it away, and `scripts/admin` is documented as
// dependency-free. The deciding reason is narrower than that: this module runs
// inside the one process that ever holds a decrypted secret key, and the fewer
// lines of third-party code in that process the better. Ed25519, base58 and a
// 200-byte transfer message are small enough to own.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as signBytes, verify as verifyBytes } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((character, position) => [character, position]));

// RFC 8410 wrappers. An Ed25519 private key is a 32-byte seed inside a fixed
// PKCS8 prelude, and a public key is 32 bytes inside a fixed SPKI prelude, so
// the conversion both ways is a slice.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const NATIVE_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

/* ------------------------------------------------------------------ base58 */

export function encodeBase58(bytes) {
  const input = Buffer.from(bytes);
  if (!input.length) return "";
  // Big-endian base conversion by repeated division. The digit array starts
  // empty, not [0]: a seeded zero digit would survive an all-zero input and
  // print a thirty-third "1" for the System program's address.
  const digits = [];
  for (const byte of input) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let leading = 0;
  while (leading < input.length && input[leading] === 0) leading += 1;
  return "1".repeat(leading) + digits.reverse().map((digit) => ALPHABET[digit]).join("");
}

export function decodeBase58(text) {
  if (typeof text !== "string" || !text.length) throw new Error("not base58: empty");
  // Empty for the same reason encodeBase58's digits are: a seeded zero byte
  // would make every 32-byte key decode to 33 bytes.
  const bytes = [];
  for (const character of text) {
    const value = INDEX.get(character);
    if (value === undefined) throw new Error(`not base58: ${JSON.stringify(character)} is not in the alphabet`);
    let carry = value;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let leading = 0;
  while (leading < text.length && text[leading] === "1") leading += 1;
  return Buffer.from([...new Array(leading).fill(0), ...bytes.reverse()]);
}

/** True when the text is a base58 address of exactly 32 bytes. */
export function isAddress(text) {
  if (typeof text !== "string" || text.length < 32 || text.length > 44) return false;
  try { return decodeBase58(text).length === 32; } catch { return false; }
}

/* ----------------------------------------------------------------- ed25519 */

/** A private KeyObject from the 32-byte seed. The DER copy is wiped after use. */
export function privateKeyFromSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const der = Buffer.concat([PKCS8_PREFIX, seed]);
  try { return createPrivateKey({ key: der, format: "der", type: "pkcs8" }); } finally { der.fill(0); }
}

export function publicKeyBytesFromSeed(seed) {
  const key = privateKeyFromSeed(seed);
  return Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" })).subarray(SPKI_PREFIX.length);
}

/** Solana's "secret key" is seed ‖ public key: 64 bytes, the form wallets export. */
export function secretKeyFromSeed(seed) {
  return Buffer.concat([seed, publicKeyBytesFromSeed(seed)]);
}

/** A fresh keypair. The seed comes from the platform CSPRNG by way of node:crypto. */
export function generateKeypair() {
  // generateKeyPairSync goes through the same OpenSSL generator a real wallet
  // uses, rather than treating 32 random bytes as a key by assertion.
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const seed = Buffer.from(der.subarray(PKCS8_PREFIX.length));
  der.fill(0);
  return { seed, secretKey: secretKeyFromSeed(seed), address: encodeBase58(publicKeyBytesFromSeed(seed)) };
}

/**
 * Reads a secret key the owner pasted: a JSON array of 64 bytes, or base58 of
 * the same 64 bytes. Refuses anything whose second half is not the public key
 * the first half derives — that is the check that catches a truncated paste, a
 * 32-byte seed pretending to be a keypair, and two halves from different keys.
 */
export function parseSecretKey(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Paste a secret key as a JSON array of 64 numbers or as base58.");
  const text = input.trim();
  let bytes;
  if (text.startsWith("[")) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("That looks like a JSON array but it does not parse."); }
    if (!Array.isArray(parsed)) throw new Error("A JSON secret key is an array of numbers.");
    if (parsed.length !== 64) throw new Error(`A Solana secret key is 64 bytes; this array has ${parsed.length}.`);
    if (!parsed.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) throw new Error("Every entry must be a whole number from 0 to 255.");
    bytes = Buffer.from(parsed);
  } else {
    try { bytes = decodeBase58(text); } catch { throw new Error("That is neither a JSON array of 64 numbers nor base58."); }
    if (bytes.length !== 64) throw new Error(`A base58 secret key decodes to 64 bytes; this one is ${bytes.length}.`);
  }
  const seed = Buffer.from(bytes.subarray(0, 32));
  const claimed = Buffer.from(bytes.subarray(32));
  bytes.fill(0);
  const derived = publicKeyBytesFromSeed(seed);
  if (!derived.equals(claimed)) {
    seed.fill(0);
    throw new Error("The last 32 bytes are not the public key of the first 32. This is not a whole keypair.");
  }
  return { seed, address: encodeBase58(derived) };
}

export function signWithSeed(seed, message) {
  return signBytes(null, message, privateKeyFromSeed(seed));
}

export function verifySignature(address, message, signature) {
  const spki = Buffer.concat([SPKI_PREFIX, decodeBase58(address)]);
  return verifyBytes(null, message, createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
}

/* ------------------------------------------------------------ transaction */

/** compact-u16, the length prefix Solana uses in front of every vector. */
export function shortVec(length) {
  const out = [];
  let rest = length;
  for (;;) {
    const part = rest & 0x7f;
    rest >>>= 7;
    if (rest === 0) { out.push(part); break; }
    out.push(part | 0x80);
  }
  return Buffer.from(out);
}

function readShortVec(bytes, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = bytes[cursor];
    if (byte === undefined) throw new Error("truncated compact-u16");
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new Error("compact-u16 too long");
  }
  return { value, offset: cursor };
}

/**
 * One legacy message carrying one SystemProgram transfer. The account order is
 * the order the runtime requires: writable signer, writable non-signer, then the
 * readonly program.
 */
export function buildTransferMessage({ from, to, lamports, recentBlockhash }) {
  if (!isAddress(from) || !isAddress(to)) throw new Error("from and to must be base58 addresses");
  if (from === to) throw new Error("from and to are the same address");
  const amount = BigInt(lamports);
  if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) throw new Error("lamports out of range");
  const blockhash = decodeBase58(recentBlockhash);
  if (blockhash.length !== 32) throw new Error("recentBlockhash must decode to 32 bytes");

  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);            // SystemInstruction::Transfer
  data.writeBigUInt64LE(amount, 4);

  return Buffer.concat([
    Buffer.from([1, 0, 1]),            // 1 signature, 0 readonly signed, 1 readonly unsigned
    shortVec(3), decodeBase58(from), decodeBase58(to), decodeBase58(SYSTEM_PROGRAM_ID),
    blockhash,
    shortVec(1),
    Buffer.from([2]), shortVec(2), Buffer.from([0, 1]), shortVec(data.length), data,
  ]);
}

/**
 * One legacy message closing one SPL token account (CloseAccount, data [9]):
 * the account's lamports, rent and any wrapped SOL alike, return to its owner,
 * who signs. Used for the protocol wallet's wrapped-SOL account, whose mere
 * existence pauses Pump launches (keeper rule, 11 Sep 2026).
 */
export function buildCloseTokenAccountMessage({ owner, account, recentBlockhash }) {
  if (!isAddress(owner) || !isAddress(account)) throw new Error("owner and account must be base58 addresses");
  if (owner === account) throw new Error("owner and account are the same address");
  const blockhash = decodeBase58(recentBlockhash);
  if (blockhash.length !== 32) throw new Error("recentBlockhash must decode to 32 bytes");
  return Buffer.concat([
    Buffer.from([1, 0, 1]),            // 1 signature, 0 readonly signed, 1 readonly unsigned
    shortVec(3), decodeBase58(owner), decodeBase58(account), decodeBase58(TOKEN_PROGRAM_ID),
    blockhash,
    shortVec(1),
    Buffer.from([2]), shortVec(3), Buffer.from([1, 0, 0]), shortVec(1), Buffer.from([9]),   // account, destination = owner, authority = owner
  ]);
}

/** message ‖ its one signature, or a zeroed signature for a sigVerify:false simulation. */
export function serializeTransaction(message, signature) {
  const slot = signature ?? Buffer.alloc(64);
  if (slot.length !== 64) throw new Error("an Ed25519 signature is 64 bytes");
  return Buffer.concat([shortVec(1), slot, message]);
}

/**
 * Reads back what buildTransferMessage wrote. The tests use it to assert that
 * what was signed is the transfer that was quoted, rather than trusting the
 * builder to agree with itself.
 */
export function decodeTransferMessage(bytes) {
  const message = Buffer.from(bytes);
  const [signatures, readonlySigned, readonlyUnsigned] = message;
  let cursor = 3;
  const keys = readShortVec(message, cursor);
  cursor = keys.offset;
  const accounts = [];
  for (let index = 0; index < keys.value; index += 1) {
    accounts.push(encodeBase58(message.subarray(cursor, cursor + 32)));
    cursor += 32;
  }
  const recentBlockhash = encodeBase58(message.subarray(cursor, cursor + 32));
  cursor += 32;
  const count = readShortVec(message, cursor);
  cursor = count.offset;
  const instructions = [];
  for (let index = 0; index < count.value; index += 1) {
    const programIdIndex = message[cursor];
    cursor += 1;
    const used = readShortVec(message, cursor);
    cursor = used.offset;
    const indices = [...message.subarray(cursor, cursor + used.value)];
    cursor += used.value;
    const length = readShortVec(message, cursor);
    cursor = length.offset;
    const data = Buffer.from(message.subarray(cursor, cursor + length.value));
    cursor += length.value;
    instructions.push({ programId: accounts[programIdIndex], accounts: indices.map((position) => accounts[position]), data });
  }
  if (cursor !== message.length) throw new Error(`message has ${message.length - cursor} trailing bytes`);
  const [only] = instructions;
  const transfer = instructions.length === 1 && only.programId === SYSTEM_PROGRAM_ID
    && only.data.length === 12 && only.data.readUInt32LE(0) === 2
    ? { from: only.accounts[0], to: only.accounts[1], lamports: only.data.readBigUInt64LE(4) } : null;
  return { header: { signatures, readonlySigned, readonlyUnsigned }, accounts, recentBlockhash, instructions, transfer };
}

/** Splits a serialized transaction back into its signature and message. */
export function splitTransaction(bytes) {
  const buffer = Buffer.from(bytes);
  const count = readShortVec(buffer, 0);
  if (count.value !== 1) throw new Error(`expected one signature, found ${count.value}`);
  return { signature: buffer.subarray(count.offset, count.offset + 64), message: buffer.subarray(count.offset + 64) };
}

/* -------------------------------------------------------------------- rpc */

export class RpcError extends Error {
  constructor(method, detail, code) {
    super(detail);
    this.name = "RpcError";
    this.method = method;
    this.code = code ?? null;
  }
}

/** One JSON-RPC call. No retries: the caller decides what a failure means. */
export async function rpc(url, method, params = [], { timeoutMs = 12_000, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new RpcError(method, timedOut
      ? `${method} timed out after ${timeoutMs / 1_000} s.`
      : `${method} could not reach the RPC (${error?.cause?.code ?? error?.code ?? "connection failed"}).`);
  }
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new RpcError(method, `The RPC answered ${response.status} with something that is not JSON.`); }
  if (payload?.error) throw new RpcError(method, payload.error.message ?? `${method} was refused.`, payload.error.code);
  if (!response.ok) throw new RpcError(method, `The RPC answered ${response.status}.`);
  return payload?.result;
}

export const randomSeed = () => randomBytes(32);
