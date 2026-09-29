// Hosted version-3 policy signer (Railway service kids-signer-v3, KIDS_ROLE=signer-v3). One process owns one durable
// state volume. It proves the release manifest against the ledger and the shared registry before listening, signs only
// under per-campaign capabilities with the campaign's operating budget held first, and never prints a key or an RPC URL.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Connection,Keypair,PublicKey} from '@solana/web3.js';
import {PostgresRegistry,REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {loadReleaseManifest,verifyReleaseManifest} from '../hosted/release-manifest.mjs';
import {endpointUrl} from '../jobs/service.mjs';
import {boundedRpcFetch} from '../rpc-transport.mjs';
import {createRegistrySignerService} from './registry-service.mjs';
import {createOperatingSignerBudget} from './operating-budget.mjs';
import {createStandardOperatingCostReader} from './standard-cost-reader.mjs';
import {createSignerRpcChannel} from './rpc-admission.mjs';
import {loadOperatingFundingPacket} from '../creation/operating-reserve.mjs';
import {ensureSchema} from '../hosted/schema-boot.mjs';
const key=/^[A-Za-z0-9_.:-]{1,128}$/;
/** The shared registry must be PostgreSQL on the private network or over TLS, never loopback, never a file. */
export function registryUrl(value){
 let u;try{u=new URL(value);}catch{throw Error('registry endpoint is not a URL');}
 if(!['postgres:','postgresql:'].includes(u.protocol))throw Error('Hosted registry must be a PostgreSQL URL');
 if(['127.0.0.1','localhost','::1','[::1]',''].includes(u.hostname))throw Error('Hosted registry endpoint must not be loopback');
 if(!/\.(railway\.internal|internal)$/i.test(u.hostname)&&!/sslmode=(require|verify-ca|verify-full)/.test(u.search))throw Error('Hosted registry must use a private-network hostname or TLS');
 return value;
}
/** Validates the private, secret-free signer config file (listener, RPC admission partition, fee operator, policy). */
export function validateSignerConfig(raw){
 if(!raw||typeof raw!=='object')throw Error('Signer config must be an object');
 const listen=raw.listen??{};const host=listen.host??'::',port=listen.port??4177;
 if(typeof host!=='string'||!host||!Number.isInteger(port)||port<1||port>65535)throw Error('Signer listener must name a host and a port');
 const a=raw.rpcAdmission;
 if(!a||typeof a.resource!=='string'||!key.test(a.resource)||!Number.isInteger(a.ratePerSecond)||!Number.isInteger(a.burst))throw Error('Signer config needs an explicit shared RPC admission partition');
 const policy=raw.policy??'creator-funded-v1';if(!key.test(policy))throw Error('Invalid operating policy');
 if(raw.feeOperator!==undefined&&new PublicKey(raw.feeOperator).toBase58()!==raw.feeOperator)throw Error('Fee operator must be an address');
 for(const k of Object.keys(raw))if(!['listen','rpcAdmission','policy','feeOperator'].includes(k))throw Error('Unknown signer config key '+k);
 return {listen:{host,port},rpcAdmission:{resource:a.resource,ratePerSecond:a.ratePerSecond,burst:a.burst},policy,feeOperator:raw.feeOperator??null};
}
/** Reads a 64-byte secret key file (Solana CLI array format). The bytes are wiped from the buffer after the keypair exists. */
export function readSignerKey(path){
 const bytes=JSON.parse(readFileSync(path,'utf8'));
 if(!Array.isArray(bytes)||bytes.length!==64||bytes.some(b=>!Number.isInteger(b)||b<0||b>255))throw Error('Signer key file must hold a 64-byte secret key');
 const secret=Uint8Array.from(bytes);bytes.fill(0);
 // Keypair keeps the buffer it is given, so it gets its own copy; only the file bytes and the intermediate are wiped.
 try{return Keypair.fromSecretKey(Uint8Array.from(secret));}finally{secret.fill(0);}
}
/** Composes the hosted signer without listening. Injection points exist for tests; production passes none. */
export async function composeHostedSigner({env=process.env,registryFactory=url=>new PostgresRegistry({connectionString:url,max:4}),connectionFactory=url=>new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:boundedRpcFetch({timeoutMs:12000})}),readKey=readSignerKey,presetsBytes=null,log=line=>console.log(JSON.stringify(line))}={}){
 for(const name of ['KIDS_REGISTRY_URL','KIDS_RPC_URL','KIDS_RELEASE_MANIFEST','KIDS_SIGNER_TOKEN','KIDS_SIGNER_CONFIG','KIDS_SIGNER_KEY_FILE','KIDS_SIGNER_STATE_FILE'])if(!env[name])throw Error(name+' is required for the hosted signer');
 if(typeof env.KIDS_SIGNER_TOKEN!=='string'||env.KIDS_SIGNER_TOKEN.length<32)throw Error('KIDS_SIGNER_TOKEN must be at least 32 characters');
 registryUrl(env.KIDS_REGISTRY_URL);
 endpointUrl(env.KIDS_RPC_URL,{mode:'hosted',role:'RPC'});
 const config=validateSignerConfig(JSON.parse(readFileSync(env.KIDS_SIGNER_CONFIG,'utf8'))),manifest=loadReleaseManifest(env.KIDS_RELEASE_MANIFEST);
 if(manifest.network==='localnet')throw Error('Hosted signer refuses a localnet manifest');
 const keypair=readKey(env.KIDS_SIGNER_KEY_FILE),payer=keypair.publicKey.toBase58();
 if(manifest.signerPublicKey!==payer)throw Error('Signer key does not match the release manifest signer public key');
 const registry=registryFactory(env.KIDS_REGISTRY_URL);
 try{
  // The schema arrives from the migrating service (or from this one with KIDS_REGISTRY_MIGRATE=1); wait for it, bounded.
  await ensureSchema({registry,env,log});
  const schema=await registry.schemaVersion();
  if(schema!==REGISTRY_SCHEMA_VERSION)throw Error('Signer registry schema '+schema+' differs from this release ('+REGISTRY_SCHEMA_VERSION+')');
  const connection=connectionFactory(env.KIDS_RPC_URL);
  const release=await verifyReleaseManifest(manifest,{connection,presetsBytes:presetsBytes??readFileSync(new URL('../../'+manifest.presets.file,import.meta.url)),registrySchemaVersion:schema});
  const scope={genesisHash:manifest.genesisHash,programId:manifest.programId};
  const signerRpc=createSignerRpcChannel({registry,connection,...config.rpcAdmission});
  const feeOperator=config.feeOperator??payer;
  const budget=createOperatingSignerBudget({registry,connection:signerRpc.connection,...scope,payer,policy:config.policy,loadFundingPacket:loadOperatingFundingPacket(registry),loadCostIntent:createStandardOperatingCostReader({connection:signerRpc.connection,...scope,payer,feeOperator,treasury:manifest.treasury}),treasury:manifest.treasury});
  const service=await createRegistrySignerService({registry,connection,admitRpc:signerRpc.admit,...scope,programVersion:3,keypair,token:env.KIDS_SIGNER_TOKEN,stateFile:env.KIDS_SIGNER_STATE_FILE,operatingBudget:{reserve:x=>budget.reserve(x),recordSignature:(...x)=>budget.recordSignature(...x)},log,treasury:manifest.treasury});
  log({event:'signer-v3-composed',network:manifest.network,programId:manifest.programId,payer,treasury:manifest.treasury,feeOperator,policy:config.policy,checks:release.checks,listen:config.listen});
  return {service,registry,config,manifest,payer};
 }catch(error){await registry.close?.().catch(()=>{});throw error;}
}
export async function main(env=process.env){
 const {service,registry,config}=await composeHostedSigner({env});
 await new Promise((resolve,reject)=>{service.server.once('error',reject);service.server.listen(config.listen.port,config.listen.host,resolve);});
 console.log(JSON.stringify({event:'signer-v3-listening',host:config.listen.host,port:config.listen.port}));
 const stop=async()=>{try{await service.close();}finally{await registry.close?.().catch(()=>{});process.exit(0);}};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({event:'signer-v3-failed',reason:String(error.message).slice(0,300)}));process.exit(1);});
