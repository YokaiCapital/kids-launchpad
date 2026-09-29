// Version-specific reuse of the legacy pure movement decoder. Separate from
// legacy/Family decoding: v3 tag 22 rotates an operator, it never sells tokens.
import {decodeBase58} from '../../shared/solana.mjs';
import {SUPPORTED_VERSIONS,WSOL_MINT} from './decode.mjs';
export const ACTIVITY_DECODER_VERSION=3;
const SYSTEM='11111111111111111111111111111111';
const TOKEN_PROGRAMS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const U64=/^\d{1,20}$/,ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const LAUNCH_KINDS=Object.freeze({0:'campaign-init',40:'campaign-init',1:'commit',2:'finalize',3:'refund',4:'settle',5:'ready',6:'launch',7:'claim-participant',8:'claim-dev',20:'fees-init',21:'fees-collect',22:'fees-operator',23:'fees-distribute',26:'burn-child',27:'setup-return'});
export const KINDS=Object.freeze([...Object.values(LAUNCH_KINDS),'authority-revoked','program-attempt']);
export const ROLES=Object.freeze(['pool','lock','treasury','dev','creator']);
const CAMPAIGN_INDEX={0:1,40:1,1:1,2:0,3:0,4:0,5:0,6:0,7:0,8:0,20:0,21:0,22:0,23:0,26:0,27:0};
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
 if(typeof info.lamports==='number'&&!Number.isSafeInteger(info.lamports))return null;const lamports=typeof info.lamports==='number'?String(info.lamports):info.lamports;if(!U64.test(lamports||''))return null;
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
 * @param identity {campaign, launchProgram, mint, coinDecimals, programVersion:3, mode:'standard'}
 * @returns {failed, unsupported, events:[...], skipped:[{path,reason}], version}
 */
export function decodePublicActivity(tx,identity){
 validateIdentity(identity);if(identity.programVersion!==3||identity.mode!=='standard'||identity.distributionProgram||identity.distribution)throw Error('Explicit Standard v3 activity scope required');
 const out={failed:false,unsupported:false,events:[],skipped:[],version:tx?.version??null};
 if(!tx||!tx.transaction?.message||!tx.meta)return {...out,skipped:[{path:null,reason:'no transaction'}]};
 if(!SUPPORTED_VERSIONS.includes(tx.version))return {...out,unsupported:true,skipped:[{path:null,reason:'unsupported transaction version '+String(tx.version)}]};
 const failed=!!tx.meta.err;out.failed=failed;
 const keys=tx.transaction.message.accountKeys||[],signers=new Set(keys.filter(k=>k.signer).map(k=>k.pubkey)),feePayer=keys[0]?.pubkey||null;
 const balanceByAccount=new Map();
 for(const b of [...(tx.meta.preTokenBalances||[]),...(tx.meta.postTokenBalances||[])]){const k=keys[b.accountIndex]?.pubkey;if(k&&!balanceByAccount.has(k))balanceByAccount.set(k,{mint:b.mint,decimals:b.uiTokenAmount?.decimals,owner:b.owner||null});}
 const lamportDelta=address=>{const i=keys.findIndex(k=>k.pubkey===address);if(i<0||!Array.isArray(tx.meta.preBalances)||!Array.isArray(tx.meta.postBalances))return null;if(!Number.isSafeInteger(tx.meta.preBalances[i])||!Number.isSafeInteger(tx.meta.postBalances[i]))return null;return BigInt(tx.meta.postBalances[i])-BigInt(tx.meta.preBalances[i]);};
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
  const bytes=ix.data?bytesOf(ix.data):null,A=ix.accounts||[];if(!bytes||!bytes.length){if(failed&&ix.programId===identity.launchProgram&&A.includes(identity.campaign))return {program:'launch',kind:'program-attempt',tag:null,bytes:bytes||new Uint8Array(),A};return null;}const tag=bytes[0];
  if(ix.programId===identity.launchProgram){
   const kind=LAUNCH_KINDS[tag];if(!kind){if(A.includes(identity.campaign)){if(failed)return {program:'launch',kind:'program-attempt',tag,bytes,A};out.skipped.push({path:null,reason:'unknown Standard instruction'});}return null;}
   if(A[CAMPAIGN_INDEX[tag]]!==identity.campaign)return null;
   return {program:'launch',kind,tag,bytes,A};
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
   case 'refund':refunds.push({assets,destination:A[2],path});break;// filled in after the whole transaction is known
   case 'launch':outOf(A[5],[A[21],A[22]],'pool',WSOL_MINT);outOf(A[4],[A[21],A[22]],'pool',identity.mint);for(const t of transfers)if(t.destination===A[9])push(asset(path,{mint:A[19],account:A[9],amount:t.amount,direction:'out',role:'lock'}));break;
   case 'claim-participant':outOf(A[4],[A[5]],null,identity.mint);break;
   case 'claim-dev':outOf(A[3],[A[4]],null,identity.mint);break;
   case 'fees-collect':into(A[4],identity.mint);into(A[5],WSOL_MINT);break;
   case 'fees-distribute':outOf(A[4],[A[5]],'treasury',WSOL_MINT);outOf(A[4],[A[6]],'dev',WSOL_MINT);break;
   case 'setup-return':{for(const t of system)if(t.source===A[1]&&t.destination===A[2])assets.push({mint:'SOL',amountRaw:t.lamports,decimals:9,direction:'out',role:'creator',account:A[2]});break;}
   case 'burn-child':burned(A[4],A[5]);break;
   default:break;
  }
  return {assets};
 }
 /** Fixed facts from the instruction itself (parent mints, parent index, vault purpose); never an amount. */
 function detailOf(){return null;}
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
 // Native refunds edit balances directly. Attribute a batch only when every
 // non-compute instruction is a unique-owner refund for this campaign, and all
 // recipient deltas (including fee-payer fee correction) reconcile to custody.
 if(!failed&&refunds.length){
  const pure=top.every(ix=>ix.programId==='ComputeBudget111111111111111111111111111111'||classify(ix)?.kind==='refund')&&out.events.filter(e=>e.kind==='refund').every(e=>!e.nested);
  const custody=lamportDelta(identity.campaign),unique=new Set(refunds.map(r=>r.destination)).size===refunds.length;
  const amounts=refunds.map(r=>{const d=lamportDelta(r.destination);if(d===null)return null;return d+(r.destination===feePayer&&Number.isSafeInteger(tx.meta.fee)?BigInt(tx.meta.fee):0n);});
  const known=pure&&unique&&custody!==null&&custody<=0n&&amounts.every(n=>n!==null&&n>=0n)&&amounts.reduce((a,b)=>a+b,0n)===-custody;
  refunds.forEach((r,i)=>{if(known){if(amounts[i]>0n)r.assets.push({mint:'SOL',amountRaw:String(amounts[i]),decimals:9,direction:'out',role:null,account:r.destination});}else{const event=out.events.find(e=>e.instructionPath===r.path);if(event)event.amountsUnresolved=true;}});
 }
 // Authority changes on the child mint, anywhere in a transaction that carries our activity.
 if(!failed&&out.events.length){
  const launchActor=out.events[0].actor;
  const scan=(ix,path,nested)=>{const t=parsedToken(ix);if(t?.op==='setAuthority'&&(t.mint||t.account)===identity.mint&&t.newAuthority===null)out.events.push({...base,campaign:identity.campaign,instructionPath:path,program:'token',kind:'authority-revoked',actor:launchActor,assets:[],detail:t.authorityType,failed:false,nested});};
  top.forEach((ix,i)=>{scan(ix,String(i),false);(innerByIndex.get(i)||[]).forEach((ix2,j)=>scan(ix2,i+'.'+j,true));});
 }
 return out;
}
