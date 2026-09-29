import {validateApprovedMessage} from '../../shared/approved-message.mjs';
import {Message,VersionedTransaction,TransactionMessage} from '@solana/web3.js';
// Keep the compiled message intact instead of rebuilding legacy account order.
export function decodeApprovedEscrow(bytes,{owner,programId,campaign,action}){
 const transaction=VersionedTransaction.deserialize(bytes),message=transaction.message;
 if(message.staticAccountKeys[0]?.toBase58()!==owner)throw Error('Transaction payer does not match your wallet.');
 if(message.addressTableLookups?.length)throw Error('Unexpected address lookup table in escrow transaction.');
 const instructions=TransactionMessage.decompile(message).instructions;
 const instruction=instructions[0],campaignIndex=action==='commit'?1:0,tag=action==='commit'?1:3;
 if(instructions.length!==1||instruction.programId.toBase58()!==programId||instruction.data[0]!==tag||instruction.keys[campaignIndex]?.pubkey.toBase58()!==campaign)throw Error('Transaction does not match the requested escrow action.');
 return transaction;
}
export function assertApprovedMessage(signed,approved){
 const bytes=signed.serialize(),received=VersionedTransaction.deserialize(bytes).message;
 validateApprovedMessage(received,Message.from(approved));
 return bytes;
}
