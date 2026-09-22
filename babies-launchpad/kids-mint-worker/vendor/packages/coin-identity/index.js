/** Official mainnet identity only; not liquidity or execution authorization. */
export const KIDS_TOKEN = Object.freeze({
  mint: "3URpNcV9wAPjwMAyuBsPjwwkGN9wFJuwcRs3RMbdpair", symbol: "KIDS", decimals: 6,
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", cluster: "mainnet-beta",
});

/** Legacy automatic identity. Retained for exact historical packet recovery. */
export function deriveCoinName(symbol, rewardSymbol) {
  function ticker(value, uppercase = false) {
    if (typeof value !== "string") throw new TypeError("A coin ticker must be text.");
    const normalized = value.trim();
    if (!/^[A-Za-z0-9]{1,13}$/.test(normalized)) throw new RangeError("Tickers must contain 1–13 letters or numbers.");
    return uppercase ? normalized.toUpperCase() : normalized;
  }
  return `${ticker(symbol)}/${ticker(rewardSymbol, true)}`;
}

/** Current automatic name; reward symbol comes from the trusted mint resolver. */
export function deriveKidsCoinName(rewardSymbol) {
  // Reuse the bounded ASCII symbol validation, without adding a ticker to name.
  return `${deriveCoinName("KIDS", rewardSymbol).slice(6)} Kids`;
}

/** A creator-chosen display name (owner, 11 Sep 2026: "let users set ticker +
 * name, like the Direct lane"): the Direct lane's rule, `packages/asset-pools`
 * plan.ts — trimmed, 1–32 UTF-8 bytes, no control characters. */
export function isCreatorCoinName(name) {
  return typeof name === "string" && name.length > 0 && name === name.trim()
    && new TextEncoder().encode(name).length <= 32 && !/[\u0000-\u001f\u007f]/.test(name);
}

/** Rebuild the intent name: the current automatic identity when asked for it,
 * a creator-chosen name verbatim, and otherwise the SDK's legacy normalization
 * (historical packet recovery). */
export function deriveLaunchIntentName(symbol, rewardSymbol, requestedName) {
  const legacy = deriveCoinName(symbol, rewardSymbol);
  const current = deriveKidsCoinName(rewardSymbol);
  if (requestedName === current) return current;
  return isCreatorCoinName(requestedName) ? requestedName : legacy;
}

export function isCanonicalCoinName(name, symbol, rewardSymbol) {
  try { return name === deriveCoinName(symbol, rewardSymbol) || name === deriveKidsCoinName(rewardSymbol); }
  catch { return false; }
}

/** Decode only supported automatic names for independent packet reconstruction. */
export function rewardSymbolFromCoinName(name, symbol) {
  if (typeof name !== "string") throw new TypeError("Coin name must be text.");
  const reward = /^[A-Z0-9]{1,13} Kids$/.test(name) ? name.slice(0, -6) : name.split("/")[1];
  if (!isCanonicalCoinName(name, symbol, reward)) throw new RangeError("Coin name differs from the automatic pair identity.");
  return reward;
}
