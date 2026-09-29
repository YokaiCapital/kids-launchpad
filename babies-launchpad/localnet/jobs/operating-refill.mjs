// Option 1, second part (owner decision 27 September 2026): a live coin's own treasury fee share refills its campaign's
// operating budget up to the floor. Entitlements come only from finalized on-chain fee-state counters (growth of
// treasuryPaid), never from job results, and they become budget only when a treasury-signed transfer to the payer that
// carries the entitlement memo is finalized. The treasury key never lives in a worker: the transfer is prepared here
// and signed by the treasury's owner, then credited from the finalized transaction.
import {PublicKey} from '@solana/web3.js';
import {randomUUID} from 'node:crypto';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
import {createOperatingLedger} from '../creation/operating-ledger.mjs';
import {feeStateAddress,decodeFeeState} from '../protocol-v2/client.mjs';
export const OPERATING_REFILL_CLASS='operating-refill';
const key=/^[A-Za-z0-9_.:-]{1,128}$/,DECIMAL=/^(0|[1-9][0-9]{0,19})$/,MEMO_PROGRAM='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const address=x=>{const k=new PublicKey(x).toBase58();if(k!==x)throw Error('Invalid refill address');return k;};
const amount=x=>{if(typeof x!=='string'||!DECIMAL.test(x))throw Error('Invalid refill amount');return BigInt(x);};
/** Pure entitlement rule: the refill share of the treasury payout growth, capped by the room left under the floor. */
export function refillEntitlement({treasuryPaidNow,treasuryPaidAccounted,refillBps,floorLamports,availableLamports,dueLamports}){
 for(const v of [treasuryPaidNow,treasuryPaidAccounted,floorLamports,availableLamports,dueLamports])if(typeof v!=='bigint'||v<0n)throw Error('Refill inputs must be non-negative bigints');
 if(!Number.isInteger(refillBps)||refillBps<0||refillBps>10000)throw Error('refillBps must be 0..10000');
 if(treasuryPaidNow<treasuryPaidAccounted)throw Object.assign(Error('Treasury payout counter moved backwards'),{code:'REFILL_EVIDENCE_MISMATCH'});
 const growth=treasuryPaidNow-treasuryPaidAccounted,share=growth*BigInt(refillBps)/10000n;
 const room=floorLamports-availableLamports-dueLamports,add=room>0n?(share<room?share:room):0n;
 return {growthLamports:growth,shareLamports:share,addLamports:add,accountedNow:treasuryPaidNow};
}
/** One funding identity: the entitlement set plus a fresh nonce, so the same set prepared twice never shares a memo. */
export function refillMemo({genesisHash,programId,payer,policy,treasury,entitlements,nonce}){
 if(typeof nonce!=='string'||!nonce)throw Error('Refill funding nonce required');
 return 'KIDS refill:'+canonicalHash({genesisHash,programId,payer,policy,treasury,nonce,entitlements:[...entitlements].map(e=>({campaign:e.campaign,lamports:String(e.lamports)})).sort((a,b)=>a.campaign.localeCompare(b.campaign))});
}
/** Recurring accounting job per campaign (accounting lane): reads the finalized fee state and records what the coin's
 * treasury share entitles the campaign to. No signing, no RPC writes, no credit. */
/** The payload binding every accounting job carries: the lane leases only rows whose binding names its payer and policy. */
export function refillJobBinding({genesisHash,programId,campaign,payer,policy}){
 if(!key.test(policy??''))throw Error('Invalid refill policy');
 return {genesisHash:address(genesisHash),programId:address(programId),campaign:address(campaign),payer:address(payer),policy};
}
export function operatingRefillHandler({registry,connection,genesisHash,programId,payer,policy,refillBps,floorLamports,intervalMs=300000,now=Date.now}){
 if(registry?.driver!=='postgres'||typeof connection?.getAccountInfo!=='function')throw Error('operating-refill needs the shared registry and a ledger connection');
 const pinned={genesisHash:address(genesisHash),programId:address(programId),payer:address(payer),policy};
 if(!key.test(policy??'')||!Number.isInteger(refillBps)||refillBps<0||refillBps>10000||amount(String(floorLamports))<0n||!Number.isInteger(intervalMs)||intervalMs<60000||intervalMs>86400000)throw Error('Invalid operating refill policy');
 const floor=BigInt(floorLamports),disabled=async()=>{throw Error('Refill accounting never credits or reconciles by itself');};
 let ledger=null;const view=()=>ledger??=createOperatingLedger({registry,verifyFunding:disabled,verifyOutcome:disabled});
 const select='SELECT * FROM operating_refills WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? FOR UPDATE';
 return {async run(job,ctx){
  const id=ctx.campaign,match=/^operating-refill:(0|[1-9][0-9]{0,14})$/.exec(job.operationKey??'');
  if(!match||job.jobClass!==OPERATING_REFILL_CLASS||id.genesisHash!==pinned.genesisHash||id.programId!==pinned.programId)return {outcome:'failed-permanent',category:'refill-scope',reason:'Refill job is outside this worker policy'};
  // The job's own binding must name this worker's payer and policy (the lane's lease filter selects on it; the handler
  // re-checks so a mis-scoped row can never be accounted under another policy).
  const b=job.payload?.binding;
  if(!b||b.genesisHash!==id.genesisHash||b.programId!==id.programId||b.campaign!==id.campaign||b.payer!==pinned.payer||b.policy!==pinned.policy)return {outcome:'failed-permanent',category:'refill-scope',reason:'Refill job binding differs from this worker policy'};
  const info=await connection.getAccountInfo(feeStateAddress(pinned.programId,id.campaign),'finalized');
  if(!info)return {outcome:'yield',category:'awaiting-fee-state',delayMs:intervalMs};
  const fees=decodeFeeState(info.data,id.campaign),balance=await view().balance({...id,payer:pinned.payer,policy:pinned.policy});
  let accounted;
  try{
   accounted=await registry.transaction(async()=>{
    const row=(await registry.query(select,[id.genesisHash,id.programId,id.campaign,pinned.payer])).rows[0];
    if(row&&row.policy!==pinned.policy)throw Object.assign(Error('Refill row follows another policy'),{code:'REFILL_EVIDENCE_MISMATCH'});
    const prior={accounted:amount(row?.treasury_paid_accounted??'0'),due:amount(row?.due_lamports??'0'),funded:amount(row?.funded_lamports??'0')};
    const e=refillEntitlement({treasuryPaidNow:fees.treasuryPaid,treasuryPaidAccounted:prior.accounted,refillBps,floorLamports:floor,availableLamports:BigInt(balance.availableLamports),dueLamports:prior.due});
    const at=new Date(now()).toISOString(),due=prior.due+e.addLamports;
    if(row)await registry.query('UPDATE operating_refills SET treasury_paid_accounted=?,due_lamports=?,updated_at=? WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=?',[String(e.accountedNow),String(due),at,id.genesisHash,id.programId,id.campaign,pinned.payer]);
    else await registry.query('INSERT INTO operating_refills(genesis_hash,program_id,campaign,payer,policy,treasury_paid_accounted,due_lamports,funded_lamports,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[id.genesisHash,id.programId,id.campaign,pinned.payer,pinned.policy,String(e.accountedNow),String(due),'0',at,at]);
    return {treasuryPaidLamports:String(fees.treasuryPaid),growthLamports:String(e.growthLamports),addedLamports:String(e.addLamports),dueLamports:String(due),fundedLamports:String(prior.funded)};
   },{lockKey:'refill:'+[id.genesisHash,id.programId,id.campaign,pinned.payer].join(':')});
  }catch(error){
   if(error?.code==='STALE_LEASE')throw error;
   if(error?.code==='REFILL_EVIDENCE_MISMATCH')return {outcome:'failed-permanent',category:'refill-evidence-mismatch',reason:String(error.message).slice(0,200)};
   throw error;
  }
  const next=OPERATING_REFILL_CLASS+':'+(BigInt(match[1])+1n);
  await ctx.enqueue({operationKey:next,jobClass:OPERATING_REFILL_CLASS,payload:{binding:refillJobBinding({...id,payer:pinned.payer,policy:pinned.policy}),predecessorJobId:ctx.jobId},notBefore:new Date(ctx.now()+intervalMs).toISOString()});
  return {outcome:'done',category:'refill-accounted',...accounted,next};
 }};
}
/** Freezes every due entitlement of one payer into one funding the treasury's owner can pay with a single transfer. */
export async function prepareRefillFunding({registry,genesisHash,programId,payer,policy,treasury,now=Date.now}){
 const scope={genesisHash:address(genesisHash),programId:address(programId),payer:address(payer),policy,treasury:address(treasury)};
 if(!key.test(policy??''))throw Error('Invalid refill policy');
 if(scope.treasury===scope.payer)throw Error('Refill funding needs a treasury distinct from the payer; with one key the treasury share is already in the payer wallet');
 return registry.transaction(async()=>{
  const open=(await registry.query("SELECT * FROM operating_refill_fundings WHERE genesis_hash=? AND program_id=? AND payer=? AND policy=? AND state='prepared' ORDER BY created_at DESC LIMIT 1",[scope.genesisHash,scope.programId,scope.payer,scope.policy])).rows[0];
  if(open)return fundingView(open);
  const rows=(await registry.query("SELECT campaign,due_lamports FROM operating_refills WHERE genesis_hash=? AND program_id=? AND payer=? AND policy=? AND pending_funding_id IS NULL AND due_lamports<>'0' ORDER BY campaign",[scope.genesisHash,scope.programId,scope.payer,scope.policy])).rows;
  const entitlements=rows.map(r=>({campaign:r.campaign,lamports:String(amount(r.due_lamports))})).filter(e=>BigInt(e.lamports)>0n);
  if(!entitlements.length)return null;
  const total=entitlements.reduce((n,e)=>n+BigInt(e.lamports),0n),memo=refillMemo({...scope,entitlements,nonce:randomUUID()}),fundingId=memo.slice('KIDS refill:'.length),at=new Date(now()).toISOString();
  await registry.query("INSERT INTO operating_refill_fundings(funding_id,genesis_hash,program_id,payer,policy,treasury,entitlements_json,total_lamports,memo,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?)",[fundingId,scope.genesisHash,scope.programId,scope.payer,scope.policy,scope.treasury,canonicalJson(entitlements),String(total),memo,at,at]);
  for(const e of entitlements)await registry.query('UPDATE operating_refills SET pending_funding_id=?,updated_at=? WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=?',[fundingId,at,scope.genesisHash,scope.programId,e.campaign,scope.payer]);
  return fundingView((await registry.query('SELECT * FROM operating_refill_fundings WHERE funding_id=?',[fundingId])).rows[0]);
 },{lockKey:'refill-funding:'+[scope.genesisHash,scope.programId,scope.payer].join(':')});
}
const fundingView=r=>({fundingId:r.funding_id,genesisHash:r.genesis_hash,programId:r.program_id,payer:r.payer,policy:r.policy,treasury:r.treasury,entitlements:JSON.parse(r.entitlements_json),totalLamports:r.total_lamports,memo:r.memo,state:r.state,signature:r.signature??null,slot:r.slot==null?null:Number(r.slot)});
/** Reads one finalized transaction and proves it is the prepared funding: success, one system transfer from the treasury
 * to the payer of exactly the total, one memo equal to the prepared memo. Any other shape is refused. */
export async function verifyRefillTransaction(connection,funding,signature){
 if(!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature??''))throw Error('Invalid refill signature');
 const reply=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
 if(!reply)throw Error('Refill transaction is not finalized or history is unavailable');
 if(reply.meta?.err!==null)throw Error('Refill transaction failed on chain');
 const message=reply.transaction.message,keys=message.staticAccountKeys.map(String);
 if(message.addressTableLookups?.length)throw Error('Refill transaction must not use lookup tables');
 let transfer=null,memo=null;
 for(const ix of message.compiledInstructions){
  const program=keys[ix.programIdIndex],data=Buffer.from(ix.data),acc=ix.accountKeyIndexes.map(i=>keys[i]);
  if(program==='11111111111111111111111111111111'){
   if(data.length!==12||data.readUInt32LE(0)!==2||transfer)throw Error('Refill transaction must carry exactly one system transfer');
   transfer={from:acc[0],to:acc[1],lamports:data.readBigUInt64LE(4)};
  }else if(program===MEMO_PROGRAM){if(memo!==null)throw Error('Refill transaction must carry exactly one memo');memo=data.toString();}
  else if(program!=='ComputeBudget111111111111111111111111111111')throw Error('Refill transaction carries a foreign instruction');
 }
 if(!transfer||transfer.from!==funding.treasury||transfer.to!==funding.payer||transfer.lamports!==BigInt(funding.totalLamports))throw Error('Refill transfer does not match the prepared funding');
 if(memo!==funding.memo)throw Error('Refill memo does not match the prepared funding');
 const payerIndex=keys.indexOf(funding.payer),pre=reply.meta.preBalances,post=reply.meta.postBalances;
 if(payerIndex<0||!Array.isArray(pre)||!Array.isArray(post)||BigInt(post[payerIndex])-BigInt(pre[payerIndex])!==BigInt(funding.totalLamports))throw Error('Refill balances do not reconcile');
 if(!Number.isSafeInteger(reply.slot)||reply.slot<1)throw Error('Refill slot unavailable');
 return {signature,slot:reply.slot};
}
/** Credits a prepared funding after its transfer is finalized: one budget reserve per campaign, idempotent by funding. */
export async function creditRefillFunding({registry,connection,fundingId,signature,now=Date.now}){
 if(!/^[a-f0-9]{64}$/.test(fundingId??''))throw Error('Invalid funding id');
 const row=(await registry.query('SELECT * FROM operating_refill_fundings WHERE funding_id=?',[fundingId])).rows[0];
 if(!row)throw Error('Unknown refill funding');
 const funding=fundingView(row);
 if(funding.state==='credited'){if(signature&&funding.signature!==signature)throw Error('Funding was credited from another signature');return {...funding,duplicate:true};}
 if(funding.state!=='prepared')throw Error('Funding is '+funding.state);
 const proof=await verifyRefillTransaction(connection,funding,signature);
 return registry.transaction(async()=>{
  const current=(await registry.query('SELECT state,signature FROM operating_refill_fundings WHERE funding_id=? FOR UPDATE',[fundingId])).rows[0];
  if(current.state==='credited'){if(current.signature!==signature)throw Error('Funding was credited from another signature');return {...funding,state:'credited',signature,duplicate:true};}
  const at=new Date(now()).toISOString();
  for(const e of funding.entitlements){
   const applied=await registry.budgets.apply({genesisHash:funding.genesisHash,programId:funding.programId,campaign:e.campaign,payer:funding.payer,policy:funding.policy,action:'reserve',lamports:e.lamports,operationKey:'refill:'+canonicalHash({fundingId,campaign:e.campaign})});
   if(applied.outcome!=='reserved')throw Error('Refill credit refused for '+e.campaign+': '+applied.outcome);
   const r=(await registry.query('SELECT due_lamports,funded_lamports,pending_funding_id FROM operating_refills WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? FOR UPDATE',[funding.genesisHash,funding.programId,e.campaign,funding.payer])).rows[0];
   if(!r||r.pending_funding_id!==fundingId||amount(r.due_lamports)<BigInt(e.lamports))throw Error('Refill entitlement changed for '+e.campaign);
   await registry.query('UPDATE operating_refills SET due_lamports=?,funded_lamports=?,pending_funding_id=NULL,updated_at=? WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=?',[String(amount(r.due_lamports)-BigInt(e.lamports)),String(amount(r.funded_lamports)+BigInt(e.lamports)),at,funding.genesisHash,funding.programId,e.campaign,funding.payer]);
  }
  await registry.query("UPDATE operating_refill_fundings SET state='credited',signature=?,slot=?,updated_at=? WHERE funding_id=?",[signature,proof.slot,at,fundingId]);
  return {...funding,state:'credited',signature,slot:proof.slot,duplicate:false};
 },{lockKey:'refill-funding:'+[funding.genesisHash,funding.programId,funding.payer].join(':')});
}
/** Releases a prepared funding that will not be paid (its entitlements become due again). */
export async function voidRefillFunding({registry,fundingId,now=Date.now}){
 if(!/^[a-f0-9]{64}$/.test(fundingId??''))throw Error('Invalid funding id');
 const known=(await registry.query('SELECT genesis_hash,program_id,payer FROM operating_refill_fundings WHERE funding_id=?',[fundingId])).rows[0];
 if(!known)throw Error('Unknown refill funding');
 return registry.transaction(async()=>{
  const row=(await registry.query('SELECT * FROM operating_refill_fundings WHERE funding_id=? FOR UPDATE',[fundingId])).rows[0];
  if(row.state!=='prepared')return fundingView(row);
  const at=new Date(now()).toISOString();
  await registry.query('UPDATE operating_refills SET pending_funding_id=NULL,updated_at=? WHERE pending_funding_id=?',[at,fundingId]);
  await registry.query("UPDATE operating_refill_fundings SET state='void',updated_at=? WHERE funding_id=?",[at,fundingId]);
  return fundingView((await registry.query('SELECT * FROM operating_refill_fundings WHERE funding_id=?',[fundingId])).rows[0]);
 },{lockKey:'refill-funding:'+[known.genesis_hash,known.program_id,known.payer].join(':')});
}
