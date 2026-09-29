// Trusted authorize adapter for the funding-first custody in the encrypted mint inventory
// (kids-mint-worker/vendor/.../mint-inventory.js fundingFirstLaunchSigner): the inventory co-signs the keeper's launch
// packet with the reserved mint and its fee-NFT key only when this adapter has rebuilt the packet independently from the
// finalized campaign record and extension, the campaign's durable table plan and the pinned lookup resolution, the launch
// job's active lease (the same fence the signer service applies) and, for a retry, the terminal previous attempt in the
// operator journal. The attempt is journaled BEFORE the custody co-signs (durable-send journal-first): this adapter signs only
// the journaled prepared message of the current attempt, and the lease is read last, on the database clock, after every
// asynchronous journal read; its remaining validity is carried into the inventory's synchronous guard so a delayed return
// never signs after expiry. A custody co-signature is not a broadcast authorization: the keeper signs after it, under the
// signer service's own lease check.
import {PublicKey,VersionedTransaction,TransactionMessage,ComputeBudgetProgram} from '@solana/web3.js';
import {createHash} from 'node:crypto';
import * as c from '../protocol-v2/client.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {launchFundingFirstInstruction,parseLaunchDisplayData,extAddress,decodeExt,displayHash,OFF_ACCOUNTING_VERSION,ACCOUNTING_VERSION_FUNDING_FIRST,LAUNCH_V2_TAG,LAUNCH_V2_ACCOUNTS} from '../protocol-v3/client.mjs';
import {resolvePinnedLookups} from '../signer/lookup-resolution.mjs';
import {readLookupTablePlan} from '../jobs/lookup-table-plan.mjs';
import {databaseIso} from '../registry/postgres-job-clock.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
// RPC and registry failures are dependencies whatever code the transport or database put on them (ECONNRESET, ETIMEDOUT,
// 57P01, -32016, CAPACITY_WAIT ...): the endpoint answers 503 and the worker retries. Only the adapter's own typed refusal
// (STALE_LEASE) is never a dependency; everything the adapter refuses itself is thrown outside this wrapper.
const dep=async p=>{try{return await p;}catch(e){if(e&&typeof e==='object'&&e.code!=='STALE_LEASE')e.dependency='failure';throw e;}};
export const LAUNCH_V2_OPERATION=campaign=>'launch-v2:'+campaign;
/** The one job whose lease may authorize a launch co-signature: the campaign's launch job, operation key 'launch'. */
export const LAUNCH_V2_JOB=Object.freeze({jobClass:'launch',operationKey:'launch'});
export function createFundingFirstCustody({inventory,registry,connection,genesisHash,programId,monotonicNow=()=>performance.now()}){
 if(typeof inventory?.fundingFirstLaunchSigner!=='function'||typeof inventory?.fundingFirstCustody!=='function'||!registry?.operatorPackets||typeof registry.query!=='function')throw Error('Funding-first custody needs the inventory and the PostgreSQL registry');
 const genesis=new PublicKey(genesisHash).toBase58(),program=new PublicKey(programId).toBase58(),programKey=new PublicKey(program);
 const sign=inventory.fundingFirstLaunchSigner(async input=>{
  const {mint,campaign,keeper,packet,packetRef,operationKey,fencingToken}=input;
  for(const [k,v] of [['campaign',campaign],['keeper',keeper]])if(typeof v!=='string'||new PublicKey(v).toBase58()!==v)throw Error('Launch custody needs a canonical '+k);
  if(typeof packet!=='string'||!packetRef||!Number.isSafeInteger(packetRef.attempt)||packetRef.attempt<1)throw Error('Launch custody needs the packet and its attempt');
  // The custody binding made at reservation names the campaign and the request; the launch must be for that campaign.
  const custody=inventory.fundingFirstCustody(mint);
  if(!custody||custody.genesisHash!==genesis||custody.programId!==program||custody.campaign!==campaign)throw Error('Mint custody is not bound to this campaign');
  // The attempt's durable identity: this campaign's launch operation, this attempt.
  if(packetRef.operationId!==canonicalHash({genesisHash:genesis,programId:program,campaign,operationId:LAUNCH_V2_OPERATION(campaign)}))throw Error('Launch packet reference is not this campaign\'s launch operation');
  const raw=Buffer.from(packet,'base64'),tx=VersionedTransaction.deserialize(raw);
  if(raw.length>1232||raw.toString('base64')!==packet||tx.version!==0||String(tx.message.staticAccountKeys[0])!==keeper)throw Error('Launch packet is not the keeper\'s v0 packet');
  // The campaign at finalized commitment: a version-2 record sealing this mint, whose extension names the fee NFT and the display.
  const campaignKey=new PublicKey(campaign),info=await dep(connection.getAccountInfo(campaignKey,'finalized'));
  if(!info||info.executable||!info.owner.equals(programKey)||info.data[OFF_ACCOUNTING_VERSION]!==ACCOUNTING_VERSION_FUNDING_FIRST)throw Error('Campaign is not a funding-first record');
  const {terms}=c.decodeCampaign(info.data);
  if(String(terms.childMint)!==mint||terms.genesis!==c.keyHex(genesis)||!c.campaignAddress(program,terms.creator,terms.nonce).equals(campaignKey))throw Error('Campaign does not seal this mint');
  const extInfo=await dep(connection.getAccountInfo(extAddress(program,campaignKey),'finalized'));
  if(!extInfo||extInfo.executable||!extInfo.owner.equals(programKey))throw Error('Funding-first extension unavailable');
  const ext=decodeExt(extInfo.data);
  if(ext.campaign!==campaign||ext.mint!==mint||ext.version!==ACCOUNTING_VERSION_FUNDING_FIRST||ext.feeNft!==custody.feeNft)throw Error('Extension differs from the custody binding');
  // The exact template through the campaign's planned table and the pinned resolution the keeper compiled with.
  const plan=await dep(readLookupTablePlan({registry,identity:{genesisHash:genesis,programId:program,campaign}}));
  if(!plan)throw Error('No lookup table plan for this campaign');
  if(plan.payer!==keeper)throw Error('Launch keeper is not the payer of the campaign\'s table plan');
  const {tables}=resolvePinnedLookups(tx.message,input.lookups??null);
  if(tables.length!==1||String(tables[0].key)!==plan.table)throw Error('Launch packet does not use the campaign\'s planned table');
  const decoded=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables});
  if(decoded.instructions.length!==2||!decoded.instructions[0].programId.equals(ComputeBudgetProgram.programId)||decoded.instructions[0].data[0]!==2)throw Error('Launch packet is not compute limit + launch');
  const units=Buffer.from(decoded.instructions[0].data).readUInt32LE(1),ix=decoded.instructions[1];
  if(!ix.programId.equals(programKey)||ix.data[0]!==LAUNCH_V2_TAG||ix.keys.length!==LAUNCH_V2_ACCOUNTS)throw Error('Launch packet is not a funding-first launch');
  const display=parseLaunchDisplayData(ix.data.subarray(1));
  if(display.uri!==terms.metadataUri||displayHash(display)!==ext.displayHash)throw Error('Launch display differs from the opening commitment');
  const expected=new TransactionMessage({payerKey:new PublicKey(keeper),recentBlockhash:tx.message.recentBlockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units}),launchFundingFirstInstruction(program,campaignKey,terms,keeper,ext.feeNft,display).instruction]}).compileToV0Message(tables);
  if(!Buffer.from(expected.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Launch packet differs from its independently rebuilt template');
  // Only the campaign's canonical launch job (class and operation key fixed here, never chosen by the caller) may authorize.
  if(operationKey!==LAUNCH_V2_JOB.operationKey||!Number.isSafeInteger(fencingToken)||fencingToken<1)throw Error('Launch custody is authorized by the campaign\'s launch job only');
  // The attempt is journaled first (durable-send): this request must present exactly the journaled prepared message of the
  // current attempt; the custody signatures are attached to that row afterwards.
  const current=await dep(registry.operatorPackets.get(packetRef.operationId,packetRef.attempt));
  if(!current||current.status!=='prepared'||!Buffer.from(VersionedTransaction.deserialize(Buffer.from(current.prepared.base64,'base64')).message.serialize()).equals(Buffer.from(tx.message.serialize())))throw Error('Launch attempt is not the journaled prepared attempt');
  const journaled=JSON.parse(current.descriptor);
  if(journaled.campaign!==campaign||journaled.payer!==keeper||journaled.operationKey!==LAUNCH_V2_JOB.operationKey||journaled.genesisHash!==genesis||journaled.programId!==program)throw Error('Launch attempt was journaled for another job, keeper or campaign');
  const latest=await dep(registry.operatorPackets.latest(packetRef.operationId));if(latest.attempt!==packetRef.attempt)throw Error('Launch attempt is not the current one');
  // A retry only after every earlier attempt is terminal in the journal (expired or failed); the custody chains on its own last
  // signed launch message (an attempt it never co-signed leaves no gap), so that hash is taken from the custody view.
  for(let n=1;n<packetRef.attempt;n++){const prior=await dep(registry.operatorPackets.get(packetRef.operationId,n));if(!prior||!['expired','failed'].includes(prior.status))throw Error('Previous launch attempt is not terminal');}
  const lastSigned=custody.signatures.filter(s=>s.step==='launch').at(-1),previousMessageSha256=lastSigned?.messageSha256;
  // The launch job's active lease, read LAST (after every asynchronous journal read) on the database clock, the same fence the
  // signer service applies: this token, leased, unexpired at database time. The remaining validity is measured once, from the
  // moment the query was sent (the database sampled its clock no earlier), so the round trip and any later delay each count
  // once; it is the synchronous guard the inventory runs immediately before it signs. A rotation or expiry after this read and
  // before the signature is caught there (expiry) or by the keeper's own signer-side lease check (rotation), never extended.
  const started=monotonicNow();
  const lease=(await dep(registry.query("SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS db_now_ms,lease_expires_at FROM jobs WHERE genesis_hash=? AND program_id=? AND campaign=? AND job_class=? AND operation_key=? AND state='leased' AND fencing_token=? AND lease_expires_at>"+databaseIso,[genesis,program,campaign,LAUNCH_V2_JOB.jobClass,LAUNCH_V2_JOB.operationKey,fencingToken]))).rows[0];
  if(!lease)throw Object.assign(Error('Launch job lease is not current'),{code:'STALE_LEASE'});
  const dbNow=Number(lease.db_now_ms),expiresAt=Date.parse(lease.lease_expires_at);
  if(!Number.isSafeInteger(dbNow)||!Number.isFinite(expiresAt))throw Error('Database lease time unavailable');
  const deadline=started+(expiresAt-dbNow);
  if(!(monotonicNow()<deadline))throw Object.assign(Error('Launch job lease is not current'),{code:'STALE_LEASE'});
  const assertActive=()=>{if(!(monotonicNow()<deadline))throw Object.assign(Error('Launch job lease expired before custody signing'),{code:'STALE_LEASE'});};
  return {mint,feeNft:ext.feeNft,keeper,genesisHash:genesis,programId:program,campaign,requestId:custody.requestId,packet,message:tx.message.serialize(),lookupTables:[plan.table],attempt:packetRef.attempt,previousMessageSha256,assertActive};
 });
 /** Co-signs the keeper's prepared launch packet (custody slots empty) and returns it with the mint and fee-NFT signatures. */
 return {async signLaunch(input){return sign(input);}};
}
