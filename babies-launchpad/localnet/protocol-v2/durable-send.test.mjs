import test from 'node:test';
import {openRegistry} from '../registry/registry.mjs';
import {operatorPacketCases} from '../test/helpers/operator-packet-cases.mjs';
test('durable operator packets: crash boundaries, fencing and immutable identity',async t=>{
 const registry=openRegistry();registry.migrate();
 try{await operatorPacketCases(t,[registry.operatorPackets]);}finally{registry.close();}
});

test('job reconciliation respects the chain adapter finality policy',async()=>{
 const assert=(await import('node:assert/strict')).default;
 const {Keypair}=await import('@solana/web3.js');
 const {createChainAdapter}=await import('./chain-adapter.mjs');
 let finality='confirmed';const connection={getSignatureStatuses:async()=>({value:[{confirmationStatus:finality,err:null,slot:100}]})};
 const shared={connection,programId:Keypair.generate().publicKey,genesisHash:Keypair.generate().publicKey,signer:{publicKey:Keypair.generate().publicKey,sign(){throw Error('Read-only');}}};
 const strict=createChainAdapter({...shared,commitment:'finalized'}),normal=createChainAdapter(shared);
 assert.equal((await strict.signatureStatus('synthetic')).status,'unresolved');
 assert.equal((await normal.signatureStatus('synthetic')).status,'confirmed');
 finality='finalized';assert.equal((await strict.signatureStatus('synthetic')).status,'confirmed');
});
