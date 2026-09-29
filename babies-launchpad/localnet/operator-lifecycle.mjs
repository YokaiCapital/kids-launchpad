// Operator actions for one hosted Standard v3 campaign, each explicit and recorded in the shared registry: the initial
// keeper grant sized by the lifetime rule, lifecycle scheduling, the refund-only continuation after an expired window,
// the operating-return grant for a refunded campaign, and a status read. No key is used: the chain is read only.
//   node localnet/operator-lifecycle.mjs <status|grant-keeper|schedule|grant-refund|grant-return> --registry <postgres url> [--schema <search_path>] --rpc <url> --manifest <release.json> --campaign <address> [--hours N]
//   Inside a hosted container (deployment/hosted/pilot-operator.sh) --registry, --rpc and --manifest come from the environment.
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {Connection,PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from './registry/registry.mjs';
import {loadReleaseManifest} from './hosted/release-manifest.mjs';
import {createChainAdapter} from './protocol-v2/chain-adapter.mjs';
import {createLifecycleController} from './jobs/lifecycle.mjs';
import {createOperatingLedger} from './creation/operating-ledger.mjs';
import {launchFailed,campaignFailed,fundingOpen} from './protocol-v2/policy.mjs';
export const REFUND_ALLOWANCE_SECONDS=86400,GRANT_MARGIN_MS=3600000;
export function parseArgs(argv){const out={command:argv[0]};for(let i=1;i<argv.length;i++){const a=argv[i];if(!a.startsWith('--'))throw Error('Unexpected argument '+a);const v=argv[i+1];if(v===undefined||v.startsWith('--'))throw Error('Missing value for '+a);out[a.slice(2)]=v;i++;}return out;}
/** Expiry the initial keeper grant needs: past the launch window plus the refund allowance, with one hour of margin. */
export function keeperGrantExpiry({launchDeadline,chainNow,now=Date.now(),hours=null}){
 const required=now+Math.max(0,Number(BigInt(launchDeadline)-BigInt(chainNow)))*1000+REFUND_ALLOWANCE_SECONDS*1000+GRANT_MARGIN_MS;
 if(hours==null)return new Date(required).toISOString();
 const chosen=now+Number(hours)*3600000;if(!Number.isFinite(chosen)||chosen<required)throw Error('--hours must cover the launch window plus the refund allowance and margin');
 return new Date(chosen).toISOString();
}
export function createCampaignOperator({registry,connection,manifest,policy='creator-funded-v1',minimumReserveLamports='20000000',now=Date.now,chain=null}){
 if(registry?.driver!=='postgres')throw Error('Operator actions need the shared PostgreSQL registry');
 const payer=new PublicKey(manifest.signerPublicKey),scope={genesisHash:manifest.genesisHash,programId:manifest.programId};
 chain=chain??createChainAdapter({connection,programId:manifest.programId,genesisHash:manifest.genesisHash,commitment:'finalized',signer:{publicKey:payer,sign(){throw Error('Operator actions never sign');}}});
 const disabled=async()=>{throw Error('Operator actions never credit or spend');};
 const ledger=createOperatingLedger({registry,verifyFunding:disabled,verifyOutcome:disabled});
 const id=campaign=>({...scope,campaign:new PublicKey(campaign).toBase58()});
 return {
  async status(campaign){
   const i=id(campaign),c=await chain.readCampaign(i),chainNow=await chain.chainTime(),cap=await registry.capabilities.latest(i);
   const flow=(await registry.query('SELECT stage,initial_capability_id FROM standard_lifecycles WHERE genesis_hash=? AND program_id=? AND campaign=?',[i.genesisHash,i.programId,i.campaign])).rows[0]??null;
   const jobs=(await registry.query("SELECT job_class,state,count(*)::int n FROM jobs WHERE genesis_hash=? AND program_id=? AND campaign=? GROUP BY 1,2 ORDER BY 1,2",[i.genesisHash,i.programId,i.campaign])).rows;
   const budget=await ledger.balance({...i,payer:String(payer),policy});
   return {campaign:i.campaign,chain:{phase:c.phase,total:String(c.total),refunded:String(c.refunded),soft:String(c.soft),deadline:String(c.deadline),launchDeadline:String(c.launchDeadline),chainNow:String(chainNow),failed:campaignFailed(c,chainNow),fundingOpen:fundingOpen(c.phase,c.terms?.opensAt??0,c.deadline,chainNow),creator:String(c.terms.creator)},
    capability:cap?{capabilityId:cap.capabilityId,kind:cap.kind,tags:cap.tags,recipients:cap.recipients,expiresAt:cap.expiresAt,revokedAt:cap.revokedAt??null}:null,lifecycle:flow,jobs,budget};
  },
  async grantKeeper(campaign,{hours=null}={}){
   const i=id(campaign),c=await chain.readCampaign(i),chainNow=await chain.chainTime();
   // The sealed treasury is the platform treasury named by the release (never a server key); the keeper's payer is the
   // hosted signer. The isolated rehearsals had one key for both, the mainnet pilot does not (28 September 2026).
   if(String(c.terms.treasury)!==String(manifest.treasury))throw Error('The sealed treasury of this campaign is not the release treasury');
   const expiresAt=keeperGrantExpiry({launchDeadline:c.launchDeadline,chainNow,now:now(),hours});
   return registry.capabilities.grant({...i,programVersion:3,kind:'keeper',tags:[3,4,6],expiresAt});
  },
  async schedule(campaign){
   const i=id(campaign),cap=await registry.capabilities.latest(i);
   if(!cap||cap.kind!=='keeper')throw Error('Grant the initial keeper capability first');
   const controller=createLifecycleController({registry,chain,config:{mode:'hosted',network:manifest.network,setupHandoff:true,...scope,payer:String(payer),treasury:manifest.treasury,policy,minimumReserveLamports,refundAllowanceSeconds:REFUND_ALLOWANCE_SECONDS}});
   return controller.schedule(i,cap.capabilityId);
  },
  async grantRefund(campaign){
   const i=id(campaign),c=await chain.readCampaign(i),chainNow=await chain.chainTime();
   if(!campaignFailed(c,chainNow))throw Error('A refund-only continuation is for a failed campaign whose window closed');
   return registry.capabilities.grant({...i,programVersion:3,kind:'keeper',tags:[3],recipients:[],expiresAt:new Date(now()+7200000).toISOString()});
  },
  async grantReturn(campaign){
   const i=id(campaign),c=await chain.readCampaign(i),chainNow=await chain.chainTime();
   if(!campaignFailed(c,chainNow)||BigInt(c.refunded)!==BigInt(c.total))throw Error('The operating-return grant is for a fully refunded failed campaign');
   return registry.capabilities.grant({...i,programVersion:3,kind:'operating-return',tags:[],recipients:[String(c.terms.creator)],expiresAt:new Date(now()+7200000).toISOString()});
  },
 };
}
/** Flags win; inside a hosted container the registry, RPC and manifest come from the service environment. */
export function resolveArgs(argv,env={}){
 const a=parseArgs(argv);
 return {...a,registry:a.registry??env.KIDS_REGISTRY_URL,rpc:a.rpc??env.KIDS_RPC_URL,manifest:a.manifest??env.KIDS_RELEASE_MANIFEST};
}
export async function main(argv,{stdout=process.stdout,env=process.env}={}){
 const a=resolveArgs(argv,env),commands={status:'status','grant-keeper':'grantKeeper',schedule:'schedule','grant-refund':'grantRefund','grant-return':'grantReturn'};
 if(!commands[a.command])throw Error('Usage: status | grant-keeper | schedule | grant-refund | grant-return');
 for(const k of ['registry','rpc','manifest','campaign'])if(!a[k])throw Error('--'+k+' is required (or KIDS_REGISTRY_URL, KIDS_RPC_URL and KIDS_RELEASE_MANIFEST in the environment)');
 const pool=new pg.Pool({connectionString:a.registry,max:2,...(a.schema?{options:'-c search_path='+a.schema}:{})}),registry=new PostgresRegistry({pool});
 try{
  const operator=createCampaignOperator({registry,connection:new Connection(a.rpc,'finalized'),manifest:loadReleaseManifest(a.manifest)});
  const result=await operator[commands[a.command]](a.campaign,{hours:a.hours});stdout.write(JSON.stringify(result,null,2)+'\n');return result;
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exit(1);});
