import { PublicKey } from "@solana/web3.js";
/** Pump custody hop: product economics are applied later by the reward router. */
export const PUMP_FEE_COLLECTOR_BPS = 10_000;
/** Wrapped SOL is used by Pump fee instructions even for SOL-paired coins. */
export const WRAPPED_SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Pump createV2 launch mints are owned by Token-2022. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_FEES_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/** Pump "Custom Pairs" catalogue account (93 quote entries, 9 Sep 2026). It is
 * the pricing source for a non-SOL curve and a constant account meta on a
 * custom-pair `create_v2`. Pump can edit it at will: pin per-quote entries,
 * never this account's hash. */
export const PUMP_QUOTE_CONTROL = new PublicKey("6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP");
/** Flat "exotic" bonding-curve fee config for non-SOL/USDC quotes: 0 lp / 95 bps
 * protocol / 30 bps creator. No market-cap tiers, unlike the SOL curve. */
export const PUMP_EXOTIC_BONDING_CURVE_FEE_CONFIG = new PublicKey("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
/** Flat "exotic" PumpSwap AMM fee config: 20 bps lp / 5 bps protocol / 5 bps creator. */
export const PUMP_EXOTIC_AMM_FEE_CONFIG = new PublicKey("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
/** USDC is a whitelisted quote in Pump `Global`, not a `QuoteControl` entry. */
export const PUMP_USDC_QUOTE_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export function pumpFeeSharingAddress(mint) {
    return PublicKey.findProgramAddressSync([
        Buffer.from("sharing-config"), mint.toBuffer(),
    ], PUMP_FEES_PROGRAM_ID)[0];
}
