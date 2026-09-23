// Pure decoder: one parsed transaction (getTransaction, jsonParsed) to the program activity of ONE campaign.
// No RPC, no clock, no state. Every instruction of the launch program (programs/atomic-launch) or the campaign's
// distribution program (programs/kids-distribution) that names our campaign (or our distribution record) becomes one
// event, top-level or nested. Failed transactions still produce their events (status failed, no assets), so a user
// sees a claim attempt that did not go through.
//
// Amount rules (owner requirement, 23 September 2026): only executed movements, read from the token transfers and
// burns the instruction itself issued (its descendants by stack height) and, for the two instructions that move
// lamports without a CPI (commit uses a System transfer; refund edits lamports directly), from the System transfer
// or the campaign account's own lamport delta. Planned budgets in instruction bodies are never used as amounts.
// Direction is the campaign custody's point of view: 'in' entered custody, 'out' left custody, 'burn' destroyed.
import {decodeBase58} from '../../shared/solana.mjs';
import {SUPPORTED_VERSIONS,WSOL_MINT} from './decode.mjs';
export const ACTIVITY_DECODER_VERSION=1;
const SYSTEM='11111111111111111111111111111111';
const TOKEN_PROGRAMS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const U64=/^\d{1,20}$/,ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Launch program tags (programs/atomic-launch/src/lib.rs) to event kinds. Tag 22 is retired on chain but exists in history. */
export const LAUNCH_KINDS=Object.freeze({0:'campaign-init',1:'commit',2:'finalize',3:'refund',4:'settle',5:'ready',6:'launch',7:'claim-participant',8:'claim-dev',9:'configure-parents',10:'claim-parent',20:'fees-init',21:'fees-collect',22:'fees-sell',23:'fees-distribute',24:'buy-burn',25:'buy-burn-routed',26:'burn-child'});
/** Distribution program tags (programs/kids-distribution/src/lib.rs). */
export const DISTRIBUTION_KINDS=Object.freeze({0:'vault-activate',1:'vault-claim-participant',2:'vault-claim-parent',3:'vault-claim-dev',4:'vault-burn-expired',5:'vault-sweep'});
export const TOKEN_KINDS=Object.freeze(['authority-revoked']);
export const KINDS=Object.freeze([...Object.values(LAUNCH_KINDS),...Object.values(DISTRIBUTION_KINDS),...TOKEN_KINDS]);
export const ROLES=Object.freeze(['pool','lock','vault','treasury','dev']);
/** Index of the campaign account in each launch instruction's fixed account order. */
const CAMPAIGN_INDEX={0:1,1:1,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:1,10:1,20:0,21:0,22:0,23:0,24:0,25:0,26:0};
/** Distribution tags bind by the campaign (tag 0, account 2) or by the distribution record (tags 1..3 account 1, tags 4..5 account 0). */
const DISTRIBUTION_BIND={0:{campaign:2},1:{distribution:1},2:{distribution:1},3:{distribution:1},4:{distribution:0},5:{distribution:0}};
function bytesOf(data){try{return decodeBase58(data);}catch{return null;}}
function parsedToken(ix){
 if(!TOKEN_PROGRAMS.has(ix.programId)||!ix.parsed)return null;
 const t=ix.parsed.type,info=ix.parsed.info||{};
 if(t==='transfer'||t==='transferChecked'){const amount=t==='transfer'?info.amount:info.tokenAmount?.amount;if(!U64.test(amount||''))return null;return {op:'transfer',source:info.source,destination:info.destination,authority:info.authority||info.multisigAuthority||null,mint:info.mint||null,decimals:t==='transferChecked'?info.tokenAmount?.decimals:null,amount};}
 if(t==='burn'||t==='burnChecked'){const amount=t==='burn'?info.amount:info.tokenAmount?.amount;if(!U64.test(amount||''))return null;return {op:'burn',account:info.account,mint:info.mint||null,authority:info.authority||info.multisigAuthority||null,decimals:t==='burnChecked'?info.tokenAmount?.decimals:null,amount};}
 if(t==='setAuthority')return {op:'setAuthority',mint:info.mint||null,account:info.account||null,authorityType:info.authorityType||null,newAuthority:info.newAuthority??null,authority:info.authority||null};
 return null;
}
function parsedSystemTransfer(ix){
 if(ix.programId!==SYSTEM||ix.parsed?.type!=='transfer')return null;const info=ix.parsed.info||{};
 const lamports=typeof info.lamports==='number'?String(info.lamports):info.lamports;if(!U64.test(lamports||''))return null;
 return {source:info.source,destination:info.destination,lamports};
}
/** Every instruction nested under position `position` of `list` at stack height `height` (all depths). Null when heights are missing for a nested instruction. */
function descendantsOf(list,position,height){
 if(height==null)return null;
 const out=[];
 for(let j=position+1;j<list.length;j++){const h=list[j].stackHeight;if(h==null)return null;if(h<=height)break;out.push({ix:list[j],index:j});}
 return out;
}
function validateIdentity(identity){
 for(const k of ['campaign','launchProgram','mint'])if(!ADDRESS.test(identity?.[k]||''))throw Error('Activity identity is incomplete: '+k);
 if(!Number.isInteger(identity.coinDecimals)||identity.coinDecimals<0||identity.coinDecimals>18)throw Error('Activity identity is incomplete: coinDecimals');
 if(identity.distributionProgram!=null&&!ADDRESS.test(identity.distributionProgram))throw Error('Activity identity is incomplete: distributionProgram');
 if(identity.distribution!=null&&!ADDRESS.test(identity.distribution))throw Error('Activity identity is incomplete: distribution');
}
/**
 * @param tx a jsonParsed transaction (result of getTransaction) or null
 * @param identity {campaign, launchProgram, mint, coinDecimals, distributionProgram|null, distribution|null} base58 strings
 * @returns {failed, unsupported, events:[...], skipped:[{path,reason}], version}
 */
export function decodeActivity(tx,identity){
 validateIdentity(identity);
 const out={failed:false,unsupported:false,events:[],skipped:[],version:tx?.version??null};
 if(!tx||!tx.transaction?.message||!tx.meta)return {...out,skipped:[{path:null,reason:'no transaction'}]};
 if(!SUPPORTED_VERSIONS.includes(tx.version))return {...out,unsupported:true,skipped:[{path:null,reason:'unsupported transaction version '+String(tx.version)}]};
 const failed=!!tx.meta.err;out.failed=failed;
 const keys=tx.transaction.message.accountKeys||[],signers=new Set(keys.filter(k=>k.signer).map(k=>k.pubkey)),feePayer=keys[0]?.pubkey||null;
 const balanceByAccount=new Map();
 for(const b of [...(tx.meta.preTokenBalances||[]),...(tx.meta.postTokenBalances||[])]){const k=keys[b.accountIndex]?.pubkey;if(k&&!balanceByAccount.has(k))balanceByAccount.set(k,{mint:b.mint,decimals:b.uiTokenAmount?.decimals,owner:b.owner||null});}
 const lamportDelta=address=>{const i=keys.findIndex(k=>k.pubkey===address);if(i<0||!Array.isArray(tx.meta.preBalances)||!Array.isArray(tx.meta.postBalances))return null;return BigInt(tx.meta.postBalances[i])-BigInt(tx.meta.preBalances[i]);};
 const decimalsOf=(account,mint)=>{const b=account?balanceByAccount.get(account):null;if(Number.isInteger(b?.decimals))return b.decimals;if(mint===WSOL_MINT)return 9;if(mint===identity.mint)return identity.coinDecimals;return null;};
 const mintOf=(account,fallback)=>fallback||balanceByAccount.get(account)?.mint||null;
 const base={signature:tx.transaction.signatures?.[0]||null,slot:tx.slot,blockTimeUnix:Number.isInteger(tx.blockTime)?tx.blockTime:null,decoderVersion:ACTIVITY_DECODER_VERSION};
 const actorOf=ix=>(ix.accounts||[]).find(a=>signers.has(a))||feePayer;
 const top=tx.transaction.message.instructions||[],innerByIndex=new Map();
 for(const inner of tx.meta.innerInstructions||[])innerByIndex.set(inner.index,inner.instructions||[]);
 /** One asset line. Returns null (and records a skip) when the amount cannot be typed. */
 const asset=(path,{mint,account,amount,direction,role=null})=>{
  const m=mint===WSOL_MINT?'SOL':mint;const decimals=mint===WSOL_MINT?9:decimalsOf(account,mint);
  if(!m||!Number.isInteger(decimals)){out.skipped.push({path,reason:'asset without mint or decimals'});return null;}
  return {mint:m,amountRaw:amount,decimals,direction,role,account:account||null};
 };
 const refunds=[];
 function classify(ix){
  const bytes=ix.data?bytesOf(ix.data):null;if(!bytes||!bytes.length)return null;const tag=bytes[0];const A=ix.accounts||[];
  if(ix.programId===identity.launchProgram){
   const kind=LAUNCH_KINDS[tag];if(!kind)return null;
   if(A[CAMPAIGN_INDEX[tag]]!==identity.campaign)return null;
   return {program:'launch',kind,tag,bytes,A};
  }
  if(identity.distributionProgram&&ix.programId===identity.distributionProgram){
   const kind=DISTRIBUTION_KINDS[tag];if(!kind)return null;const bind=DISTRIBUTION_BIND[tag];
   if(bind.campaign!==undefined&&A[bind.campaign]!==identity.campaign)return null;
   if(bind.distribution!==undefined&&(!identity.distribution||A[bind.distribution]!==identity.distribution))return null;
   return {program:'distribution',kind,tag,bytes,A};
  }
  return null;
 }
 /** Executed movements for one instruction from its descendants. */
 function assetsFor(c,path,descendants){
  const {kind,A,bytes}=c;const assets=[];
  const transfers=[],burns=[],system=[];
  for(const d of descendants){const t=parsedToken(d.ix);if(t?.op==='transfer')transfers.push(t);else if(t?.op==='burn')burns.push(t);const s=parsedSystemTransfer(d.ix);if(s)system.push(s);}
  const push=a=>{if(a)assets.push(a);};
  const outOf=(source,destinations,role=null,mint=null)=>{for(const t of transfers)if(t.source===source&&(!destinations||destinations.includes(t.destination)))push(asset(path,{mint:mintOf(t.destination,t.mint||mint||mintOf(source,null)),account:t.destination,amount:t.amount,direction:'out',role}));};
  const into=(destination,mint=null)=>{for(const t of transfers)if(t.destination===destination)push(asset(path,{mint:mintOf(t.source,t.mint||mint||mintOf(destination,null)),account:t.source,amount:t.amount,direction:'in'}));};
  const burned=(account,mint=null)=>{for(const b of burns)if(b.account===account)push(asset(path,{mint:b.mint||mint||mintOf(account,null),account,amount:b.amount,direction:'burn'}));};
  switch(kind){
   case 'commit':{const t=system.filter(s=>s.destination===A[1]&&s.source===A[0]);if(t.length!==1)return {skip:'commit with '+t.length+' transfers into the campaign'};assets.push({mint:'SOL',amountRaw:t[0].lamports,decimals:9,direction:'in',role:null,account:A[1]});break;}
   case 'refund':refunds.push({assets,destination:A[2]});break;// filled in after the whole transaction is known
   case 'launch':outOf(A[5],[A[21],A[22]],'pool',WSOL_MINT);outOf(A[4],[A[21],A[22]],'pool',identity.mint);for(const t of transfers)if(t.destination===A[9])push(asset(path,{mint:A[19],account:A[9],amount:t.amount,direction:'out',role:'lock'}));break;
   case 'claim-participant':outOf(A[4],[A[5]],null,identity.mint);break;
   case 'claim-dev':outOf(A[3],[A[4]],null,identity.mint);break;
   case 'claim-parent':outOf(A[7],[A[8]],null,identity.mint);break;
   case 'fees-collect':into(A[4],identity.mint);into(A[5],WSOL_MINT);break;
   case 'fees-sell':outOf(A[4],null,null,identity.mint);into(A[5],WSOL_MINT);break;
   case 'fees-distribute':outOf(A[4],[A[5]],'treasury',WSOL_MINT);outOf(A[4],[A[6]],'dev',WSOL_MINT);break;
   case 'buy-burn':outOf(A[4],null,null,WSOL_MINT);burned(A[5],A[12]);break;
   case 'buy-burn-routed':outOf(A[4],null,null,WSOL_MINT);burned(A[5],A[7]);break;
   case 'burn-child':burned(A[4],A[5]);break;
   case 'vault-activate':outOf(A[5],[A[11],A[12],A[13],A[14]],'vault',identity.mint);for(const v of [A[11],A[12],A[13],A[14]])burned(v,identity.mint);break;
   case 'vault-claim-participant':outOf(A[6],[A[7]],null,identity.mint);break;
   case 'vault-claim-parent':outOf(A[5],[A[6]],null,identity.mint);break;
   case 'vault-claim-dev':outOf(A[4],[A[5]],null,identity.mint);break;
   case 'vault-burn-expired':case 'vault-sweep':burned(A[3],identity.mint);break;
   default:break;
  }
  return {assets};
 }
 /** Fixed facts from the instruction itself (parent mints, parent index, vault purpose); never an amount. */
 function detailOf({kind,A,bytes}){
  if(kind==='configure-parents')return A[3]+','+A[4];
  if(['claim-parent','buy-burn','buy-burn-routed','vault-claim-parent','vault-burn-expired'].includes(kind))return bytes.length>1?'parent-'+bytes[1]:null;
  if(kind==='vault-sweep')return bytes.length>1?'purpose-'+bytes[1]:null;
  return null;
 }
 function emit(c,ix,path,nested,descendants){
  const event={...base,campaign:identity.campaign,instructionPath:path,program:c.program,kind:c.kind,actor:actorOf(ix),assets:[],detail:detailOf(c),failed,nested};
  if(!failed){
   if(descendants===null){out.skipped.push({path,reason:'nested instruction without stack heights (unsupported RPC response)'});return;}
   const r=assetsFor(c,path,descendants);if(r.skip){out.skipped.push({path,reason:r.skip});return;}event.assets=r.assets;
  }
  out.events.push(event);
 }
 top.forEach((ix,i)=>{
  const inner=innerByIndex.get(i)||[];
  const c=classify(ix);
  if(c)emit(c,ix,String(i),false,inner.map((x,index)=>({ix:x,index})));
  inner.forEach((ix2,j)=>{
   const c2=classify(ix2);if(!c2)return;
   emit(c2,ix2,i+'.'+j,true,descendantsOf(inner,j,ix2.stackHeight==null?null:ix2.stackHeight));
  });
 });
 // Refund moves lamports without a CPI: the campaign's own lamport delta is the executed amount, unambiguous only when
 // this transaction holds exactly one refund of this campaign. A zero delta is an executed no-op (already paid).
 if(!failed&&refunds.length){
  const delta=lamportDelta(identity.campaign);
  if(refunds.length!==1||delta===null){for(const r of refunds)out.skipped.push({path:null,reason:refunds.length!==1?'several refunds in one transaction: campaign delta is shared':'campaign balance unavailable'});}
  else if(delta<0n)refunds[0].assets.push({mint:'SOL',amountRaw:(-delta).toString(),decimals:9,direction:'out',role:null,account:refunds[0].destination});
 }
 // Authority changes on the child mint, anywhere in a transaction that carries our activity.
 if(!failed&&out.events.length){
  const launchActor=out.events[0].actor;
  const scan=(ix,path,nested)=>{const t=parsedToken(ix);if(t?.op==='setAuthority'&&t.mint===identity.mint&&t.newAuthority===null)out.events.push({...base,campaign:identity.campaign,instructionPath:path,program:'token',kind:'authority-revoked',actor:launchActor,assets:[],detail:t.authorityType,failed:false,nested});};
  top.forEach((ix,i)=>{scan(ix,String(i),false);(innerByIndex.get(i)||[]).forEach((ix2,j)=>scan(ix2,i+'.'+j,true));});
 }
 return out;
}
