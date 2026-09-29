// Synthetic local wallet traffic through the real persisted public trade service.
// These packets are never operator-signed. Resume uses the same request/packet.
import assert from 'node:assert/strict';
import {runRehearsalBatch} from './rehearsal-work.mjs';
import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';import {join} from 'node:path';
import {createHash} from 'node:crypto';import {Keypair} from '@solana/web3.js';
import {createPublicWalletService} from '../protocol-v2/public-wallet.mjs';
import {createPublicTradeService} from '../protocol-v3/public-trade.mjs';
import {decodeApprovedTrade} from '../../interaction-review/src/trade-signing.mjs';
import {createAdmissionGuard} from '../jobs/admission.mjs';import {waitForRpcAdmission} from '../rpc-transport.mjs';
import {FLEET_REHEARSAL_GENESIS} from '../signer/rehearsal-capacity.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function capacity(action,signal){const until=Date.now()+30000;for(;;){signal?.throwIfAborted();try{return await action();}catch(e){if(e?.code!=='CAPACITY_WAIT'||Date.now()>=until)throw e;await pause(Math.max(20,Math.min(1500,Number(e.retryAfterMs)||100)));}}}
const bounded=(items,fn)=>runRehearsalBatch(items,4,fn);
export async function tradeFleet({registry,connection,genesisHash,programId,records,wallet,wallets=[wallet],directory,log=()=>{},signal}){
 if(connection.rpcEndpoint!=='http://127.0.0.1:19499'||genesisHash!==FLEET_REHEARSAL_GENESIS||records.length<1||records.length>100)throw Error('Synthetic traffic requires the pinned isolated fleet');assert.equal(await connection.getGenesisHash(),genesisHash);
 const capacityWait=action=>capacity(action,signal);
 signal?.throwIfAborted();
 const fallbackOwner=String(wallet.publicKey),keyring=new Map([wallet,...wallets].map(k=>[String(k.publicKey),k]));
 assert.ok(wallets.length>=1&&wallets.length<=100);
 const requestKey=(campaign,side)=>'fleet:'+createHash('sha256').update(directory+':'+campaign+':'+side).digest('hex');
 const planFile=join(directory,'background-trade-plan.json');
 if(!existsSync(planFile)){
  const rows=records.map((r,i)=>{const wraps=[Keypair.generate(),Keypair.generate()];try{return {campaign:r.campaign,mint:r.mint,owner:String(wallets[i%wallets.length].publicKey),wraps:wraps.map(k=>Array.from(k.secretKey))};}finally{for(const k of wraps)k.secretKey.fill(0);}});
  writeFileSync(planFile,JSON.stringify(rows),{mode:0o600,flag:'wx'});
 }
 const plans=JSON.parse(readFileSync(planFile));assert.equal(plans.length,records.length);plans.forEach((p,i)=>{assert.equal(p.campaign,records[i].campaign);assert.equal(p.mint,records[i].mint);});
 // Older fixtures used one trader. Preserve every existing packet's owner; only
 // untouched rows use the funded multi-wallet fixture, without widening limits.
 if(plans.some(p=>!p.owner)){for(const [i,p] of plans.entries())if(!p.owner){const prior=await registry.walletPackets.find(fallbackOwner,[genesisHash,programId,p.campaign].join(':'),requestKey(p.campaign,'buy'));p.owner=prior?fallbackOwner:String(wallets[i%wallets.length].publicKey);}const temporary=planFile+'.tmp';writeFileSync(temporary,JSON.stringify(plans),{mode:0o600});renameSync(temporary,planFile);}
 for(const p of plans)assert.ok(keyring.has(p.owner),'Stored synthetic owner key unavailable');
 const policy={ratePerSecond:30,burst:30,lanes:{interactive:{ratePerSecond:30,burst:30}}},guard=createAdmissionGuard({registry,resource:'fleet-interactive',lane:'interactive',policy});
 const admit=({cost=1}={})=>waitForRpcAdmission(()=>guard({cost}),{waitMs:1000});
 const walletService=createPublicWalletService({registry,connection,genesisHash,programIds:[programId],programVersion:3,enabled:false});
 const service=createPublicTradeService({registry,connection,genesisHash,programId,walletService,enabled:true,admit}),results=[[],[]];
 const roomChecks=new Map();
 async function room(owner){
  if(roomChecks.has(owner))return roomChecks.get(owner);
  const check=(async()=>{const until=Date.now()+180000;for(;;){
   signal?.throwIfAborted();const pending=await registry.walletPackets.pending(owner);if(pending.length<12)return;
   // Four in-flight fixture callers plus this watermark stay below the real
   // sixteen-packet wallet limit. Reconcile; never relax it for a load test.
   for(const p of pending){if(p.prepared.action!=='trade'||!plans.some(x=>x.owner===owner&&x.campaign===p.prepared.campaign))throw Error('Unrelated pending wallet action needs recovery');await capacityWait(()=>service.status(owner,{intentId:p.id}));}
   if(Date.now()>until)throw Error('Synthetic wallet backlog remains unresolved');await pause(250);
  }})();roomChecks.set(owner,check);try{await check;}finally{roomChecks.delete(owner);}
 }

 try{
  for(const [phase,side] of ['buy','sell'].entries()){
   await bounded(plans,async(p,i)=>{
    signal?.throwIfAborted();const owner=p.owner,wallet=keyring.get(owner);const wrap=Keypair.fromSecretKey(Uint8Array.from(p.wraps[phase]));try{
     const requestId=requestKey(p.campaign,side);
     const input={campaignId:[genesisHash,programId,p.campaign].join(':'),requestId,side,amountRaw:phase===0?'50000000':results[0][i].minOutputRaw,slippageBps:1000,wrappedAccount:String(wrap.publicKey)};
     await room(owner);const quote=await capacityWait(()=>service.prepare(owner,input));let result;
     if(quote.signature)result=await capacityWait(()=>service.status(owner,{intentId:quote.intentId}));
     else{const tx=decodeApprovedTrade(Buffer.from(quote.unsignedTransactionBase64,'base64'),quote,quote);tx.sign([wallet,wrap]);result=await capacityWait(()=>service.submit(owner,{intentId:quote.intentId,signedTransactionBase64:Buffer.from(tx.serialize()).toString('base64')}));}
     assert.ok(result.signature,'Trade must retain its signature');results[phase][i]={...result,minOutputRaw:quote.minOutputRaw,wrappedAccount:input.wrappedAccount};
    }finally{wrap.secretKey.fill(0);}
   });
   const until=Date.now()+180000;
   for(;;){
    await bounded(results[phase],async(r,i)=>{if(r.status!=='finalized'){const next=await capacityWait(()=>service.status(plans[i].owner,{intentId:r.intentId}));results[phase][i]={...r,...next};assert.ok(!['failed','expired','cancelled'].includes(next.status),'Synthetic trade did not execute; retained signature must be investigated');}});
    if(results[phase].every(r=>r.status==='finalized'))break;if(Date.now()>until)throw Error('Synthetic trade finality unresolved; original packets retained');await pause(2000);
   }
   log({event:'background-trades-finalized',side,count:results[phase].length});
  }
  const report={campaigns:plans.length,buys:results[0].length,sells:results[1].length,buyLamportsPerPool:'50000000',allFinalized:true,signatures:results.map(rows=>rows.map(r=>r.signature))};
  writeFileSync(join(directory,'background-trades-completed.json'),JSON.stringify(report,null,2),{mode:0o600});return report;
 }finally{for(const p of plans)for(const bytes of p.wraps)bytes.fill(0);}
}
