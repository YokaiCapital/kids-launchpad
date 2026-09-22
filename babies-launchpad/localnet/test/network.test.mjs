import test from 'node:test';import assert from 'node:assert/strict';import {networkProfile,explorerLink,scopeFor,MAINNET_GENESIS} from '../network.mjs';
test('localnet is the default and keeps the loopback label used by existing manifests',()=>{const p=networkProfile({});assert.equal(p.network,'localnet');assert.equal(p.rpcUrl,'http://127.0.0.1:19099');assert.equal(p.rpcLabel,p.rpcUrl);assert.equal(p.explorerUrl,null);assert.equal(scopeFor(p),'active-localnet');assert.equal(scopeFor(p,false),'localnet-rehearsal');});
test('mainnet needs a server-side https Helius URL and never exposes it as the label',()=>{
 assert.throws(()=>networkProfile({KIDS_NETWORK:'mainnet'}),/KIDS_HELIUS_RPC_URL/);assert.throws(()=>networkProfile({KIDS_NETWORK:'mainnet',KIDS_HELIUS_RPC_URL:'http://x'}),/https/);
 const p=networkProfile({KIDS_NETWORK:'mainnet',KIDS_HELIUS_RPC_URL:'https://mainnet.helius-rpc.com/?api-key=SECRET'});
 assert.equal(p.rpcLabel,'mainnet-helius');assert.equal(p.genesisHash,MAINNET_GENESIS);assert.ok(!JSON.stringify({label:p.rpcLabel,scope:scopeFor(p)}).includes('SECRET'));
 assert.equal(explorerLink(p,'tx','sig'),'https://solscan.io/tx/sig');assert.equal(explorerLink(networkProfile({KIDS_NETWORK:'devnet',KIDS_HELIUS_RPC_URL:'https://d'}),'account','A'),'https://solscan.io/account/A?cluster=devnet');
 assert.throws(()=>networkProfile({KIDS_NETWORK:'testnet'}),/KIDS_NETWORK/);
});
