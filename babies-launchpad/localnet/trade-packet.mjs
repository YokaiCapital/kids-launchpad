// Shared wallet-owned CPMM packet primitives. No runtime files, operator keys,
// singleton intent store or network configuration are loaded by this module.
import {PublicKey,Transaction,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,ACCOUNT_SIZE,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createInitializeAccount3Instruction,createCloseAccountInstruction} from '@solana/spl-token';
import {swapInstruction} from './cpmm.mjs';
import {validateApprovedMessage} from '../shared/approved-message.mjs';
import {verifySignature} from '../shared/solana.mjs';
const CPMM=new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const SLIPPAGE_BPS={min:1,max:5000,default:1000};
export function validSlippageBps(bps){return Number.isInteger(bps)&&bps>=SLIPPAGE_BPS.min&&bps<=SLIPPAGE_BPS.max;}
/** `tradeRate` is the pool's trade fee in Raydium units (per 1,000,000: 20000 = 2 %, 25000 = 2.5 %), read from its config. */
export function tradeMath(amount,reserveIn,reserveOut,slippageBps,tradeRate=20000n){
 if(typeof amount!=='bigint'||amount<=0n||amount>18446744073709551615n||reserveIn<=0n||reserveOut<=0n)throw Error('Invalid raw trade amount or reserves');
 if(!validSlippageBps(slippageBps))throw Error('Slippage must be between 0.01 % and 50 %');
 if(typeof tradeRate!=='bigint'||tradeRate<=0n||tradeRate>=1000000n)throw Error('Invalid pool trade rate');
 const fee=(amount*tradeRate+999999n)/1000000n,net=amount-fee,output=net*reserveOut/(reserveIn+net),minimum=output*BigInt(10000-slippageBps)/10000n;
 if(net<=0n||minimum<=0n)throw Error('Trade too small');return{fee,output,minimum};
}
export function buildExternalTrade(i,{state,p},wrappedAccount,rent){
 const owner=new PublicKey(i.owner),wrapped=new PublicKey(wrappedAccount),amount=BigInt(i.inputRaw),child=getAssociatedTokenAddressSync(state.mint,owner);
 if(wrapped.equals(owner)||wrapped.equals(child)||wrapped.equals(state.mint)||!PublicKey.isOnCurve(wrapped.toBytes()))throw Error('A distinct ephemeral signing account is required');
 const funding=BigInt(rent)+(i.side==='buy'?amount:0n);if(!Number.isSafeInteger(rent)||rent<0||funding>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Trade funding exceeds safe range');
 const tx=new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner,child,owner,state.mint),SystemProgram.createAccount({fromPubkey:owner,newAccountPubkey:wrapped,lamports:Number(funding),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeAccount3Instruction(wrapped,NATIVE_MINT,owner));
 const instruction=swapInstruction({programId:CPMM,ammConfig:p.config},p,owner,i.side==='buy'?NATIVE_MINT:state.mint,amount,BigInt(i.minOutputRaw));instruction.keys[i.side==='buy'?4:5].pubkey=wrapped;
 tx.add(instruction,createCloseAccountInstruction(wrapped,owner,owner));return tx;
}
export function validateSignedTrade(raw,unsigned,owner,wrappedAccount){
 if(typeof raw!=='string'||raw.length>8000)throw Error('Signed trade transaction required');
 const tx=VersionedTransaction.deserialize(Buffer.from(raw,'base64')),approved=VersionedTransaction.deserialize(Buffer.from(unsigned,'base64'));
 validateApprovedMessage(tx.message,approved.message);
 const keys=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(k=>k.toBase58());
 if(keys.length!==2||keys[0]!==owner||keys[1]!==wrappedAccount||!keys.every((key,i)=>verifySignature(key,tx.message.serialize(),tx.signatures[i])))throw Error('Both wallet and temporary account must sign the approved trade');
 return tx;
}
