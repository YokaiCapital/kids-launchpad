import {signedPacketOutcome} from './wallet-outcome.mjs';
import {returnSetupInstruction} from '../protocol-v3/client.mjs';
import {publicIssuerVersion} from '../registry/issuer-version.mjs';
import {readPresets} from '../registry/presets.mjs';
// Wallet-only v2 actions. No API/operator key signs a participant transaction.
// Signed bytes are persisted before broadcast; ambiguous RPC outcomes retain the same signature.
import {PublicKey,Transaction,VersionedTransaction,SYSVAR_CLOCK_PUBKEY,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {decodeCampaign,decodeReceipt,decodeFeeState,feeStateAddress,WSOL,launchAuthority,campaignAddress,receiptAddress,keyHex,associatedTokenAddress,commitInstruction,refundInstruction,claimParticipantInstruction,claimDevInstruction,TOKEN_PROGRAM,ASSOCIATED_TOKEN_PROGRAM} from './client.mjs';
import {unpackAccount} from '@solana/spl-token';
import {accepted,participantTokens,devEntitled,u64} from './policy.mjs';
import {validateApprovedMessage} from '../../shared/approved-message.mjs';
import {verifySignature,encodeBase58} from '../../shared/solana.mjs';
const idOf=r=>[r.genesisHash,r.programId,r.campaign].join(':');
const max=(a,b)=>a>b?a:b;
const publicPacket=p=>({intentId:p.id,owner:p.owner,campaignId:p.campaignId,...p.prepared,status:p.status,signature:p.signature,error:p.error});
const fail=message=>{throw Object.assign(Error(message),{publicMessage:message});};
export function positionFrom({decoded,receipt,clock}){
 const {terms:t,state:s,split}=decoded,live=s.phase===3;
 const failed=s.phase===2||(!live&&clock>=t.deadline&&(s.total<t.soft||clock>=t.launchDeadline));
 const committed=receipt?.committed||0n;
 const acceptedAmount=failed?0n:receipt?.settled?receipt.accepted:accepted(committed,s.total,t.hard);
 const tokenAmount=live&&s.settledAccepted>0n?participantTokens(split.participants,acceptedAmount,s.settledAccepted):0n;
 return {eligibility:'verified',commitLamports:String(committed),acceptedLamports:String(acceptedAmount),refundedLamports:String(receipt?.refunded||0n),tokensBaseUnits:String(tokenAmount),claimedTokensBaseUnits:String(receipt?.claimedTokens||0n),parents:[],failed,live};
}
/** The manifest's minimum first commitment (version 3 only). The version-3 layout has no field for it, so the API refuses a
 * smaller first commitment before any packet exists; a top-up on an existing receipt creates no new receipt and is not
 * limited. Absent from the manifest means no minimum; a malformed value refuses to build the service. */
function manifestMinimumCommitment(programVersion){
 if(programVersion!==3)return 0n;
 const value=readPresets().agreed?.funding?.minimumCommitmentLamports;
 if(value==null)return 0n;
 if(typeof value!=='string'||!/^\d{1,20}$/.test(value))throw Error('Presets manifest: agreed.funding.minimumCommitmentLamports must be a decimal string');
 return BigInt(value);
}
const solText=lamports=>{const whole=lamports/1000000000n,fraction=(lamports%1000000000n).toString().padStart(9,'0').replace(/0+$/,'');return String(whole)+(fraction?'.'+fraction:'');};
export function createPublicWalletService({registry,connection,genesisHash,programIds,programVersion=2,enabled=false,minimumCommitmentLamports=null}){
 const minimumCommitment=minimumCommitmentLamports==null?manifestMinimumCommitment(programVersion):BigInt(minimumCommitmentLamports);
 programVersion=publicIssuerVersion(programVersion);
 const getRegistry=()=>typeof registry==='function'?registry():registry;
 const allowed=new Set(programIds||[]);
 async function network(){if(await connection.getGenesisHash()!==genesisHash)fail('Network identity changed; no transaction was sent');}
 async function rowFor(id){
  const row=await getRegistry().campaigns.get(id);
  if(!row||row.genesisHash!==genesisHash||!allowed.has(row.programId)||row.campaignVersion!==programVersion||row.mode!=='standard')fail('This launch is not supported by this wallet service');
  return row;
 }
 async function read(owner,id){
  const row=await rowFor(id),wallet=new PublicKey(owner),campaign=new PublicKey(row.campaign),program=new PublicKey(row.programId);
  const reply=await connection.getMultipleAccountsInfoAndContext([campaign,receiptAddress(program,campaign,wallet),SYSVAR_CLOCK_PUBKEY,...(programVersion===3?[launchAuthority(program,campaign)]:[])],{commitment:'confirmed'});
  const [a,r,c]=reply.value;
  if(!a||!a.owner.equals(program)||!c||c.data.length<40)fail('Verified launch data is unavailable');
  const decoded=decodeCampaign(a.data),t=decoded.terms;
  if(t.genesis!==keyHex(genesisHash)||!campaignAddress(program,t.creator,t.nonce).equals(campaign)||t.mode!==0)fail('Launch identity mismatch');
  let receipt=null;
  if(r){if(!r.owner.equals(program))fail('Receipt owner mismatch');receipt=decodeReceipt(r.data);if(!receipt.owner.equals(wallet)||!receipt.campaign.equals(campaign))fail('Receipt identity mismatch');}
  const clock=c.data.readBigInt64LE(32),position=positionFrom({decoded,receipt,clock});
  if(t.dev.equals(wallet))position.dev={reservedBaseUnits:String(decoded.split.dev),availableBaseUnits:String(position.live?max(0n,devEntitled(t.supply,t.vesting,decoded.state.launchTime,clock)-decoded.state.devClaimed):0n),claimedBaseUnits:String(decoded.state.devClaimed)};
  if(programVersion===3&&t.creator.equals(wallet)){
   position.setup={eligibility:'unknown'};
   if(reply.value.length===4){
    const budget=reply.value[3];
    if(budget===null||(budget.owner.equals(SystemProgram.programId)&&!budget.executable&&budget.data.length===0&&Number.isSafeInteger(budget.lamports)&&budget.lamports>=0)){
     const terminal=s=>s===2||s===3,remaining=String(budget?.lamports||0);
     position.setup={eligibility:'verified',remainingLamports:remaining,availableLamports:terminal(decoded.state.phase)?remaining:'0',terminal:terminal(decoded.state.phase)};
    }
   }
  }
  if(programVersion===3&&position.live&&(t.dev.equals(wallet)||t.treasury.equals(wallet))){
   position.feePayout={status:'unavailable'};
   try{
    const address=associatedTokenAddress(wallet,WSOL),evidence=await connection.getMultipleAccountsInfoAndContext([feeStateAddress(program,campaign),address],{commitment:'confirmed',minContextSlot:reply.context.slot});
    if(!Number.isSafeInteger(evidence.context?.slot)||evidence.context.slot<reply.context.slot||evidence.value?.length!==2)throw Error('Fee payout evidence unavailable');
    const [state,account]=evidence.value;
    if(!state)position.feePayout={status:'awaiting-setup'};
    else{
     if(state.executable||!state.owner.equals(program))throw Error('Fee state owner mismatch');decodeFeeState(state.data,campaign);
     if(!account)position.feePayout={status:'repair-required',owner,address:String(address),mint:String(WSOL),slot:evidence.context.slot};
     else{
      const token=unpackAccount(address,account,TOKEN_PROGRAM);
      if(account.executable||account.data.length!==165||!token.isInitialized||token.isFrozen||!token.owner.equals(wallet)||!token.mint.equals(WSOL)||!token.isNative||token.delegate||token.delegatedAmount!==0n||token.closeAuthority)throw Error('Unsafe payout account');
      position.feePayout={status:'ready',owner,address:String(address),mint:String(WSOL),slot:evidence.context.slot};
     }
    }
   }catch{/* Missing evidence never becomes a repair offer or a zero balance. */}
  }
  return {row,decoded,receipt,clock,position,slot:reply.context.slot};
 }
 async function positions(owner,{campaignIds=[]}={}){
  new PublicKey(owner);await network();
  if(!Array.isArray(campaignIds)||campaignIds.length>24||campaignIds.some(x=>typeof x!=='string'))fail('Request up to 24 launch positions');
  const ids=[...new Set(campaignIds)],out={},liveMints=new Map();
  for(let i=0;i<ids.length;i+=4)await Promise.all(ids.slice(i,i+4).map(async id=>{try{const v=await read(owner,id);out[idOf(v.row)]={...v.position,slot:v.slot};if(v.position.live)liveMints.set(idOf(v.row),v.decoded.terms.childMint.toBase58());}catch{out[id]={eligibility:'unknown'};}}));
  if(liveMints.size){try{const accounts=await connection.getParsedTokenAccountsByOwner(new PublicKey(owner),{programId:TOKEN_PROGRAM},'confirmed');if(accounts.value.length>5000)throw Error('Token account limit');const amounts=new Map();for(const a of accounts.value){const info=a.account.data.parsed?.info;if(info?.owner!==owner||!/^\d+$/.test(info?.tokenAmount?.amount||''))continue;amounts.set(info.mint,(amounts.get(info.mint)||0n)+BigInt(info.tokenAmount.amount));}for(const [id,mint]of liveMints){out[id].walletTokensBaseUnits=String(amounts.get(mint)||0n);out[id].walletTokensAsOfUnix=Math.floor(Date.now()/1000);}}catch{/* An unread balance stays absent, never zero. */}}
  const balance=await connection.getBalanceAndContext(new PublicKey(owner),'confirmed');
  return {owner,available:true,positions:out,balanceLamports:String(balance.value),slot:balance.context.slot,pending:(await getRegistry().walletPackets.pending(owner)).map(publicPacket)};
 }
 async function prepare(owner,input){
  if(!enabled)fail('Public wallet transactions are not enabled');
  const {action,campaignId,requestId}=input;
  if(!['commit','refund','allocation','dev','setup','fee-account'].includes(action))fail('Unsupported wallet action');
  if(typeof requestId!=='string'||!/^[-\w.:]{1,128}$/.test(requestId))fail('A stable request ID is required');
  const amount=action==='commit'?u64(input.amountLamports,'commitment'):0n;
  if(action==='commit'&&amount<=0n)fail('Enter a positive commitment');
  const row=await rowFor(campaignId),id=idOf(row),descriptor=JSON.stringify({action,amount:String(amount)}),r=getRegistry();
  const prior=await r.walletPackets.find(owner,id,requestId);
  if(prior){if(prior.descriptor!==descriptor)fail('Request ID already belongs to different parameters');return publicPacket(prior);}
  await network();const v=await read(owner,id),{terms:t,state:s}=v.decoded,wallet=new PublicKey(owner),instructions=[];
  if(action==='commit'){
   if(s.phase!==0||v.clock<t.opensAt||v.clock>=t.deadline)fail('Commitments are not open');
   if(!v.receipt&&amount<minimumCommitment)fail('The first commitment is at least '+solText(minimumCommitment)+' SOL');
   instructions.push(commitInstruction(row.programId,row.campaign,owner,genesisHash,amount,v.receipt?.sequence||0n));
  }else if(action==='fee-account'){
   if(programVersion!==3||!v.position.live||!(t.dev.equals(wallet)||t.treasury.equals(wallet)))fail('Fee account restoration belongs to a live launch recipient');
   if(v.position.feePayout?.status!=='repair-required')fail('No verified fee account restoration is needed');
   const ata=associatedTokenAddress(wallet,WSOL);
   // The recipient pays only for their own canonical WSOL account. No transfers,
   // account closure, delegate or keeper authority is part of this repair.
   instructions.push(new TransactionInstruction({programId:ASSOCIATED_TOKEN_PROGRAM,keys:[{pubkey:wallet,isSigner:true,isWritable:true},{pubkey:ata,isSigner:false,isWritable:true},{pubkey:wallet,isSigner:false,isWritable:false},{pubkey:WSOL,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}],data:Buffer.from([1])}));
  }else if(action==='setup'){
   if(programVersion!==3||!t.creator.equals(wallet))fail('Setup returns belong to the recorded creator of this launch');
   if(v.position.setup?.eligibility!=='verified')fail('Could not verify unused setup SOL');
   if(!v.position.setup.terminal)fail('Setup SOL is available only after launch or finalized failure');
   if(BigInt(v.position.setup.availableLamports)<=0n)fail('No unused setup SOL is available');
   instructions.push(returnSetupInstruction(row.programId,row.campaign,owner,genesisHash));
  }else if(action==='refund'){
   if(!(v.position.live||v.position.failed)||BigInt(v.position.commitLamports)-BigInt(v.position.acceptedLamports)-BigInt(v.position.refundedLamports)<=0n)fail('No refundable SOL is available');
   instructions.push(refundInstruction(row.programId,row.campaign,owner));
  }else{
   const available=action==='dev'?BigInt(v.position.dev?.availableBaseUnits||0):BigInt(v.position.tokensBaseUnits)-BigInt(v.position.claimedTokensBaseUnits);
   if(!v.position.live||available<=0n)fail('No tokens are claimable now');
   const ata=associatedTokenAddress(wallet,t.childMint);
   instructions.push(new TransactionInstruction({programId:ASSOCIATED_TOKEN_PROGRAM,keys:[{pubkey:wallet,isSigner:true,isWritable:true},{pubkey:ata,isSigner:false,isWritable:true},{pubkey:wallet,isSigner:false,isWritable:false},{pubkey:t.childMint,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM,isSigner:false,isWritable:false}],data:Buffer.from([1])}));
   instructions.push(action==='dev'?claimDevInstruction(row.programId,row.campaign,t.childMint,owner):claimParticipantInstruction(row.programId,row.campaign,t.childMint,owner));
  }
  const latest=await connection.getLatestBlockhash('confirmed');
  const tx=new Transaction({feePayer:wallet,...latest}).add(...instructions);
  const fee=await connection.getFeeForMessage(tx.compileMessage(),'confirmed');if(fee.value==null)fail('Network fee quote is unavailable');
  let rent=0;
  if(action==='commit'&&!v.receipt)rent=await connection.getMinimumBalanceForRentExemption(128,'confirmed');
  if(['allocation','dev'].includes(action)&&!await connection.getAccountInfo(associatedTokenAddress(wallet,t.childMint),'confirmed'))rent=await connection.getMinimumBalanceForRentExemption(165,'confirmed');
  if(action==='fee-account')rent=await connection.getMinimumBalanceForRentExemption(165,'confirmed');
  const balance=await connection.getBalance(wallet,'confirmed');
  if(BigInt(balance)<amount+BigInt(fee.value+rent+100000))fail('Insufficient SOL for amount, account rent and network fee reserve');
  const prepared={action,observedSlot:v.slot,...(action==='setup'?{expectedReturnLamports:v.position.setup.availableLamports}:{}),amountLamports:String(amount),genesisHash,programId:row.programId,campaign:row.campaign,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,unsignedTransactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),feeLamports:String(fee.value),rentLamports:String(rent),maxPriorityFeeLamports:'100000'};
  return publicPacket(await r.walletPackets.prepare({owner,campaignId:id,requestKey:requestId,descriptor,prepared}));
 }
 async function owned(owner,id){const p=await getRegistry().walletPackets.get(id);if(!p||p.owner!==owner)fail('Transaction not found');await rowFor(p.campaignId);return p;}
 async function status(owner,{intentId}){
  let p=await owned(owner,intentId);await network();
  if(['finalized','failed','expired','cancelled'].includes(p.status))return publicPacket(p);
  if(p.signature){
   const result=await signedPacketOutcome(connection,p);
   if(result)p=await getRegistry().walletPackets.progress(p.id,result.status,result.error??null);
  }else if(await connection.getBlockHeight('finalized')>p.prepared.lastValidBlockHeight)p=await getRegistry().walletPackets.progress(p.id,'expired','Wallet approval expired',{expectedStatus:'prepared'});
  return publicPacket(p);
 }
 async function submit(owner,{intentId,signedTransactionBase64}){
  if(!enabled)fail('Public wallet transactions are not enabled');
  let p=await owned(owner,intentId);await network();
  if(['confirmed','finalized','failed','expired','cancelled'].includes(p.status))return publicPacket(p);
  if(typeof signedTransactionBase64!=='string'||signedTransactionBase64.length>1700||!/^[A-Za-z0-9+/]+={0,2}$/.test(signedTransactionBase64))fail('Invalid signed transaction');
  const wire=Buffer.from(signedTransactionBase64,'base64');if(wire.length>1232)fail('Transaction exceeds the Solana packet limit');
  const signed=VersionedTransaction.deserialize(wire),approved=VersionedTransaction.deserialize(Buffer.from(p.prepared.unsignedTransactionBase64,'base64'));
  validateApprovedMessage(signed.message,approved.message);
  if(signed.message.header.numRequiredSignatures!==1||signed.message.staticAccountKeys[0].toBase58()!==owner||!verifySignature(owner,signed.message.serialize(),signed.signatures[0]))fail('Invalid wallet signature');
  const signature=encodeBase58(signed.signatures[0]);
  p=await getRegistry().walletPackets.sign({id:p.id,owner,signedBase64:wire.toString('base64'),signature});
  try{await connection.sendRawTransaction(wire,{skipPreflight:false,maxRetries:2});await getRegistry().walletPackets.progress(p.id,'submitted');}catch{await getRegistry().walletPackets.progress(p.id,'unknown');}
  try{return await status(owner,{intentId});}catch{return publicPacket(await getRegistry().walletPackets.get(intentId));}
 }
 async function cancel(owner,{intentId}){await owned(owner,intentId);return publicPacket(await getRegistry().walletPackets.cancel(intentId,owner));}
 return {prepare,submit,status,positions,cancel};
}
