// Per-campaign Standard trades reuse the existing wallet-owned CPMM wire format.
// No operator key is involved. Durable wallet packets are shared across replicas.
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {unpackAccount,unpackMint,getAssociatedTokenAddressSync} from '@solana/spl-token';
import * as client from '../protocol-v2/client.mjs';
import {decodePool,decodeConfig} from '../cpmm.mjs';
import {tradeMath,validSlippageBps,buildExternalTrade,validateSignedTrade} from '../trade-packet.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
import {walletDenied,DENIED_MESSAGE} from '../../shared/denylist.mjs';
import {admittedConnection} from '../jobs/admission.mjs';
const fail=publicMessage=>{throw Object.assign(Error(publicMessage),{publicMessage});};
const shown=p=>({intentId:p.id,owner:p.owner,campaignId:p.campaignId,...p.prepared,status:p.status,signature:p.signature,error:p.error});
const terminal=s=>['confirmed','finalized','failed','expired','cancelled'].includes(s);
export function createPublicTradeService({registry,connection,genesisHash,programId,walletService,enabled=false,admit=null,now=Date.now}){
 if(enabled&&typeof admit!=='function')throw Error('Trading needs explicit shared RPC admission');
 connection=admittedConnection(connection,admit??(async()=>{throw Error('Trading RPC admission is not configured');}));
 if(registry?.driver!=='postgres'||!walletService?.status||!walletService?.cancel)throw Error('Shared registry and wallet recovery required');
 const program=new PublicKey(programId),genesis=new PublicKey(genesisHash).toBase58();
 async function network(){if(await connection.getGenesisHash()!==genesis)fail('Network identity changed; no trade was sent');}
 async function rowFor(id){const r=await registry.campaigns.get(id);if(!r||r.genesisHash!==genesis||r.programId!==String(program)||r.campaignVersion!==3||r.mode!=='standard')fail('This coin is not available for trading on this service');return r;}
 async function owned(owner,id){const p=await registry.walletPackets.get(id);if(!p||p.owner!==owner||p.prepared.action!=='trade')fail('Trade not found');await rowFor(p.campaignId);return p;}
 async function read(owner,row,wrapped){
  const campaign=new PublicKey(row.campaign),wallet=new PublicKey(owner);
  const first=await connection.getAccountInfoAndContext(campaign,'confirmed'),account=first?.value;
  if(!Number.isSafeInteger(first?.context?.slot)||first.context.slot<1||!account||account.executable||!account.owner.equals(program))fail('Verified coin data is unavailable');
  const decoded=client.decodeCampaign(account.data),{terms:t,state:s}=decoded;
  if(s.phase!==3||t.mode!==0||t.genesis!==client.keyHex(genesis)||!client.campaignAddress(program,t.creator,t.nonce).equals(campaign)||!t.ammProgram.equals(client.RAYDIUM_CPMM)||row.termsHash&&row.termsHash!==s.termsHash)fail('Live coin identity does not match');
  const tier=client.AMM_CONFIG_TIERS.find(x=>x.address.equals(t.ammConfig)&&x.tradeFeeRate===t.ammTradeFeeRate&&x.index===t.ammConfigIndex);
  if(!tier||t.creatorFeeEnabled!==0)fail('Pool fee policy is not supported');
  const p={...client.cpmmAddresses(t.ammProgram,t.ammConfig,t.childMint),config:t.ammConfig},child=getAssociatedTokenAddressSync(t.childMint,wallet);
  if(!s.pool.equals(p.pool)||wrapped.equals(wallet)||wrapped.equals(child)||wrapped.equals(t.childMint)||!PublicKey.isOnCurve(wrapped.toBytes()))fail('Trade account identity does not match');
  const reply=await connection.getMultipleAccountsInfoAndContext([p.pool,p.config,p.vault0,p.vault1,t.childMint,child,wrapped,SYSVAR_CLOCK_PUBKEY],{commitment:'confirmed',minContextSlot:first.context.slot});
  if(!Number.isSafeInteger(reply?.context?.slot)||reply.context.slot<first.context.slot||reply.value?.length!==8)fail('Consistent pool data is unavailable');
  const [pool,config,v0,v1,mintInfo,held,temporary,clock]=reply.value;
  const state=decodePool(pool,t.ammProgram,p),fee=decodeConfig(config,t.ammProgram);
  if(pool.executable||config.executable||!state.config.equals(p.config)||!state.creator.equals(client.launchAuthority(program,campaign))||!state.program0.equals(client.TOKEN_PROGRAM)||!state.program1.equals(client.TOKEN_PROGRAM)||(state.status&4)!==0||state.creatorFeesEnabled||fee.disabled||fee.index!==t.ammConfigIndex||fee.trade!==t.ammTradeFeeRate||fee.protocol!==120000n||fee.fund!==40000n)fail('Pool configuration changed');
  if(!clock||clock.data.length<40||clock.data.readBigInt64LE(32)<pool.data.readBigUInt64LE(373))fail('Pool is not open for swaps');
  if(temporary!==null)fail('Temporary trade account is already in use');
  const mint=unpackMint(t.childMint,mintInfo,client.TOKEN_PROGRAM);
  if(mintInfo.executable||!mint.isInitialized||mint.decimals!==t.decimals||mint.mintAuthority||mint.freezeAuthority)fail('Coin mint does not match launch terms');
  const vaults=[v0,v1].map((info,i)=>{const v=unpackAccount(i?p.vault1:p.vault0,info,client.TOKEN_PROGRAM);if(info.executable||info.data.length!==165||!v.isInitialized||v.isFrozen||!v.owner.equals(p.authority)||!v.mint.equals(i?p.mint1:p.mint0))fail('Pool reserve identity changed');return v.amount;});
  const reserves=vaults.map((value,i)=>value-pool.data.readBigUInt64LE(341+8*i)-pool.data.readBigUInt64LE(357+8*i)-pool.data.readBigUInt64LE(397+8*i));
  if(reserves.some(v=>v<=0n))fail('Pool reserves are unavailable');
  let balance=0n;if(held){const v=unpackAccount(child,held,client.TOKEN_PROGRAM);if(!v.isInitialized||v.isFrozen||!v.owner.equals(wallet)||!v.mint.equals(t.childMint))fail('Wallet token account is unavailable');balance=v.amount;}
  return {t,p,reserves,balance,held:!!held,slot:reply.context.slot};
 }
 async function prepare(owner,input){
  if(!enabled)fail('Coin trading is not enabled');if(walletDenied(owner))fail(DENIED_MESSAGE);
  const wallet=new PublicKey(owner),wrapped=new PublicKey(input.wrappedAccount);
  if(!['buy','sell'].includes(input.side)||!validSlippageBps(input.slippageBps)||typeof input.amountRaw!=='string'||!(/^[1-9][0-9]{0,19}$/).test(input.amountRaw)||BigInt(input.amountRaw)>18446744073709551615n||!(/^[A-Za-z0-9_.:-]{1,128}$/).test(input.requestId??''))fail('Enter a valid trade amount and slippage');
  const row=await rowFor(input.campaignId),id=[genesis,String(program),row.campaign].join(':'),descriptor=JSON.stringify({action:'trade',side:input.side,amountRaw:input.amountRaw,slippageBps:input.slippageBps,wrappedAccount:String(wrapped)});
  const prior=await registry.walletPackets.find(owner,id,input.requestId);if(prior){if(prior.descriptor!==descriptor)fail('Request ID already belongs to another trade');return shown(prior);}
  await network();const v=await read(owner,row,wrapped),forward=v.p.mint0.equals(input.side==='buy'?client.WSOL:v.t.childMint),amount=BigInt(input.amountRaw);
  if(input.side==='sell'&&amount>v.balance)fail('Insufficient coin balance');
  const math=tradeMath(amount,v.reserves[forward?0:1],v.reserves[forward?1:0],input.slippageBps,v.t.ammTradeFeeRate);
  const rent=await connection.getMinimumBalanceForRentExemption(165,'confirmed');if(!Number.isSafeInteger(rent)||rent<0||rent>10000000)fail('Token account rent is unavailable');
  const q={action:'trade',owner,campaign:row.campaign,genesisHash:genesis,programId:String(program),mint:String(v.t.childMint),pool:String(v.p.pool),side:input.side,inputRaw:input.amountRaw,outputRaw:String(math.output),minOutputRaw:String(math.minimum),feeRaw:String(math.fee),slippageBps:input.slippageBps,tradeFeeRate:String(v.t.ammTradeFeeRate),decimalsIn:input.side==='buy'?9:v.t.decimals,decimalsOut:input.side==='buy'?v.t.decimals:9,wrappedAccount:String(wrapped),rentLamports:String(rent),observedSlot:v.slot,expiresAt:now()+30000};
  const tx=buildExternalTrade(q,{state:{mint:v.t.childMint},p:v.p},wrapped,rent),block=await connection.getLatestBlockhash('confirmed');tx.feePayer=wallet;tx.recentBlockhash=block.blockhash;
  const fee=await connection.getFeeForMessage(tx.compileMessage(),'confirmed'),balance=await connection.getBalance(wallet,'confirmed');
  if(!Number.isSafeInteger(fee?.value)||fee.value<0||!Number.isSafeInteger(balance)||balance<0)fail('Wallet balance or network fee is unavailable');
  const needed=(input.side==='buy'?amount:0n)+BigInt(rent*(v.held?1:2))+BigInt(fee.value)+100000n;if(BigInt(balance)<needed)fail('Insufficient SOL for the trade, refundable account rent and network fees');
  if(now()>=q.expiresAt)fail('Quote expired while preparing; try again');
  return shown(await registry.walletPackets.prepare({owner,campaignId:id,requestKey:input.requestId,descriptor,prepared:{...q,...block,feeLamports:String(fee.value),maxPriorityFeeLamports:'100000',unsignedTransactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64')}}));
 }
 async function submit(owner,{intentId,signedTransactionBase64}){
  if(!enabled)fail('Coin trading is not enabled');if(walletDenied(owner))fail(DENIED_MESSAGE);
  let p=await owned(owner,intentId);await network();if(terminal(p.status))return shown(p);
  if(!p.signature&&now()>=p.prepared.expiresAt)fail('Quote expired; cancel it and request a new quote');
  if(typeof signedTransactionBase64!=='string'||signedTransactionBase64.length>1700)fail('Invalid signed trade');
  const tx=validateSignedTrade(signedTransactionBase64,p.prepared.unsignedTransactionBase64,owner,p.prepared.wrappedAccount),wire=Buffer.from(tx.serialize());if(wire.length>1232)fail('Trade exceeds the network packet limit');
  const signature=encodeBase58(tx.signatures[0]);p=await registry.walletPackets.sign({id:p.id,owner,signedBase64:wire.toString('base64'),signature});
  // Signed outcomes outlive quote expiry. Recovery rebroadcasts only identical
  // bytes; it never asks the wallet to create a second trade automatically.
  try{const sent=await connection.sendRawTransaction(wire,{skipPreflight:false,maxRetries:0});if(sent!==signature)throw Error('RPC signature mismatch');await registry.walletPackets.progress(p.id,'submitted');}catch{await registry.walletPackets.progress(p.id,'unknown');}
  try{await admit({cost:8});return await walletService.status(owner,{intentId});}catch{return shown(await registry.walletPackets.get(intentId));}
 }
 async function status(owner,input){await owned(owner,input.intentId);await admit({cost:8});return walletService.status(owner,input);}
 async function resume(owner,input){
  if(!enabled)fail('Coin trading is not enabled');
  const p=await owned(owner,input.intentId);
  if(!p.signature)return shown(p);
  const result=await status(owner,input);if(terminal(result.status))return result;
  // The wallet may have reloaded after approving. Recover only the durable
  // packet, never regenerate a quote or request another signature here.
  return submit(owner,{intentId:p.id,signedTransactionBase64:p.signedBase64});
 }
 return {prepare,submit,status,resume,async cancel(owner,input){await owned(owner,input.intentId);return walletService.cancel(owner,input);}};
}
