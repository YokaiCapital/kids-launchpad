// Shared cost exposure, not custody or signing authority. Production must provide
// independently qualified chain-proof readers and payer/funding policy before
// mounting this behind any signer. No HTTP endpoint or activation is supplied.
import {PublicKey} from '@solana/web3.js';
import {canonicalHash,canonicalJson} from '../registry/canonical.mjs';
const key=/^[A-Za-z0-9_.:-]{1,128}$/,hash=/^[a-f0-9]{64}$/,sig=/^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const amount=x=>{if(typeof x!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(x)||BigInt(x)>18446744073709551615n)throw Error('Invalid operating amount');return BigInt(x);};
const conflict=()=>Object.assign(Error('Operating accounting evidence differs from its bound intent'),{code:'IDEMPOTENCY_CONFLICT'});
function scope(x){for(const k of ['genesisHash','programId','campaign','payer'])if(new PublicKey(x[k]).toBase58()!==x[k])throw conflict();if(!key.test(x.policy??''))throw conflict();return ['genesisHash','programId','campaign','payer'].map(k=>x[k]);}
const lock=x=>'budget:'+scope(x).join(':');
export function createOperatingLedger({registry,verifyFunding,verifyOutcome,onHeld=null}){
 if(onHeld!==null&&typeof onHeld!=='function')throw Error('Operating hold scheduler must be a function');
 if(registry?.driver!=='postgres'||!registry.budgets?.apply||typeof verifyFunding!=='function'||typeof verifyOutcome!=='function')throw Error('Operating ledger requires shared accounting and trusted proof readers');
 const query=(s,p=[])=>registry.query(s,p);
 async function balance(x){
  const row=await registry.budgets.get(x),pending=(await query("SELECT maximum_lamports FROM operating_spend_holds WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? AND state='held'",scope(x))).rows;
  if(row&&row.policy!==x.policy)throw conflict();
  const funds=row?amount(row.reservedLamports)-amount(row.spentLamports)-amount(row.returnedLamports):0n,held=pending.reduce((n,r)=>n+amount(r.maximum_lamports),0n);
  if(funds<held)throw Error('Operating exposure exceeds verified funds');
  return {fundedLamports:row?.reservedLamports??'0',spentLamports:row?.spentLamports??'0',returnedLamports:row?.returnedLamports??'0',heldLamports:String(held),availableLamports:String(funds-held)};
 }
 const find=async x=>(await query('SELECT * FROM operating_spend_holds WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? AND operation_id=?',[...scope(x),x.operationId])).rows[0];
 const match=(row,x)=>{if(!row||row.message_hash!==x.messageHash||row.maximum_lamports!==x.maximumLamports||row.policy!==x.policy)throw conflict();};
 const view=r=>({state:r.state,operationId:r.operation_id,messageHash:r.message_hash,maximumLamports:r.maximum_lamports,actualLamports:r.actual_lamports??null});
 return {
  async balance(input){const x=structuredClone(input);return registry.transaction(()=>balance(x),{lockKey:lock(x)});},
  // Read-only restart check against the finalized proof AND atomic accounting
  // entry already committed. Never manufactures a credit from a cached balance.
  async credited(input){
   const x=structuredClone(input);scope(x);if(!sig.test(x.signature??'')||amount(x.lamports)<=0n||new PublicKey(x.source).toBase58()!==x.source||x.source===x.payer)throw conflict();
   return registry.transaction(async()=>{
    const row=(await query('SELECT * FROM operating_funding_receipts WHERE genesis_hash=? AND signature=?',[x.genesisHash,x.signature])).rows[0];if(!row)return null;
    const descriptor=canonicalJson({identity:scope(x),policy:x.policy,source:x.source,lamports:x.lamports}),proof=JSON.parse(row.evidence_json);
    if(row.descriptor!==descriptor||row.program_id!==x.programId||row.campaign!==x.campaign||row.payer!==x.payer||proof?.finalized!==true||!Number.isSafeInteger(proof.slot)||proof.slot<1||['genesisHash','programId','campaign','payer','signature','policy','source','lamports'].some(k=>proof[k]!==x[k]))throw conflict();
    const operation=(await query('SELECT descriptor,result_json FROM budget_operations WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? AND operation_key=?',[...scope(x),'fund:'+canonicalHash({signature:x.signature})])).rows[0];
    if(!operation||operation.descriptor!==canonicalJson({action:'reserve',lamports:x.lamports,policy:x.policy})||JSON.parse(operation.result_json)?.outcome!=='reserved')throw conflict();
    if(BigInt((await balance(x)).fundedLamports)<BigInt(x.lamports))throw conflict();
    return {status:'credited',duplicate:true,slot:proof.slot};
   },{lockKey:lock(x)});
  },
  async credit(input){
   const x=structuredClone(input);scope(x);if(!sig.test(x.signature??''))throw conflict();
   // The reader must verify the finalized successful funding packet, its exact
   // source/destination and campaign binding. A UI balance is never proof.
   const proof=await verifyFunding(structuredClone(x));
   if(!proof||proof.finalized!==true||!Number.isSafeInteger(proof.slot)||proof.slot<1||['genesisHash','programId','campaign','payer','signature','policy'].some(k=>proof[k]!==x[k])||amount(proof.lamports)<=0n)throw conflict();
   if(new PublicKey(proof.source).toBase58()!==proof.source||proof.source===x.payer)throw conflict();
   const descriptor=canonicalJson({identity:scope(x),policy:x.policy,source:proof.source,lamports:proof.lamports});
   return registry.transaction(async()=>{
    // Chain-wide signature uniqueness also prevents attribution to another payer.
    const prior=(await query('SELECT descriptor FROM operating_funding_receipts WHERE genesis_hash=? AND signature=?',[x.genesisHash,x.signature])).rows[0];
    if(prior){if(prior.descriptor!==descriptor)throw conflict();return {status:'credited',duplicate:true};}
    await query('INSERT INTO operating_funding_receipts(genesis_hash,signature,program_id,campaign,payer,descriptor,evidence_json) VALUES(?,?,?,?,?,?,?)',[x.genesisHash,x.signature,x.programId,x.campaign,x.payer,descriptor,canonicalJson(proof)]);
    const applied=await registry.budgets.apply({...x,action:'reserve',lamports:proof.lamports,operationKey:'fund:'+canonicalHash({signature:x.signature})});
    if(applied.outcome!=='reserved')throw conflict();return {status:'credited',duplicate:false};
   },{lockKey:lock(x)});
  },
  async hold(input){
   const x=structuredClone(input);scope(x);if(!key.test(x.operationId??'')||!hash.test(x.messageHash??'')||amount(x.maximumLamports)<=0n)throw conflict();
   return registry.transaction(async()=>{
    const prior=await find(x);if(prior){match(prior,x);if(prior.state==='held'&&onHeld)await onHeld(structuredClone(x));return view(prior);}
    const sameMessage=(await query('SELECT operation_id FROM operating_spend_holds WHERE genesis_hash=? AND payer=? AND message_hash=?',[x.genesisHash,x.payer,x.messageHash])).rows[0];
    if(sameMessage)throw conflict();
    const b=await balance(x);if(amount(x.maximumLamports)>amount(b.availableLamports))return {state:'insufficient',availableLamports:b.availableLamports,requiredLamports:x.maximumLamports};
    await query("INSERT INTO operating_spend_holds(genesis_hash,program_id,campaign,payer,operation_id,message_hash,maximum_lamports,policy,state) VALUES(?,?,?,?,?,?,?,?,'held')",[...scope(x),x.operationId,x.messageHash,x.maximumLamports,x.policy]);
    // Database work only. Scheduler failure rolls back the hold; RPC calls or
    // signing must never be placed inside this transaction callback.
    if(onHeld)await onHeld(structuredClone(x));return view(await find(x));
   },{lockKey:lock(x)});
  },
  async reconcile(input){
   const x=structuredClone(input);scope(x);const row=await find(x);match(row,x);if(row.state==='settled')return view(row);
   // Unknown, timeout and confirmed-only results preserve the entire hold.
   // Expiry proof must rule out every broadcast/signature of this exact message.
   const proof=await verifyOutcome({...structuredClone(x),hold:view(row)});
   if(proof?.status==='unknown')return {...view(row),reason:'awaiting-finality'};
   if(!proof||!['finalized','expired'].includes(proof.status)||proof.messageHash!==x.messageHash||proof.operationId!==x.operationId||scope(proof).some((v,i)=>v!==scope(x)[i])||proof.policy!==x.policy||!Number.isSafeInteger(proof.slot)||proof.slot<1||amount(proof.actualLamports)>amount(x.maximumLamports))throw conflict();
   if(proof.status==='expired'&&proof.actualLamports!=='0')throw conflict();
   if(proof.status==='finalized'&&!sig.test(proof.signature??''))throw conflict();
   // A reserve return (option 1) leaves the payer as one outflow: the network fee is spent, the rest is returned to the
   // creator and recorded as returned, never as spent. Anything else keeps returnedLamports absent or zero.
   const returned=proof.returnedLamports===undefined?0n:amount(proof.returnedLamports);
   if(returned>amount(proof.actualLamports)||(proof.status==='expired'&&returned!==0n))throw conflict();
   return registry.transaction(async()=>{
    const current=await find(x);match(current,x);if(current.state==='settled')return view(current);
    // One lock is shared with credits, holds, spends and returns for this payer.
    await balance(x);
    // Release this hold inside the same transaction, then debit actual cost.
    // Other holds remain protected even from the generic spend/return API.
    await query("UPDATE operating_spend_holds SET state='settled',actual_lamports=?,evidence_json=? WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? AND operation_id=? AND state='held'",[proof.actualLamports,canonicalJson(proof),...scope(x),x.operationId]);
    const spent=await registry.budgets.apply({...x,action:'spend',lamports:String(amount(proof.actualLamports)-returned),operationKey:'cost:'+canonicalHash({operation:x.operationId})});
    if(spent.outcome!=='spent')throw conflict();
    if(returned>0n){const back=await registry.budgets.apply({...x,action:'return',lamports:String(returned),operationKey:'return:'+canonicalHash({operation:x.operationId})});if(back.outcome!=='returned')throw conflict();}
    return view(await find(x));
   },{lockKey:lock(x)});
  },
 };
}
