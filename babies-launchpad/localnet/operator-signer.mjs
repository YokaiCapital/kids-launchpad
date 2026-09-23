// Operator signing: the keeper and the launch operator never hold the key when KIDS_SIGNER_URL is set; they send the
// transaction MESSAGE to the signing service and verify the returned signature before attaching it. Without the
// variable, the local admin keypair signs in-process (localnet). Read retries do not apply here: a signature request
// is not retried by this module; the operator sender's own journal decides whether to resend the same wire.
import {Keypair,PublicKey,VersionedTransaction} from '@solana/web3.js';
import {createPublicKey,verify} from 'node:crypto';
import {operatorKeypair} from './operator-key.mjs';
const spki=pk=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(pk.toBytes())]),format:'der',type:'spki'});
export const messageBytes=tx=>tx instanceof VersionedTransaction?Buffer.from(tx.message.serialize()):tx.serializeMessage();
export function createLocalSigner(keypair){
 if(!(keypair instanceof Keypair))throw Error('Local signer needs a keypair');
 return {kind:'local',publicKey:keypair.publicKey,async sign(tx,_options={}){if(tx instanceof VersionedTransaction)tx.sign([keypair]);else tx.partialSign(keypair);return tx;}};
}
export function createRemoteSigner({url,token,publicKey,fetchImpl=globalThis.fetch,timeoutMs=10000}){
 if(typeof url!=='string'||!/^https?:\/\//.test(url))throw Error('Signer URL required');if(typeof token!=='string'||token.length<32)throw Error('Signer token must be at least 32 characters');
 const pk=new PublicKey(publicKey),endpoint=url.replace(/\/$/,'')+'/sign';
 return {kind:'remote',publicKey:pk,async sign(tx,{operationId=null}={}){
  const message=messageBytes(tx);
  const r=await fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({message:message.toString('base64'),...(operationId?{operationId}:{})}),signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok)throw Error('Signer refused the request ('+r.status+')');
  const body=await r.json().catch(()=>null);const signature=Buffer.from(String(body?.signature??''),'base64');
  if(signature.length!==64||!verify(null,message,spki(pk),signature))throw Error('Signer returned an invalid signature');
  tx.addSignature(pk,signature);return tx;
 }};
}
/** Accepts a Keypair (tests, localnet) or a signer object. */
export const toSigner=value=>value instanceof Keypair?createLocalSigner(value):value;
export async function operatorSigner(env=process.env){
 if(env.KIDS_DRILL==='1'){const pk=new PublicKey(env.KIDS_SIGNER_PUBKEY);return {kind:'drill',publicKey:pk,async sign(){throw Error('Restore drill: signing is disabled on this service');}};}
 if(env.KIDS_SIGNER_URL){if(!env.KIDS_SIGNER_TOKEN||!env.KIDS_SIGNER_PUBKEY)throw Error('KIDS_SIGNER_TOKEN and KIDS_SIGNER_PUBKEY are required with KIDS_SIGNER_URL');return createRemoteSigner({url:env.KIDS_SIGNER_URL,token:env.KIDS_SIGNER_TOKEN,publicKey:env.KIDS_SIGNER_PUBKEY});}
 return createLocalSigner(await operatorKeypair(env));
}
