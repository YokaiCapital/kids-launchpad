// Read-only cost evidence for a server-owned provisioning plan. No wallet or RPC
// parameters from an HTTP request are accepted here. This does not authorize funding.
import {PublicKey,Transaction,SystemProgram,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {quoteCampaignCosts,ACCOUNT_BYTES} from '../budgets.mjs';
import {decodeConfig} from '../cpmm.mjs';
import {RAYDIUM_CPMM,AMM_CONFIG_TIERS,ammConfigAddress} from '../protocol-v2/client.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
const decimal=n=>{if(!Number.isSafeInteger(n)||n<0)throw Error('Unusable RPC cost value');return BigInt(n);};
export async function readCreationCosts({connection,genesisHash,owner,ammConfig,counts,priorityFeeLamports,marginBps=1500}){
 const wallet=new PublicKey(owner),config=new PublicKey(ammConfig);
 const tier=AMM_CONFIG_TIERS.find(t=>t.address.equals(config));
 if(!tier||!ammConfigAddress(RAYDIUM_CPMM,tier.index).equals(config))throw Error('Unsupported setup AMM tier');
 // No default transaction/account counts: these must come from the actual server
 // planner, including auxiliary mint signatures and recipient/fee token accounts.
 for(const name of ['transactions','signatures','ataCreates','lockedPositions','feeStates'])if(!Number.isSafeInteger(counts?.[name])||counts[name]<0)throw Error('Complete setup cost counts required');
 if(counts.transactions<1||counts.signatures<counts.transactions||counts.feeStates!==1||counts.lockedPositions!==1||counts.ataCreates<1)throw Error('Incomplete Standard setup cost plan');
 if(typeof priorityFeeLamports!=='string'||!/^(0|[1-9][0-9]{0,8})$/.test(priorityFeeLamports))throw Error('Explicit bounded priority fee cap required');
 if(await connection.getGenesisHash()!==genesisHash)throw Error('Setup quote network mismatch');
 const reply=await connection.getMultipleAccountsInfoAndContext([config,SYSVAR_CLOCK_PUBKEY],{commitment:'confirmed'});
 const [account,clock]=reply.value;const fee=decodeConfig(account,RAYDIUM_CPMM);
 if(!Number.isSafeInteger(reply.context.slot)||reply.context.slot<1||!clock||clock.data.length!==40)throw Error('Setup clock unavailable');
 // The config's optional creator rate is inactive for standard initialize. The
 // launch program separately enforces enable_creator_fee=0 on the created pool.
 if(fee.disabled||fee.index!==tier.index||fee.trade!==tier.tradeFeeRate||fee.protocol!==120000n||fee.fund!==40000n)throw Error('Setup AMM policy changed');
 const rentByBytes={};
 await Promise.all([...new Set(Object.values(ACCOUNT_BYTES))].map(async bytes=>{rentByBytes[bytes]=String(decimal(await connection.getMinimumBalanceForRentExemption(bytes,'confirmed')));}));
 const latest=await connection.getLatestBlockhash({commitment:'confirmed',minContextSlot:reply.context.slot});
 // One-signature, zero-transfer message measures the cluster's base signature fee.
 // No signature is requested and no transaction is sent.
 const message=new Transaction({feePayer:wallet,...latest}).add(SystemProgram.transfer({fromPubkey:wallet,toPubkey:wallet,lamports:0})).compileMessage();
 const quotedFee=await connection.getFeeForMessage(message,'confirmed');
 if(quotedFee.value==null||!Number.isSafeInteger(quotedFee.context?.slot)||quotedFee.context.slot<reply.context.slot)throw Error('Setup network fee unavailable');
 const base=decimal(quotedFee.value);
 if(await connection.getGenesisHash()!==genesisHash)throw Error('Setup quote network changed');
 const costs=quoteCampaignCosts({live:{ammCreationFeeLamports:fee.creationFee,baseFeeLamports:base,priorityFeeLamports:BigInt(priorityFeeLamports)},counts,marginBps,rent:bytes=>BigInt(rentByBytes[bytes])});
 const serial=JSON.parse(JSON.stringify(costs,(_,v)=>typeof v==='bigint'?String(v):v));
 return {costs:serial,evidence:{genesisHash,ammConfig:config.toBase58(),ammConfigHash:canonicalHash({owner:account.owner.toBase58(),data:account.data.toString('base64')}),slot:reply.context.slot,chainTimeUnix:String(clock.data.readBigInt64LE(32)),tradeFeeRate:String(fee.trade),baseSignatureFeeLamports:String(base),priorityFeeLamports,rentByBytes,counts:{...counts}},coverage:'bounded-setup-only'};
}
