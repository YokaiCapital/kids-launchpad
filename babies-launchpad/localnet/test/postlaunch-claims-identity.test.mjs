// Regression: a signed-in real wallet on mainnet got HTTP 400 "Wallet missing" from /api/account/postlaunch because the
// claims reader consulted the localnet fixture identities (alice, bob) whose files do not exist on a mainnet volume.
import test from 'node:test';import assert from 'node:assert/strict';
import {localClaimIdentity} from '../postlaunch-claims.mjs';
const mainnet={network:'mainnet'},localnet={network:'localnet'};
test('real networks never consult the fixture identities',()=>{
 assert.equal(localClaimIdentity('AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE',mainnet),null);
 assert.equal(localClaimIdentity('AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE',{network:'devnet'}),null);
});
test('a wallet that is not a fixture identity is external, even on localnet',()=>{
 // Either the fixture files exist (a developer ledger) and the address does not match, or they are missing; both mean null.
 assert.equal(localClaimIdentity('AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE',localnet),null);
});
