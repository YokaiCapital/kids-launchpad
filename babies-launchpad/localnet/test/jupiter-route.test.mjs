// FIXTURES ONLY: no network; the Jupiter API is a fake fetch.
import test from 'node:test';import assert from 'node:assert/strict';import {Keypair,PublicKey} from '@solana/web3.js';import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {encodeRouteV2,decodeRouteV2Header,localnetParentRoute,fetchJupiterParentRoute,JUPITER_PROGRAM,JUPITER_EVENT_AUTHORITY,ROUTE_V2_DISCRIMINATOR,SWAP_RAYDIUM_CP,encodeRoute,ROUTE_DISCRIMINATOR} from '../jupiter-route.mjs';
import {CPMM} from '../atomic-launch.mjs';
const authority=Keypair.generate().publicKey,parent=Keypair.generate().publicKey;
test('route_v2 header round-trips and the program rules are mirrored',()=>{
 const data=encodeRouteV2({inAmount:1000n,quotedOut:10000n,slippageBps:100,steps:[{swap:SWAP_RAYDIUM_CP,bps:10000,inputIndex:0,outputIndex:1}]});
 assert.ok(data.subarray(0,8).equals(ROUTE_V2_DISCRIMINATOR));assert.equal(data.length,34+5);assert.equal(data[34],46);
 const h=decodeRouteV2Header(data,{amount:1000n,minOut:9900n});assert.equal(h.quotedOut,10000n);assert.equal(h.steps,1);
 assert.throws(()=>decodeRouteV2Header(data,{amount:1000n,minOut:9901n}),/does not clear/);
 assert.throws(()=>decodeRouteV2Header(data,{amount:999n,minOut:1n}),/not the buyback slice/);
 assert.throws(()=>decodeRouteV2Header(encodeRouteV2({inAmount:1n,quotedOut:1n,slippageBps:101,steps:[{swap:1,bps:10000,inputIndex:0,outputIndex:1}]}),{amount:1n,minOut:1n}),/above 1%/);
 assert.throws(()=>decodeRouteV2Header(encodeRouteV2({inAmount:1n,quotedOut:100n,slippageBps:1,platformFeeBps:5,steps:[{swap:1,bps:10000,inputIndex:0,outputIndex:1}]}),{amount:1n,minOut:1n}),/platform fee/);
 assert.throws(()=>decodeRouteV2Header(Buffer.alloc(40),{amount:1n,minOut:1n}),/Not a Jupiter/);
});
test('localnet route: one RaydiumCP step, fee custody as user accounts, 14 remaining accounts starting with the CPMM program',()=>{
 const r=localnetParentRoute({feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_2022_PROGRAM_ID,amount:5n,quotedOut:50n});
 assert.equal(r.remainingAccounts.length,14);assert.ok(r.remainingAccounts[0].pubkey.equals(CPMM));assert.ok(r.remainingAccounts[1].pubkey.equals(authority));
 assert.ok(r.remainingAccounts[5].pubkey.equals(getAssociatedTokenAddressSync(NATIVE_MINT,authority,true)));assert.ok(r.remainingAccounts[6].pubkey.equals(getAssociatedTokenAddressSync(parent,authority,true,TOKEN_2022_PROGRAM_ID)));
 assert.ok(r.remainingAccounts[10].pubkey.equals(TOKEN_2022_PROGRAM_ID));assert.ok(r.remainingAccounts.every(a=>a.isSigner===false));decodeRouteV2Header(r.data,{amount:5n,minOut:49n});
});
function apiFixture({shared=false,platformFee=0,setup=false,head=null,amount='1000',out='10000',setupIx=null,classic=false}={}){
 const source=getAssociatedTokenAddressSync(NATIVE_MINT,authority,true),dest=getAssociatedTokenAddressSync(parent,authority,true,TOKEN_PROGRAM_ID);
 const accounts=(head??[authority,source,dest,NATIVE_MINT,parent,TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,JUPITER_PROGRAM,JUPITER_EVENT_AUTHORITY,JUPITER_PROGRAM,Keypair.generate().publicKey]).map(k=>({pubkey:k.toBase58(),isSigner:k.equals(authority),isWritable:false}));
 const data=classic?encodeRoute({inAmount:BigInt(amount),quotedOut:BigInt(out),slippageBps:100,platformFeeBps:platformFee,steps:[{swap:SWAP_RAYDIUM_CP,bps:10000,inputIndex:0,outputIndex:1},{swap:SWAP_RAYDIUM_CP,bps:10000,inputIndex:1,outputIndex:2}]}):encodeRouteV2({inAmount:BigInt(amount),quotedOut:BigInt(out),slippageBps:100,platformFeeBps:platformFee,steps:[{swap:SWAP_RAYDIUM_CP,bps:10000,inputIndex:0,outputIndex:1}]});
 if(shared)data[0]^=1;
 return async(url,init)=>{if(url.includes('/quote'))return {ok:true,json:async()=>({inputMint:NATIVE_MINT.toBase58(),outputMint:parent.toBase58(),inAmount:amount,outAmount:out})};
  const body=JSON.parse(init.body);assert.equal(body.useSharedAccounts,false);assert.equal(body.wrapAndUnwrapSol,false);assert.equal(body.userPublicKey,authority.toBase58());
  return {ok:true,json:async()=>({swapInstruction:{programId:JUPITER_PROGRAM.toBase58(),accounts,data:data.toString('base64')},setupInstructions:setupIx||(setup?[{}]:[]),cleanupInstruction:null,addressLookupTableAddresses:[Keypair.generate().publicKey.toBase58()]})};};
}
test('Jupiter API route is accepted only when it is a non-shared route_v2 over the fee custody accounts with no extra instructions',async()=>{
 const ok=await fetchJupiterParentRoute({fetchImpl:apiFixture(),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:9000n});
 assert.equal(ok.remainingAccounts.length,1);assert.equal(ok.lookupTables.length,1);assert.equal(ok.quotedOut,10000n);assert.equal(ok.source,'jupiter-api');
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture({shared:true}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:1n}),/Not a Jupiter route/);
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture({platformFee:1}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:1n}),/platform fee/);
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture({setup:true}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:1n}),/not an idempotent token-account create/);
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture({head:[Keypair.generate().publicKey]}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:1n}),/fee custody accounts/);
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture(),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:600000000n,minOut:1n}),/0.5 SOL/);
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture(),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:1n,slippageBps:150}),/above 1%/);
});

test('Jupiter setup: idempotent token-account creates for the fee authority are returned as setup, anything else is refused',async()=>{
 const {getAssociatedTokenAddressSync,NATIVE_MINT}=await import('@solana/spl-token');
 const mk=(mint,owner,data='AQ==',program='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')=>({programId:program,data,accounts:[{pubkey:authority.toBase58()},{pubkey:getAssociatedTokenAddressSync(mint,owner,true).toBase58()},{pubkey:owner.toBase58()},{pubkey:mint.toBase58()},{pubkey:'11111111111111111111111111111111'},{pubkey:TOKEN_PROGRAM_ID.toBase58()}]});
 const ok=await fetchJupiterParentRoute({fetchImpl:apiFixture({setupIx:[mk(NATIVE_MINT,authority),mk(parent,authority)]}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:9000n});
 assert.equal(ok.setup.length,2);assert.ok(ok.setup[0].ata.equals(getAssociatedTokenAddressSync(NATIVE_MINT,authority,true)));
 const other=(await import('@solana/web3.js')).Keypair.generate().publicKey;
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture({setupIx:[mk(parent,other)]}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:1n}),/another owner/);
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture({setupIx:[mk(parent,authority,'AA==')]}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:1n}),/idempotent/);
});

test("Jupiter's classic route (the public API's instruction) is accepted with its head of nine accounts and its header read from the tail",async()=>{
 const source=getAssociatedTokenAddressSync(NATIVE_MINT,authority,true),dest=getAssociatedTokenAddressSync(parent,authority,true,TOKEN_PROGRAM_ID);
 const head=[TOKEN_PROGRAM_ID,authority,source,dest,JUPITER_PROGRAM,parent,JUPITER_PROGRAM,JUPITER_EVENT_AUTHORITY,JUPITER_PROGRAM,Keypair.generate().publicKey];
 const ok=await fetchJupiterParentRoute({fetchImpl:apiFixture({classic:true,head}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:9000n});
 assert.equal(ok.kind,'route');assert.equal(ok.remainingAccounts.length,1);assert.ok(ok.data.subarray(0,8).equals(ROUTE_DISCRIMINATOR));
 const h=decodeRouteV2Header(ok.data,{amount:1000n,minOut:9000n});assert.equal(h.kind,'route');assert.equal(h.inAmount,1000n);assert.equal(h.quotedOut,10000n);assert.equal(h.slippageBps,100);assert.equal(h.platformFeeBps,0);assert.equal(h.steps,2);
 // A classic route whose optional destination account is not the None placeholder is refused (it could redirect the output).
 const bad=[...head];bad[4]=Keypair.generate().publicKey;
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture({classic:true,head:bad}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:9000n}),/fee custody accounts/);
 await assert.rejects(fetchJupiterParentRoute({fetchImpl:apiFixture({classic:true,head,platformFee:1}),feeAuthority:authority,parentMint:parent,parentProgram:TOKEN_PROGRAM_ID,amount:1000n,minOut:1n}),/platform fee/);
 // The live tail seen on 24 Sep 2026 decodes to the same numbers the program reads.
 const live=Buffer.concat([ROUTE_DISCRIMINATOR,Buffer.from([1,0,0,0,46,0,100,0,1]),Buffer.from('00e1f50500000000155ab60300000000640000','hex')]);
 const lh=decodeRouteV2Header(live,{amount:100000000n,minOut:1n});assert.equal(lh.inAmount,100000000n);assert.equal(lh.quotedOut,62282261n);assert.equal(lh.slippageBps,100);assert.equal(lh.platformFeeBps,0);
});
