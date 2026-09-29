// One accepted draft, one durable request. No automatic signatures, replacement
// requests, wallet key storage or automatic resend with changed transaction bytes.
import {VersionedTransaction} from '@solana/web3.js';
import {createApprovalStore,withCreationLock} from './creator-approval-store.mjs';
import {decodeCreatorPacket,checkedCreatorSignature} from './creator-signing.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const stages=['launch','mint','native-custody','create-campaign','operating-reserve'];
/** Build-time release pins: a quote naming another program, ledger or treasury is refused before any packet is decoded. */
export function checkReleasePins(quote,release){
 if(!release)return;
 for(const [field,expected] of [['programId',release.programId],['genesisHash',release.genesisHash],['treasury',release.treasury]])if(expected&&quote?.[field]!==expected)throw Error('Accepted quote does not match the released program: '+field);
}
export function createCreatorController({owner,request,api,wallet,currentOwner=()=>owner,onChange=()=>{},network='localnet',release=null,approvalStore=undefined,approvalLock=withCreationLock}){
 if(!owner||request?.owner!==owner||request.state!=='accepted'||!request.id||!request.body?.quote||request.body.quote.fundingEnabled!==false)throw Error('An accepted private launch is required');
 const accepted=structuredClone(request),q=accepted.body.quote,d=accepted.body.draft;
 checkReleasePins(q,release);
 const store=approvalStore===undefined?createApprovalStore({owner,network,programId:q.programId,requestId:accepted.id}):approvalStore;let restored=false;
 async function clearApproval(){signedInput=null;await store?.clear();}
 let disposed=false,running=false,signedInput=null,state={snapshot:null,offer:null,busy:false,error:null,uncertain:false,updatedAt:null};
 const assert=()=>{if(disposed||currentOwner()!==owner)throw Error('Wallet changed; reopen this launch with its creator wallet');};
 const emit=patch=>{assert();state={...state,...patch};onChange(structuredClone(state));};
 async function call(path,input){assert();const session=await api('state');assert();if(session.owner!==owner)throw Error('Signed-in wallet changed');// Publication and confirmation continue in the server queue; each browser request stays bounded.
  const r=await api('launches/creation/flow/'+path,{requestId:accepted.id,...input},session.csrf,{retries:0,timeoutMs:path==='status'?8000:15000});assert();return r;}
 function validate(s){
  const r=s?.review,t=q.terms,f=t?.feePolicy;
  if(s?.requestId!==accepted.id||s.draftId!==accepted.draftId||s.network!==network||s.fundingEnabled!==false||(s.workerActivation!==false&&!(s.workerActivation===true&&s.activationReady===true&&s.stage==='complete'&&s.state==='funded'))||!r||r.network!==network)throw Error('Creator status belongs to different launch terms');
  const expected={genesisHash:q.genesisHash,programId:q.programId,name:d.name,symbol:d.symbol,policyHash:q.policyHash,planHash:q.planHash,softCapLamports:t.softCapLamports,hardCapLamports:t.hardCapLamports,fundingDurationSeconds:t.fundingDurationSeconds,launchWindowSeconds:t.launchWindowSeconds,ammConfig:f?.ammConfig,ammConfigIndex:f?.ammConfigIndex,tradeFeeBps:f?.tradeFeeBps,mintRentLamports:q.costs?.lines?.find(l=>l.item==='mint account rent')?.lamports,authorityBudgetLamports:q.authorityFunding?.amountLamports,start:d.start,startUtc:d.startUtc??null};
  for(const [k,v] of Object.entries(expected))if(v===undefined||!equal(r[k],v))throw Error('Creator status differs from the accepted review: '+k);
  // A configured treasury is shown explicitly at approval. If the accepted
  // quote pins one, reject a different destination instead of re-reviewing it.
  if(q.treasury&&r.treasury!==q.treasury)throw Error('Treasury differs from the accepted quote');
  // The operating reserve (option 1) is reviewed at acceptance: amount from the accepted terms, payer pinned by the quote.
  // The accepted quote carries the amount at the top level or in its terms (the server reads it the same way).
  if(!equal(r.operatingReserveLamports??null,q.operatingReserveLamports??t.operating?.reserveLamports??null))throw Error('Creator status differs from the accepted review: operatingReserveLamports');
  if(q.operatingPayer&&r.operatingPayer!==q.operatingPayer)throw Error('Operating payer differs from the accepted quote');
  return s;
 }
 function bindOffer(s){
  const o=s.result;if(!o?.transactionBase64)return null;
  if(o.requestId!==accepted.id||!stages.includes(o.stage)||!o.offerId||o.review?.creator!==owner)throw Error('Creator offer identity changed');
  if(o.stage==='operating-reserve'){const v=o.verification;if(v?.campaign!==s.campaign||v.creator!==owner||v.payer!==s.review.operatingPayer||v.lamports!==s.review.operatingReserveLamports)throw Error('Creator offer belongs to another campaign');}
  else{const mint=o.stage==='mint'||o.stage==='launch'?o.verification:o.verification?.mint;
  if(mint?.requestId!==accepted.id||mint.mint!==s.mint||mint.campaign!==s.campaign)throw Error('Creator offer belongs to another mint');
  if(o.stage==='launch'&&(![2,3].includes(mint.version)||mint.launch?.reserve?.payer!==s.review.operatingPayer||mint.launch.reserve.lamports!==s.review.operatingReserveLamports||mint.launch.authorityBudgetLamports!==s.review.authorityBudgetLamports))throw Error('Creator offer differs from the reviewed launch');
  // Funding-first (version 3): the offer binds the fee NFT the status review shows (the server custody's reserved key); the
  // review is the reference, never the offer, and the packet is still compared byte for byte.
  if(o.stage==='launch'&&(mint.version===3)!==(s.review.accounting==='funding-first'))throw Error('Creator offer differs from the reviewed launch');
  if(o.stage==='launch'&&mint.version===3&&(typeof s.review.feeNft!=='string'||mint.fundingFirst?.feeNft!==s.review.feeNft))throw Error('Creator offer differs from the reviewed launch');}
  const scope={...s.review,opensAt:o.review.opensAt};
  if((o.stage==='create-campaign'||o.stage==='launch')&&d.start==='scheduled'){
   const date=Date.parse(d.startUtc.endsWith('Z')?d.startUtc:d.startUtc+'Z');
   if(!Number.isFinite(date)||String(date/1000)!==scope.opensAt)throw Error('Scheduled opening changed');
  }
  // One creation transaction without a schedule opens when it runs: the sealed opening time must be zero, never a server-chosen date.
  if(o.stage==='launch'&&d.start!=='scheduled'&&scope.opensAt!=='0')throw Error('Opening time differs from the accepted draft');
  decodeCreatorPacket(o.transactionBase64,{owner,scope,stage:o.stage,intent:o.verification,network});
  return {...o,scope};
 }
 function accept(s,{keepOffer=false}={}){validate(s);const offer=bindOffer(s);emit({snapshot:s,offer:offer||(keepOffer?state.offer:null),updatedAt:Date.now(),error:null,uncertain:false});return s;}
 // A failed step is reported to the server log (stage and message only) so the cause can be found without the creator's screen.
 function report(e){try{const s=state.snapshot,o=state.offer;api('state').then(session=>api('launches/creation/flow/report',{requestId:accepted.id,stage:o?.stage||s?.stage||null,message:String(e?.message||e).slice(0,300)},session?.csrf,{retries:0})).catch(()=>{});}catch{/* reporting never blocks the creator */}}
 async function run(fn){if(running)throw Error('A creator action is already in progress');assert();running=true;emit({busy:true,error:null});try{return await fn();}catch(e){if(!disposed&&currentOwner()===owner){emit({error:e.message});report(e);}throw e;}finally{running=false;if(!disposed&&currentOwner()===owner)emit({busy:false});}}
 return {
  getState:()=>structuredClone(state),dispose(){disposed=true;signedInput=null;},
  refresh:({background=false}={})=>{
   // A passive poll must not clear a stopped flow and trigger another wallet prompt.
   if(background&&(state.error||state.uncertain||signedInput))return Promise.resolve(structuredClone(state.snapshot));
   return run(async()=>{
    if(!restored){
     const saved=await store?.load();assert();
     if(saved){
      validate(saved.snapshot);const offer=bindOffer({...saved.snapshot,result:saved.offer});
      if(!offer||saved.input?.offerId!==offer.offerId||saved.input.stage!==offer.stage)throw Error('Saved approval belongs to different launch terms');
      const unsigned=decodeCreatorPacket(offer.transactionBase64,{owner,scope:offer.scope,stage:offer.stage,intent:offer.verification,network});
      const signed=VersionedTransaction.deserialize(Uint8Array.from(atob(saved.input.transactionBase64),c=>c.charCodeAt(0)));
      checkedCreatorSignature(signed,unsigned.serialize());signedInput=saved.input;
     }
     restored=true;
    }
    const s=await call('status');accept(s);if(s.action!=='prepare')await clearApproval();else if(signedInput)emit({uncertain:true});return s;
   });},
  advance:()=>run(async()=>{
   if(signedInput)throw Error('Check or resubmit the previous approval before continuing');
   const s=validate(await call('status'));if(s.serverManaged&&s.serverWork==='paused'&&s.action!=='recover')return accept(await call('resume'));if(!['prepare','resume'].includes(s.action))return accept(s);
   // One server stage per click. Wallet approval is a separate explicit action.
   try{return accept(await call(s.action));}catch(e){emit({offer:null,uncertain:true});throw e;}
  }),
  approve:()=>run(()=>approvalLock([network,q.programId,owner,accepted.id].join(':'),async()=>{
   let o=state.offer;if(!o||signedInput||state.uncertain)throw Error('Review a current transaction before approving');
   const current=validate(await call('status'));if(current.action!=='prepare')return accept(current);
   accept(await call('prepare'));o=state.offer;if(!o)throw Error('Launch is still preparing. Try again.');
   const provider=await wallet(owner);assert();if(provider.publicKey?.toString()!==owner)throw Error('Selected wallet changed');
   const tx=decodeCreatorPacket(o.transactionBase64,{owner,scope:o.scope,stage:o.stage,intent:o.verification,network}),before=tx.serialize().slice();
   const signed=await provider.signTransaction(tx);assert();if(provider.publicKey?.toString()!==owner)throw Error('Wallet changed during approval');
   const transactionBase64=checkedCreatorSignature(signed,before);
   // Re-check the authenticated session after the wallet prompt and preserve this
   // exact submission before sending. Reload recovers the packet and durable request.
   signedInput={stage:o.stage,offerId:o.offerId,transactionBase64};
   await store?.save({input:signedInput,offer:o,snapshot:state.snapshot});emit({offer:null});
   try{const s=await call('submit',signedInput);await clearApproval();return accept(s);}catch(e){emit({uncertain:true});throw e;}
  })),
  resubmit:()=>run(async()=>{if(!signedInput)throw Error('No previous approval is held in this tab');try{const s=await call('submit',signedInput);await clearApproval();return accept(s);}catch(e){emit({uncertain:true});throw e;}}),
  recover:()=>run(async()=>{
   const s=validate(await call('status')),r=state.snapshot?.result;
   if(s.action!=='recover'&&!(s.stage==='create-campaign'&&r?.action==='review-schedule'))throw Error('This launch does not need a replacement approval');
   const input=['mint','launch'].includes(s.stage)?{stage:s.stage,expectedSignature:s.signature}:{stage:s.stage,expectedIntentHash:s.intentHash||r?.intentHash};
   const next=await call('recover',input);await clearApproval();return accept(next);
  }),
  hasHeldApproval:()=>!!signedInput,
 };
}
