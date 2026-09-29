// Private localnet preparation only. This allocates identity and reserves stock;
// it does not mint, sign, transfer funds or advertise a campaign as open.
import {randomBytes} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {campaignAddress,launchAuthority} from '../protocol-v2/client.mjs';
import {createCreationStore} from './store.mjs';
import {canonicalHash} from '../registry/canonical.mjs';
import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {mintIntentHash} from './mint-packet.mjs';
import {creationMode,creationRpc} from './scope.mjs';

const key = /^[A-Za-z0-9_.:-]{1,128}$/;
const problem = code => Object.assign(Error('Creation preparation unavailable'), {code});
const asKey = value => new PublicKey(value).toBase58();
const view = r => r ? {
  requestId:r.request_id,genesisHash:r.genesis_hash,programId:r.program_id,programVersion:Number(r.program_version),
  campaign:r.campaign,nonce:r.nonce,authority:r.authority,state:r.state,
  mint:r.mint,leaseId:r.mint_lease_id,reason:r.reason,fundingEnabled:false,
} : null;

import {acceptedScope} from './accepted-scope.mjs';
export function createPreparationService({registry,connection,config,mintLeases}) {
  if (registry?.driver !== 'postgres') throw Error('Preparation requires shared PostgreSQL');
  if (!creationMode(config?.mode) || config.programVersion !== 3) throw Error('Preparation requires the isolated v3 local pilot');
  const u = new URL(config.rpcUrl);
  if (!creationRpc(u, config.mode) || connection.rpcEndpoint !== config.rpcUrl) throw Error('Preparation requires the configured loopback RPC of the rehearsal or the provider RPC of the hosted release');
  const genesisHash=asKey(config.genesisHash), programId=asKey(config.programId), pilot=asKey(config.pilotCreator);
  if (!/^[a-f0-9]{64}$/.test(config.policyHash||'') || !/^[a-f0-9]{64}$/.test(config.planHash||'')) throw Error('Preparation requires the reviewed policy and plan hashes');
  const policyHash=config.policyHash,planHash=config.planHash,treasury=config.treasury;
  const store=createCreationStore(registry),query=(sql,args=[])=>registry.query(sql,args);
  const raw=async id=>(await query('SELECT * FROM creation_preparations WHERE request_id=?',[id])).rows[0];
  const now=async()=>Number((await query('SELECT CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT) AS ms')).rows[0].ms);

  async function request(owner,draftId) {
    if (owner !== pilot || !key.test(draftId||'')) throw problem('CREATION_ACCESS');
    if (await registry.schemaVersion() !== REGISTRY_SCHEMA_VERSION) throw problem('CREATION_SCHEMA');
    if (await connection.getGenesisHash() !== genesisHash) throw problem('CREATION_NETWORK');
    const r=await store.status(owner,draftId),q=r?.body?.quote;
    // An accepted request is served under the policy it was quoted with (acceptedScope); identity must match this service.
    if (!r || r.state!=='accepted' || !acceptedScope({genesisHash,programId,treasury,policyHash,planHash},q) || q.terms?.mode!=='standard' || q.fundingEnabled!==false) throw problem('CREATION_SCOPE');
    return r;
  }

  const descriptor = r => canonicalHash({requestId:r.id,owner:r.owner,body:r.body,programVersion:3});
  function checked(row,r) {
    if (row && (row.descriptor_hash!==descriptor(r) || row.genesis_hash!==genesisHash || row.program_id!==programId || Number(row.program_version)!==3)) throw problem('IDEMPOTENCY_CONFLICT');
    if (row && (!/^(0|[1-9][0-9]{0,19})$/.test(row.nonce) || campaignAddress(programId,r.owner,row.nonce).toBase58()!==row.campaign || launchAuthority(programId,row.campaign).toBase58()!==row.authority)) throw problem('IDEMPOTENCY_CONFLICT');
    return row;
  }
  const matches=(lease,row,r)=>lease && lease.network===(config.network??'localnet') && lease.creator===r.owner && lease.draftId==='asset:'+r.id && lease.idempotencyKey==='asset:'+r.id && lease.programId===programId && lease.genesisHash===genesisHash && lease.campaign===row.campaign && (!row.mint || row.mint===lease.mint);
  const usable=(lease,row,r)=>lease?.state==='reserved'&&matches(lease,row,r);
  async function signingProgress(lease,row,r){
    if(!['signed-pending','consumed'].includes(lease?.state)||!matches(lease,row,r))return null;
    const sealed=(await query('SELECT * FROM creation_mint_plans WHERE request_id=?',[r.id])).rows[0];
    if(!sealed||sealed.owner!==r.owner||sealed.request_hash!==canonicalHash({requestId:r.id,owner:r.owner,body:r.body,preparation:row.descriptor_hash}))return null;
    const intent=JSON.parse(sealed.intent_json);
    if(mintIntentHash(intent)!==sealed.intent_hash||intent.requestId!==r.id||intent.leaseId!==row.mint_lease_id||intent.mint!==row.mint||intent.campaign!==row.campaign||intent.authority!==row.authority||intent.nonce!==row.nonce||intent.creator!==r.owner||intent.programId!==programId||intent.genesisHash!==genesisHash)return null;
    return lease.state==='consumed'?'mint-created':'mint-signing';
  }
  async function prepare(owner,{draftId}) {
    const r=await request(owner,draftId),lockKey='creation-preparation:'+r.id;
    // Commit the nonce first. A cross-store crash can then recover only this exact
    // inventory reservation; it cannot derive a new campaign on retry.
    await registry.transaction(async()=>{
      if (checked(await raw(r.id),r)) return;
      const nonce=String(randomBytes(8).readBigUInt64LE());
      const campaign=campaignAddress(programId,owner,nonce).toBase58(),authority=launchAuthority(programId,campaign).toBase58(),at=await now();
      await query("INSERT INTO creation_preparations(request_id,genesis_hash,program_id,program_version,campaign,nonce,authority,descriptor_hash,state,created_at,updated_at) VALUES(?,?,?,3,?,?,?,?,'allocated',?,?)",[r.id,genesisHash,programId,campaign,nonce,authority,descriptor(r),at,at]);
    },{lockKey});
    return registry.transaction(async()=>{
      const row=checked(await raw(r.id),r);
      if (row.state==='attention') return view(row);
      let lease=row.mint_lease_id?await registry.mintLeases.get(row.mint_lease_id):null;
      if (!row.mint_lease_id) {
        const result=await mintLeases.reserve({network:config.network??'localnet',genesisHash,programId,campaign:row.campaign,creator:owner,draftId:'asset:'+r.id,idempotencyKey:'asset:'+r.id});
        if (result.outcome==='no-stock') {
          await query('UPDATE creation_preparations SET reason=?,updated_at=? WHERE request_id=?',['waiting-for-mint',await now(),r.id]);
          return view(await raw(r.id));
        }
        if (!['reserved','existing'].includes(result.outcome)) throw problem('MINT_UNAVAILABLE');
        lease=await registry.mintLeases.get(result.lease.leaseId);
      }
      // A retry of preparation must preserve a separately sealed signing plan.
      // Unexplained signed/released/rebound stock still requires reconciliation.
      const progress=await signingProgress(lease,row,r);
      if(progress)return view({...row,reason:progress});
      if (!usable(lease,row,r)) {
        await query("UPDATE creation_preparations SET state='attention',reason='mint-needs-reconciliation',updated_at=? WHERE request_id=?",[await now(),r.id]);
        return view(await raw(r.id));
      }
      await query("UPDATE creation_preparations SET state='reserved',mint_lease_id=?,mint=?,reason=NULL,updated_at=? WHERE request_id=?",[lease.leaseId,lease.mint,await now(),r.id]);
      return view(await raw(r.id));
    },{lockKey});
  }
  return {prepare,async status(owner,{draftId}) {
    const r=await request(owner,draftId),row=checked(await raw(r.id),r);
    if(row?.state==='reserved'){
      const lease=await registry.mintLeases.get(row.mint_lease_id),progress=await signingProgress(lease,row,r);
      if(progress)return view({...row,reason:progress});
      if(!usable(lease,row,r))return view({...row,state:'attention',reason:'mint-needs-reconciliation'});
    }
    return view(row);
  }};
}
