// Standard v2 only. No legacy singleton, treasury signing, ATA creation or parent routes.
// Provisioning must initialize the fee state and canonical custody/recipient ATAs first.
import {createHash} from 'node:crypto';
import {PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {unpackAccount} from '@solana/spl-token';
import * as client from './client.mjs';
import {feeEntitlements} from './policy.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
const disc=name=>createHash('sha256').update('account:'+name).digest().subarray(0,8);
const kinds=new Set(['fee-harvest','distribution','token-burn']);
const UNITS=Object.freeze({'fee-harvest':600000,distribution:100000,'token-burn':100000});
const invalid=message=>{throw Error('Fee account mismatch: '+message);};
export const FEE_OPERATION_MIN_VALUE_LAMPORTS=500000n;
const minValue=FEE_OPERATION_MIN_VALUE_LAMPORTS; // 0.0005 SOL minimum; no priority fee in this local rehearsal.
export function createFeeAdapter({connection,registry,chain}){
 if(!connection||!registry?.operatorPackets||!chain?.send)throw Error('Fee adapter needs durable chain and registry');
 const program=chain.programId,keeper=chain.keeper;
 async function snapshot(id){
  const c=await chain.readCampaign(id),campaign=client.toKey(id.campaign);
  if(c.phase!==3)throw Error('Fee campaign not live');
  if(c.terms.mode!==0)throw Error('Only Standard fee workers are qualified');
  const a=client.launchAddresses(program,campaign,c.terms,c.feeNft);
  if(a.pool.toBase58()!==c.pool)invalid('canonical pool');
  const authority=client.feeAuthority(program,campaign),stateAddress=client.feeStateAddress(program,campaign);
  const child=client.associatedTokenAddress(authority,c.terms.childMint),sol=client.associatedTokenAddress(authority,client.WSOL);
  // Recipient-owned accounts can be closed by their owners. Their availability
  // must never gate fee collection or child burns in the other worker chain.
  const addresses=[stateAddress,child,sol,a.locked,a.lockVault,a.pool,a.vault0,a.vault1,a.feeNftAccount];
  const r=await connection.getMultipleAccountsInfoAndContext(addresses,{commitment:'confirmed',minContextSlot:c.slot});
  if(!Number.isSafeInteger(r.context?.slot)||r.context.slot<c.slot)throw Error('Fee snapshot unavailable: stale context');
  if(r.value.some(x=>!x))throw Error('Fee provisioning unavailable: required account missing');
  const info=r.value;
  if(!info[0].owner.equals(program))invalid('state owner');
  const fees=client.decodeFeeState(info[0].data,campaign);
  function token(i,mint,owner){
   const t=unpackAccount(addresses[i],info[i],client.TOKEN_PROGRAM);
   if(!t.mint.equals(mint)||!t.owner.equals(owner)||!t.isInitialized||t.isFrozen||t.delegate||t.closeAuthority)invalid('token custody');
   return t.amount;
  }
  const childBalance=token(1,c.terms.childMint,authority),solBalance=token(2,client.WSOL,authority);
  const liability=fees.solCollected-fees.treasuryPaid-fees.devPaid;
  if(liability<0n||childBalance<fees.coinPending||solBalance<liability)invalid('custody liability');
  if(fees.parentAllocated.some(x=>x!==0n)||fees.parentSpent.some(x=>x!==0n))invalid('Standard parent counters');
  const d=info[3].data;
  if(!info[3].owner.equals(c.terms.lockProgram)||d.length!==256||!d.subarray(0,8).equals(disc('LockedCpLiquidityState')))invalid('lock layout');
  for(const [offset,key]of [[64,a.pool],[96,a.feeNft],[128,a.authority],[160,a.lpMint]])if(!new PublicKey(d.subarray(offset,offset+32)).equals(key))invalid('lock identity');
  const lockedLp=d.readBigUInt64LE(8),lockBalance=token(4,a.lpMint,a.lockAuthority);
  if(lockedLp<=0n||lockedLp>lockBalance||token(8,a.feeNft,campaign)!==1n)invalid('locked position');
  const p=info[5].data;
  if(!info[5].owner.equals(c.terms.ammProgram)||p.length!==637||!p.subarray(0,8).equals(disc('PoolState')))invalid('pool layout');
  for(const [i,key]of [[0,c.terms.ammConfig],[1,a.authority],[2,a.vault0],[3,a.vault1],[4,a.lpMint],[5,a.mint0],[6,a.mint1],[7,client.TOKEN_PROGRAM],[8,client.TOKEN_PROGRAM]])if(!new PublicKey(p.subarray(8+32*i,40+32*i)).equals(key))invalid('pool identity');
  if(p[329]!==0||p[390]!==0)invalid('pool policy');
  const net=(side,i,mint)=>token(i,mint,a.ammAuthority)-p.readBigUInt64LE(341+side*8)-p.readBigUInt64LE(357+side*8)-p.readBigUInt64LE(397+side*8);
  const reserve0=net(0,6,a.mint0),reserve1=net(1,7,a.mint1);
  const [coinReserve,solReserve]=a.mint0.equals(c.terms.childMint)?[reserve0,reserve1]:[reserve1,reserve0];
  if(coinReserve<=0n||solReserve<=0n)invalid('reserves');
  // Spot valuation only gates operational dust; it is not an oracle or swap quote.
  return {c,campaign,a,fees,stateAddress,lockedLp,slot:r.context.slot,coinValue:amount=>amount*solReserve/coinReserve};
 }
 async function payoutAccounts(s){
  const owners=[...new Map([s.c.terms.treasury,s.c.terms.dev].map(k=>[String(k),k])).values()];
  const addresses=owners.map(owner=>client.associatedTokenAddress(owner,client.WSOL));
  const response=await connection.getMultipleAccountsInfoAndContext(addresses,{commitment:'confirmed',minContextSlot:s.slot});
  if(!Number.isSafeInteger(response.context?.slot)||response.context.slot<s.slot||!Array.isArray(response.value)||response.value.length!==addresses.length)throw Error('Payout snapshot unavailable: stale or incomplete context');
  const missing=[];
  for(let i=0;i<addresses.length;i++){
   const info=response.value[i];
   if(!info){missing.push({owner:String(owners[i]),address:String(addresses[i]),mint:String(client.WSOL)});continue;}
   if(info.executable||!info.owner.equals(client.TOKEN_PROGRAM)||info.data.length!==165)invalid('payout account owner');
   const t=unpackAccount(addresses[i],info,client.TOKEN_PROGRAM);
   if(!t.owner.equals(owners[i])||!t.mint.equals(client.WSOL)||!t.isInitialized||t.isFrozen||!t.isNative||t.delegate||t.delegatedAmount!==0n||t.closeAuthority)invalid('payout token custody');
  }
  return missing;
 }
 async function previewHarvest(s,instruction){
  const block=await connection.getLatestBlockhash('confirmed');
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:keeper,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:UNITS['fee-harvest']}),instruction]}).compileToV0Message());
  const sim=await connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',minContextSlot:s.slot,accounts:{encoding:'base64',addresses:[s.stateAddress.toBase58()]}});
  if(!Number.isSafeInteger(sim.context?.slot)||sim.context.slot<s.slot)throw Error('Fee simulation unavailable: stale context');
  if(sim.value.err){
   // Raydium's explicit zero-trading-tokens refusal is the only suppressed error.
   if(sim.value.logs?.some(l=>/Error Code: ZeroTradingTokens\./.test(l)))return 0n;
   throw Error('Fee harvest simulation refused: '+JSON.stringify(sim.value.err));
  }
  const acc=sim.value.accounts?.[0];
  if(!acc||acc.owner!==program.toBase58()||acc.data?.[1]!=='base64')invalid('simulation state');
  const after=client.decodeFeeState(Buffer.from(acc.data[0],'base64'),s.campaign);
  // Burns may occur in the independent lane between snapshot and simulation.
  // Pending + burned is monotonic; pending alone would misclassify that as theft.
  const sol=after.solCollected-s.fees.solCollected,coin=after.coinPending+after.coinBurned-s.fees.coinPending-s.fees.coinBurned;
  if(sol<0n||coin<0n)invalid('simulation counters');
  return sol+s.coinValue(coin);
 }
 async function runFeeOperation(id,kind,options){
  if(!kinds.has(kind))throw Error('Invalid fee kind');
  const s=await snapshot(id);
  const operation=canonicalHash({genesisHash:id.genesisHash,programId:id.programId,campaign:id.campaign,operationId:options.operationId});
  const prior=await registry.operatorPackets.latest(operation);
  const build=()=>kind==='fee-harvest'?client.feesCollectInstruction(program,s.campaign,s.c.terms,s.c,keeper,s.lockedLp):kind==='distribution'?client.feesDistributeInstruction(program,s.campaign,s.c.terms,keeper):client.feesBurnChildInstruction(program,s.campaign,s.c.terms,keeper,s.fees.coinPending);
  // Always resume an existing packet BEFORE a zero/dust check. Its signed bytes
  // may still land; current counters alone cannot establish its outcome.
  if(!prior||['failed','expired'].includes(prior.status)){
   let value;
   if(kind==='fee-harvest')value=await previewHarvest(s,build());
   else if(kind==='distribution'){
    const entitled=feeEntitlements(s.fees.solCollected,s.c.terms.feeWeights);
    const treasury=entitled.treasury-s.fees.treasuryPaid,dev=entitled.dev-s.fees.devPaid;
    if(treasury<0n||dev<0n)invalid('entitlements');value=treasury+dev;
   }else value=s.coinValue(s.fees.coinPending);
   if(value<minValue)return {status:'deferred',reason:'Fees accumulating below economic threshold'};
   if(kind==='distribution'){
    const missing=await payoutAccounts(s);
    // An owner can repeatedly close a WSOL ATA and reclaim its rent. Never
    // automatically sponsor replacement: keep their entitlement in program
    // custody, expose the exact owner-funded repair, and revisit next cycle.
    if(missing.length)return {status:'deferred',reason:'Payout account needs owner-funded restoration',recovery:{action:'restore-wsol-account',accounts:missing}};
   }
  }
  return chain.send(()=>({instructions:[build()],facts:{kind},extraSigners:[]}),{...options,campaign:id.campaign,computeUnits:UNITS[kind],label:kind,intent:{action:kind,termsHash:s.c.termsHash}});
 }
 return {snapshot,runFeeOperation,signatureStatus:chain.signatureStatus};
}
