import {admittedConnection} from '../jobs/admission.mjs';
import {publicIssuerVersion} from '../registry/issuer-version.mjs';
// New-role signer composition. One signer process owns its existing durable spend
// volume; this is NOT permission to replicate independent signer ledgers.
import {PublicKey} from '@solana/web3.js';
import {createSignerService} from '../signer-service.mjs';
import {loadCapabilities} from './capabilities.mjs';
import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {createCpiRentReader} from './cpi-costs.mjs';
import {decodeCampaign,campaignAddress,keyHex} from '../protocol-v2/client.mjs';
import {acquireSignerOwnership} from './ownership.mjs';
import {assertJournalCoverage} from './journal-coverage.mjs';
import {rehearsalSignerCapacity} from './rehearsal-capacity.mjs';
import {createPinnedLookupResolver} from './lookup-resolution.mjs';
export async function createRegistrySignerService({registry,connection,genesisHash,programId,programVersion=2,keypair,token,stateFile,log=()=>{},now=Date.now,operatingBudget=null,rehearsalCapacity,admitRpc=null,treasury=null}){
 // The platform treasury sealed into Standard campaigns: the release's treasury on a hosted signer (a cold key, never this
 // process), or this signer's own key only for a legacy local fixture that names none.
 const platformTreasury=treasury?new PublicKey(treasury).toBase58():keypair.publicKey.toBase58();
 if(registry?.driver!=='postgres'||typeof registry.capabilities?.authorizeLease!=='function'||typeof registry.capabilities?.latest!=='function')throw Error('Registry signer requires PostgreSQL lease authority and bounded grant lookup');
 if(await registry.schemaVersion()!==REGISTRY_SCHEMA_VERSION)throw Error('Signer registry schema differs from this release');
 if(typeof stateFile!=='string'||!stateFile)throw Error('Single-writer durable signer state file required');
 programVersion=publicIssuerVersion(programVersion);
 const capacity=rehearsalSignerCapacity(rehearsalCapacity,{programVersion,rpcUrl:connection.rpcEndpoint,genesisHash});
 if(programVersion===3&&(!operatingBudget||typeof operatingBudget.reserve!=='function'||typeof operatingBudget.recordSignature!=='function'))throw Error('V3 registry signer requires qualified campaign operating funding');
 if(programVersion===3){if(typeof admitRpc!=='function')throw Error('V3 registry signer requires shared RPC admission');connection=admittedConnection(connection,admitRpc);}
 const genesis=new PublicKey(genesisHash).toBase58(),program=new PublicKey(programId).toBase58();
 if(await connection.getGenesisHash()!==genesis)throw Error('Signer RPC genesis mismatch');
 const ownership=programVersion===3?await acquireSignerOwnership({registry,genesisHash:genesis,programId:program,payer:String(keypair.publicKey)}):null;
 try{
 if(programVersion===3)await assertJournalCoverage({registry,stateFile,genesisHash:genesis,programId:program,payer:String(keypair.publicKey),now});
 const capabilities=async({campaign}={})=>{
  let address;try{address=new PublicKey(campaign).toBase58();}catch{return new Map();}
  // LIMIT 1 over the scoped index, including revoked/expired newest grants.
  // Filtering those in SQL would silently resurrect a superseded permission.
  const latest=await registry.capabilities.latest({genesisHash:genesis,programId:program,campaign:address});
  if(latest?.kind==='fee-setup'){
   // A setup grant cannot choose its beneficiaries. Read the immutable on-chain
   // Standard terms before passing any recipients into the message policy.
   if(programVersion!==3||latest.programVersion!==3)return new Map();
   const account=await connection.getAccountInfo(new PublicKey(address),'finalized');
   if(!account||account.executable||String(account.owner)!==program)return new Map();
   const {terms}=decodeCampaign(account.data);
   const recipients=[...new Set([String(terms.treasury),String(terms.dev)])].sort();
   if(terms.mode!==0||terms.genesis!==keyHex(genesis)||String(terms.treasury)!==platformTreasury||!campaignAddress(program,terms.creator,terms.nonce).equals(new PublicKey(address))||JSON.stringify([...latest.recipients].sort())!==JSON.stringify(recipients))return new Map();
  }
  const source={capabilities:{list:async()=>latest?[latest]:[]}};
  const loaded=await loadCapabilities({registry:source,now});
  return new Map([...loaded.capabilities].filter(([,cap])=>cap.programVersion===programVersion));
 };
 const service=createSignerService({...capacity,capacityWaits:programVersion===3,keypair,token,programId:program,capabilities,stateFile,durableState:programVersion===3,
  // Lookup-table messages (v3 only): resolved from the pinned resolution of the durable packet the request names, proved on
  // this ledger at finalized commitment with a bounded read; never from the request, never unbounded (lookup-resolution.mjs).
  resolveLookups:programVersion===3?createPinnedLookupResolver({registry,connection,payer:String(keypair.publicKey)}):null,operatingBudget:programVersion===3?operatingBudget:null,
  readCpiRent:programVersion===3?createCpiRentReader({connection,genesisHash:genesis,now}):null,
  ownershipValid:ownership?()=>ownership.valid():null,requireCapability:true,requireOperationId:true,authorizeLease:input=>registry.capabilities.authorizeLease(input),now,log});
 let closing=null;
 service.close=()=>{if(closing)return closing;ownership?.stop();closing=(async()=>{if(service.server.listening)await new Promise((resolve,reject)=>service.server.close(e=>e?reject(e):resolve()));await ownership?.close();})();return closing;};
 // A raw server.close also disables signing. Explicit service.close additionally
 // awaits the durable ownership release before a replacement can start.
 service.server.once('close',()=>{ownership?.stop();ownership?.close().catch(()=>{});});
 return service;
 }catch(error){await ownership?.close().catch(()=>{});throw error;}
}
