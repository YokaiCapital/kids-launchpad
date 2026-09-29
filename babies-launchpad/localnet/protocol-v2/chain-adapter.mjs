// Chain adapter for the job handlers (localnet/jobs/handlers.mjs): the handler contract (readCampaign, listReceipts,
// settle, refund, launch, verifyLaunch, signatureStatus, assertReady) implemented over a web3.js Connection and the
// keeper's operator signer (operator-signer.mjs: the local admin keypair on localnet, the signing service elsewhere).
// Every send names the job's campaign, fencing token and operation key, so the signing service's capability path can
// refuse a stale runner; every outcome is explicit: confirmed, failed (with the program's error text) or unknown
// (the transaction left the process and its fate is not known: the signature, blockhash and last valid block height
// are returned so the handler's reconcile step can settle its fate before anything is rebuilt or resent).
// Receipt enumeration is one getProgramAccounts by campaign (size, magic and campaign memcmp); it is complete only
// when the call returned and every account decoded as a receipt of that campaign. Nothing here retries a send.
import {PublicKey,Keypair,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {getMint,getAccount} from '@solana/spl-token';
import {toSigner} from '../operator-signer.mjs';
import * as client from './client.mjs';
import * as v3 from '../protocol-v3/client.mjs';
import {readLookupTablePlan} from '../jobs/lookup-table-plan.mjs';
import {AddressLookupTableProgram} from '@solana/web3.js';
import {launchReady,campaignFailed,PHASE_LIVE} from './policy.mjs';
import {createDurableSender,packetStatus,base58} from './durable-send.mjs';
export {base58};
export const DEFAULT_UNITS=Object.freeze({settle:60_000,refund:60_000,launch:1_400_000,claim:120_000,assertReady:60_000,lookupTable:100_000,launchV2:400_000,refundV2:60_000,closeV2:60_000,accountV2:60_000,returnCollateralV2:60_000});
/** The program's error text from a transaction error object, in the form the handlers match (custom program error: 0x..). */
export function errorText(err){
 if(!err)return null;if(typeof err==='string')return err;
 const ie=err.InstructionError;if(Array.isArray(ie)){const [index,detail]=ie;if(detail&&typeof detail==='object'&&'Custom' in detail)return 'instruction '+index+': custom program error: 0x'+Number(detail.Custom).toString(16);return 'instruction '+index+': '+JSON.stringify(detail);}
 return JSON.stringify(err);
}
const big=v=>typeof v==='bigint'?v:BigInt(String(v));
export function createChainAdapter({connection,programId,signer,genesisHash,commitment='confirmed',preflightCommitment='confirmed',confirmationWaitMs=null,units=DEFAULT_UNITS,log=()=>{},registry=null}){
 if(!connection)throw Error('chain adapter needs a connection');
 const program=client.toKey(programId);const keeper=toSigner(signer);if(!keeper?.publicKey)throw Error('chain adapter needs the keeper signer');
 const genesis=client.toKey(genesisHash);
 const calls={read:0,list:0,settle:0,refund:0,launch:0,sent:0,confirmed:0,failed:0,unknown:0};
 function bind(id){
  if(!client.toKey(id.programId).equals(program))throw Error('job program '+id.programId+' is not the adapter program '+program.toBase58());
  if(!client.toKey(id.genesisHash).equals(genesis))throw Error('job genesis '+id.genesisHash+' is not the adapter ledger');
  return client.toKey(id.campaign);
 }
 async function chainTime(){const c=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY,commitment);if(!c)throw Error('clock unavailable');return c.data.readBigInt64LE(32);}
 async function readCampaign(id){
  calls.read++;const campaign=bind(id);
  const r=await connection.getAccountInfoAndContext(campaign,commitment);
  if(!r.value)throw Error('campaign '+campaign.toBase58()+' does not exist');
  if(!r.value.owner.equals(program))throw Error('campaign '+campaign.toBase58()+' is not owned by the program');
  const c=client.decodeCampaign(r.value.data);
  // The sealed genesis binds the campaign to one ledger; a campaign of another network is refused here, as tag 1 does.
  if(c.terms.genesis!==client.keyHex(genesis))throw Error('campaign genesis mismatch: built against another network');
  if(!client.campaignAddress(program,c.terms.creator,c.terms.nonce).equals(campaign))throw Error('campaign PDA mismatch');
  // `accountingVersion` 2 marks a funding-first record (byte 992; the version-3 program re-encodes it on every write).
  return {address:campaign.toBase58(),accountingVersion:r.value.data[v3.OFF_ACCOUNTING_VERSION]??0,phase:c.state.phase,opensAt:c.terms.opensAt,deadline:c.terms.deadline,launchDeadline:c.terms.launchDeadline,soft:c.terms.soft,hard:c.terms.hard,total:c.state.total,refunded:c.state.refunded,receiptCount:c.state.receiptCount,settledCount:c.state.settledCount,settledAccepted:c.state.settledAccepted,participantClaimed:c.state.participantClaimed,devClaimed:c.state.devClaimed,launchTime:c.state.launchTime,pool:c.state.pool.toBase58(),feeNft:c.state.feeNft.toBase58(),lamports:BigInt(r.value.lamports),slot:r.context.slot,termsHash:c.state.termsHash,terms:c.terms,split:c.split,bump:c.state.bump};
 }
 async function listReceipts(id){
  calls.list++;const campaign=bind(id);
  let r;
  try{r=await connection.getProgramAccounts(program,{commitment,filters:client.receiptFilters(campaign),withContext:true});}
  catch(e){if(e?.code==='CAPACITY_WAIT'||String(e?.message||e).includes('Reserved upstream capacity is busy'))throw e;log({event:'v2-list-receipts-failed',campaign:campaign.toBase58(),message:String(e?.message||e).slice(0,200)});return {receipts:[],complete:false,slot:null,error:String(e?.message||e).slice(0,200)};}
  const receipts=[];
  for(const {pubkey,account} of r.value){
   let d;try{d=client.decodeReceipt(account.data);}catch(e){return {receipts:[],complete:false,slot:r.context.slot,error:'undecodable receipt '+pubkey.toBase58()};}
   if(!d.campaign.equals(campaign)||!client.receiptAddress(program,campaign,d.owner).equals(pubkey))return {receipts:[],complete:false,slot:r.context.slot,error:'foreign receipt '+pubkey.toBase58()};
   receipts.push({address:pubkey.toBase58(),owner:d.owner.toBase58(),committed:d.committed,accepted:d.accepted,refunded:d.refunded,sequence:d.sequence,settled:d.settled,claimed:d.claimed,claimedTokens:d.claimedTokens});
  }
  return {receipts,complete:true,slot:r.context.slot};
 }
 // Read-only adapters may omit the registry. Every write fails closed without a durable journal.
 const send=registry?.operatorPackets?createDurableSender({connection,keeper,journal:registry.operatorPackets,genesisHash:genesis.toBase58(),programId:program.toBase58(),commitment,preflightCommitment,confirmationWaitMs,calls,log}):async()=>{throw Error('Operator packet journal required before sending');};
 const jobOptions=(id,o)=>({...o,campaign:id.campaign,fencingToken:o.fencingToken??null,operationKey:o.operationKey??null});
 async function settle(id,receipt,options={}){calls.settle++;const campaign=bind(id);return send([client.settleInstruction(program,campaign,receipt.owner)],jobOptions(id,{...options,computeUnits:units.settle,label:'settle'}));}
 async function refund(id,receipt,options={}){calls.refund++;const campaign=bind(id);return send([client.refundInstruction(program,campaign,receipt.owner)],jobOptions(id,{...options,computeUnits:units.refund,label:'refund'}));}
 // Funding-first bookkeeping on a version-2 record (tags 44-47; the program refuses the old money tags there and these here).
 async function refundV2(id,receipt,options={}){calls.refund++;const campaign=bind(id);return send([v3.refundV2Instruction(program,campaign,receipt.owner)],jobOptions(id,{...options,computeUnits:units.refundV2,label:'refund-v2'}));}
 async function closeV2(id,options={}){const campaign=bind(id);return send([v3.closeV2Instruction(program,campaign)],jobOptions(id,{...options,computeUnits:units.closeV2,label:'close-v2'}));}
 async function accountV2(id,receipt,options={}){const campaign=bind(id);return send([v3.accountV2Instruction(program,campaign,receipt.owner)],jobOptions(id,{...options,computeUnits:units.accountV2,label:'account-v2'}));}
 async function returnCollateralV2(id,options={}){const campaign=bind(id);const c=await readCampaign(id);return send([v3.returnCollateralV2Instruction(program,campaign,c.terms.creator)],jobOptions(id,{...options,computeUnits:units.returnCollateralV2,label:'collateral-v2',intent:{action:'collateral-v2',creator:String(c.terms.creator)}}));}
 /** The funding-first extension at the adapter's commitment: identity, sealed totals and the accounting counters. */
 async function readExtension(id){const campaign=bind(id);const r=await connection.getAccountInfoAndContext(v3.extAddress(program,campaign),commitment);if(!r.value)throw Error('funding-first extension missing');if(!r.value.owner.equals(program))throw Error('funding-first extension is not owned by the program');return {...v3.decodeExt(r.value.data),slot:r.context.slot};}
 /** The winning journal packet owns its auxiliary NFT signature and address. A
  * restart does not regenerate that identity while the prior attempt is unresolved. */
 async function launch(id,options={}){
  calls.launch++;const campaign=bind(id);const c=await readCampaign(id);
  return send(()=>{
   const nft=options.feeNft instanceof Keypair?options.feeNft:Keypair.generate();
   const {instruction,addresses}=client.launchInstruction(program,campaign,c.terms,keeper.publicKey,nft.publicKey);
   return {instructions:[instruction],extraSigners:[nft],facts:{feeNft:nft.publicKey.toBase58(),pool:addresses.pool.toBase58()}};
  },jobOptions(id,{...options,computeUnits:units.launch,label:'launch',intent:{action:'launch',termsHash:c.termsHash,requestedFeeNft:options.feeNft?.publicKey?.toBase58()??null}}));
 }
 /** Funding-first: the keeper's lookup table for the campaign's launch, created and extended with the launch template's
  * non-signer accounts (LOOKUP_TABLE_CHUNK per extension), one durable packet per transaction, each through the signer's
  * capability path (setup shape) and the cost reader's exact template. The table address derives from the creation slot. */
 // `afterPacket(result, step)` (optional): called after each confirmed table packet, before the next chunk, so the caller can
 // reconcile that packet's accounting hold while the ledger still serves its history (the accounting lane's own cadence).
 async function launchTable(id,{plan,afterPacket=null,...options}={}){
  // The table identity comes from the campaign's durable plan (jobs/lookup-table-plan.mjs), never from a fresh slot read:
  // the address derives from (keeper, slot) only, so only a reserved slot keeps one campaign from another's table.
  if(!plan||!Number.isSafeInteger(plan.recentSlot)||plan.recentSlot<0||typeof plan.table!=='string')throw Error('lookup table plan required');
  const campaign=bind(id);const c=await readCampaign(id);
  const extInfo=await connection.getAccountInfo(v3.extAddress(program,campaign),commitment);if(!extInfo)throw Error('funding-first extension missing');
  const ext=v3.decodeExt(extInfo.data),addresses=v3.launchTableAddresses(program,campaign,c.terms,ext.feeNft);
  const slot=plan.recentSlot;
  const [create,table]=AddressLookupTableProgram.createLookupTable({authority:keeper.publicKey,payer:keeper.publicKey,recentSlot:slot});
  if(table.toBase58()!==plan.table)throw Error('lookup table plan does not derive from this keeper and slot');
  const extend=chunk=>AddressLookupTableProgram.extendLookupTable({lookupTable:table,authority:keeper.publicKey,payer:keeper.publicKey,addresses:chunk});
  const chunks=[];for(let i=0;i<addresses.length;i+=v3.LOOKUP_TABLE_CHUNK)chunks.push(addresses.slice(i,i+v3.LOOKUP_TABLE_CHUNK));
  const opts=jobOptions(id,{...options,computeUnits:units.lookupTable,label:'launch-table'});
  // The signer proves the table at FINALIZED commitment before every extension, so the next chunk waits until the ledger
  // finalizes the previous one (bounded; an unfinished wait is an unknown outcome the next attempt resumes, never a rebuild).
  const finalizedPrefix=async(count)=>{const until=Date.now()+(options.finalityWaitMs??90000);while(Date.now()<until){const r=await connection.getAccountInfoAndContext(table,'finalized');if(r.value){try{const st=v3.decodeLookupTable(r.value.data);if(st.addresses.length>=count)return true;}catch{}}await new Promise(resolve=>setTimeout(resolve,500));}return false;};
  // Every packet is built only while the campaign's durable plan still names this table (a replaced plan is refused).
  const planCurrent=async()=>{if(!registry?.query)return;const row=await readLookupTablePlan({registry,identity:id});if(!row||row.table!==table.toBase58()||row.recentSlot!==slot)throw Object.assign(Error('lookup table plan replaced; allocate again'),{code:'LOOKUP_TABLE_PLAN_REPLACED'});};
  await planCurrent();
  let last=await send([create,extend(chunks[0])],{...opts,operationId:'launch-table:'+table.toBase58()+':1'});
  if(afterPacket&&last.status==='confirmed')await afterPacket(last,1);
  let done=0;
  for(let i=1;i<chunks.length&&last.status==='confirmed';i++){
   done+=chunks[i-1].length;
   await planCurrent();
   if(!await finalizedPrefix(done))return {...last,status:'unknown',table:table.toBase58(),addresses:addresses.length,steps:chunks.length,step:i+1,recentSlot:slot,error:'awaiting lookup table finality before chunk '+(i+1)};
   last=await send([extend(chunks[i])],{...opts,operationId:'launch-table:'+table.toBase58()+':'+(i+1)});
   if(afterPacket&&last.status==='confirmed')await afterPacket(last,i+1);
  }
  return {...last,table:table.toBase58(),addresses:addresses.length,steps:chunks.length,recentSlot:slot};
 }
 /** Funding-first launch (tag 42) through the table: the reserved mint and fee NFT co-sign the durable packet, either as
  * in-process keypairs (rehearsal) or through `coSign(tx, ref)` (custody: the mint inventory's launch signer). */
 async function launchFundingFirst(id,{table,mint=null,feeNft=null,display,coSign=null,...options}={}){
  calls.launch++;const campaign=bind(id);const c=await readCampaign(id);
  if(!display)throw Error('funding-first launch needs the display');
  const local=mint instanceof Keypair&&feeNft instanceof Keypair;
  if(!local&&typeof coSign!=='function')throw Error('funding-first launch needs the reserved mint and fee NFT signers or the custody co-signer');
  const extInfo=await connection.getAccountInfo(v3.extAddress(program,campaign),'finalized');if(!extInfo)throw Error('funding-first extension missing');
  const ext=v3.decodeExt(extInfo.data);
  if(local&&(ext.mint!==mint.publicKey.toBase58()||ext.feeNft!==feeNft.publicKey.toBase58()))throw Error('reserved signers differ from the sealed extension');
  const mintAddress=local?mint.publicKey.toBase58():ext.mint,nftAddress=local?feeNft.publicKey.toBase58():ext.feeNft;
  return send(()=>{
   const {instruction,addresses}=v3.launchFundingFirstInstruction(program,campaign,c.terms,keeper.publicKey,nftAddress,display);
   return {instructions:[instruction],extraSigners:local?[mint,feeNft]:[],facts:{feeNft:nftAddress,mint:mintAddress,pool:addresses.pool.toBase58(),table:String(table)}};
  },jobOptions(id,{operationId:'launch-v2:'+id.campaign,...options,...(local?{}:{coSign:(tx,ref)=>coSign(tx,{...ref,campaign:id.campaign,keeper:keeper.publicKey.toBase58(),mint:mintAddress,feeNft:nftAddress,operationKey:options.operationKey??null,fencingToken:options.fencingToken??null})}),computeUnits:units.launchV2,label:'launch-v2',lookupTables:[String(table)],intent:{action:'launch-v2',termsHash:c.termsHash,table:String(table),mint:mintAddress,feeNft:nftAddress,displayHash:v3.displayHash(display)}}));
 }
 async function signatureStatus(signature,facts=null){
  let row=null;
  if(facts?.packetRef){
   const ref=facts.packetRef;if(!registry?.operatorPackets||!/^[a-f0-9]{64}$/.test(ref.operationId??'')||!Number.isSafeInteger(ref.attempt)||ref.attempt<1)throw Error('Invalid operator reconciliation reference');
   if(typeof registry.operatorPackets.get!=='function')throw Error('Exact operator attempt reader required');
   row=await registry.operatorPackets.get(ref.operationId,ref.attempt);
   if(!row||row.attempt!==ref.attempt||row.signature!==signature)throw Error('Operator reconciliation packet differs');
   const d=JSON.parse(row.descriptor);
   if(d.genesisHash!==genesis.toBase58()||d.programId!==program.toBase58())throw Error('Operator reconciliation scope differs');
   // A later prepared attempt must not strand a job still holding the previous
   // attempt's facts. Terminal evidence is immutable; do not substitute the new
   // signature or erase the old outcome when RPC history eventually disappears.
   if(['expired','failed'].includes(row.status))return {status:row.status,...(row.result?.error?{error:row.result.error}:{})};
   if(row.status==='finalized')return {status:'confirmed',finalized:true,slot:row.result?.slot??null};
  }
  const state=await packetStatus(connection,signature,row?.prepared??facts);
  // Persist chain evidence even when the handler subsequently observes that its
  // on-chain action is complete and therefore never calls send() again.
  if(row&&['signed','confirmed'].includes(row.status)){
   const to=state.status==='confirmed'?(state.finalized?'finalized':commitment==='confirmed'?'confirmed':null):['failed','expired'].includes(state.status)&&row.status==='signed'?state.status:null;
   if(to&&to!==row.status)await registry.operatorPackets.progress({operationId:row.operationId,attempt:row.attempt,from:row.status,to,result:state});
  }
  return commitment==='finalized'&&state.status==='confirmed'&&!state.finalized?{...state,status:'unresolved',observed:true}:state;
 }
 /** Readiness: the chain's own verdict (tag 5 simulated) with a plain reason computed from the campaign and the clock. */
 async function assertReady(id){
  const campaign=bind(id);const c=await readCampaign(id);const now=await chainTime();
  const local=launchReady(c,now);
  const reason=local?'ready':c.phase===PHASE_LIVE?'already live':campaignFailed(c,now)?'failed: total '+c.total+' vs soft '+c.soft+', phase '+c.phase+', launch deadline '+c.launchDeadline+' at '+now:now<c.deadline?'funding open until '+c.deadline+' (now '+now+')':'settled '+c.settledCount+' of '+c.receiptCount+', accepted '+c.settledAccepted+' vs soft '+c.soft+', phase '+c.phase;
  if(!local)return {ready:false,reason,live:c.phase===PHASE_LIVE,failed:campaignFailed(c,now),slot:c.slot};
  const block=await connection.getLatestBlockhash(commitment);
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:keeper.publicKey,recentBlockhash:block.blockhash,instructions:[client.assertReadyInstruction(program,campaign)]}).compileToV0Message());
  const sim=await connection.simulateTransaction(tx,{sigVerify:false,commitment});
  if(sim.value.err)return {ready:false,reason:'tag 5 refused: '+errorText(sim.value.err),live:false,failed:false,slot:sim.context.slot};
  return {ready:true,reason,live:false,failed:false,slot:sim.context.slot};
 }
 /** Reads every account a live launch must have left behind and compares it with the sealed terms (launch.rs read-back). */
 async function verifyLaunch(id){
  const campaign=bind(id);const c=await readCampaign(id);const failures=[];const check=(ok,what)=>{if(!ok)failures.push(what);};
  check(c.phase===PHASE_LIVE,'phase '+c.phase+' is not live');
  if(c.phase!==PHASE_LIVE)return {ok:false,failures,checks:{}};
  const a=client.launchAddresses(program,campaign,c.terms,c.feeNft);
  check(a.pool.toBase58()===c.pool,'recorded pool is not the canonical pool');
  const mint=await getMint(connection,c.terms.childMint,commitment);
  check(mint.mintAuthority===null,'mint authority still set');check(mint.freezeAuthority===null,'freeze authority still set');check(mint.supply===c.terms.supply,'supply changed');check(mint.decimals===c.terms.decimals,'decimals changed');
  const custody=await getAccount(connection,a.child,commitment);const expectedCustody=c.terms.supply-c.split.liquidity;
  check(custody.amount===expectedCustody,'custody holds '+custody.amount+', expected supply minus liquidity '+expectedCustody);check(custody.owner.equals(a.authority),'custody owner is not the launch authority');
  const vault0=await getAccount(connection,a.vault0,commitment),vault1=await getAccount(connection,a.vault1,commitment);
  const childVault=a.mint0.equals(c.terms.childMint)?vault0:vault1,solVault=a.mint0.equals(c.terms.childMint)?vault1:vault0;
  check(childVault.amount===c.split.liquidity,'coin vault holds '+childVault.amount+', expected the liquidity reserve '+c.split.liquidity);
  check(solVault.amount>=c.settledAccepted,'WSOL vault holds '+solVault.amount+', expected at least the accepted total '+c.settledAccepted);
  const lp=await getAccount(connection,a.lp,commitment).catch(()=>null);check(!lp||lp.amount===0n,'launch authority still holds LP');
  const lockVault=await getAccount(connection,a.lockVault,commitment);check(lockVault.amount>0n,'lock vault is empty');
  const locked=await connection.getAccountInfo(a.locked,commitment);
  check(!!locked&&locked.owner.equals(client.toKey(c.terms.lockProgram))&&locked.data.length===256,'locked liquidity state missing');
  if(locked&&locked.data.length===256){const d=locked.data;check(d.readBigUInt64LE(8)===lockVault.amount,'locked LP amount differs from the lock vault');check(new PublicKey(d.subarray(64,96)).equals(a.pool),'locked position pool mismatch');check(new PublicKey(d.subarray(96,128)).equals(a.feeNft),'locked position fee NFT mismatch');check(new PublicKey(d.subarray(128,160)).equals(a.authority),'locked position owner is not the launch authority');check(new PublicKey(d.subarray(160,192)).equals(a.lpMint),'locked position LP mint mismatch');}
  const feeNft=await getAccount(connection,a.feeNftAccount,commitment);check(feeNft.amount===1n&&feeNft.owner.equals(campaign),'fee NFT is not held by the campaign');
  const nftMint=await getMint(connection,a.feeNft,commitment);check(nftMint.supply===1n&&nftMint.mintAuthority===null,'fee NFT mint is not a sealed NFT');
  const pool=await connection.getAccountInfo(a.pool,commitment);check(!!pool&&pool.owner.equals(client.toKey(c.terms.ammProgram))&&pool.data.length===637,'pool state missing');
  let poolFacts={};
  if(pool&&pool.data.length===637){const d=pool.data;const k=i=>new PublicKey(d.subarray(8+32*i,40+32*i));
   check(k(0).equals(client.toKey(c.terms.ammConfig)),'pool config mismatch');check(k(1).equals(a.authority),'pool creator is not the launch authority');check(k(2).equals(a.vault0)&&k(3).equals(a.vault1),'pool vaults mismatch');check(k(4).equals(a.lpMint),'pool LP mint mismatch');check(k(5).equals(a.mint0)&&k(6).equals(a.mint1),'pool mints mismatch');
   check(d[329]===0,'pool status '+d[329]);check(d[390]===0,'pool creator fee enabled');poolFacts={lpSupply:d.readBigUInt64LE(333),status:d[329],creatorFeeEnabled:d[390]!==0};
   check(poolFacts.lpSupply===lockVault.amount+100n,'LP supply '+poolFacts.lpSupply+' is not locked '+lockVault.amount+' + 100');}
  const rent=BigInt(await connection.getMinimumBalanceForRentExemption(client.CAMPAIGN_LEN));const liability=c.total-c.settledAccepted-c.refunded;
  check(c.lamports>=rent+liability,'campaign holds '+c.lamports+', below rent plus refund liability '+(rent+liability));
  return {ok:failures.length===0,failures,checks:{custody:custody.amount,coinVault:childVault.amount,solVault:solVault.amount,lockedLp:lockVault.amount,lpSupply:poolFacts.lpSupply??null,creatorFeeEnabled:poolFacts.creatorFeeEnabled??null,mintAuthority:mint.mintAuthority,freezeAuthority:mint.freezeAuthority,campaignLamports:c.lamports,rent,liability,pool:a.pool.toBase58(),feeNft:a.feeNft.toBase58(),launchTime:c.launchTime}};
 }
 return {programId:program,keeper:keeper.publicKey,genesisHash:genesis,commitment,calls,chainTime,readCampaign,readExtension,listReceipts,settle,refund,refundV2,closeV2,accountV2,returnCollateralV2,launch,launchTable,launchFundingFirst,verifyLaunch,signatureStatus,assertReady,send};
}
