// Writes the committed release manifest and the secret-free service configs for one hosted release, from the chain and
// the program binary the owner deployed. It proves the deployed bytes equal the binary before writing. No keys, no
// credentials: the RPC URL is used and never printed.
//   node localnet/hosted/make-release.mjs --network mainnet --rpc <url> --program <id> --binary <path.so> --signer <pubkey> --treasury <address> [--amm-index 7] [--out deployment/hosted]
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Connection,PublicKey} from '@solana/web3.js';
import {AMM_CONFIG_TIERS} from '../protocol-v2/client.mjs';
import {REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
import {verifyReleaseManifest,RELEASE_MANIFEST_VERSION} from './release-manifest.mjs';
export const GENESIS=Object.freeze({mainnet:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',devnet:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'});
export const PRESETS_FILE='deployment/presets/public-presets-v1.json';
const LANES=['lifecycle','recovery','accounting','provisioning','harvest','economics'];
const sha=b=>createHash('sha256').update(b).digest('hex');
export function parseArgs(argv){const out={};for(let i=0;i<argv.length;i++){const a=argv[i];if(!a.startsWith('--'))throw Error('Unexpected argument '+a);const v=argv[i+1];if(v===undefined||v.startsWith('--'))throw Error('Missing value for '+a);out[a.slice(2)]=v;i++;}return out;}
const address=x=>{const k=new PublicKey(x).toBase58();if(k!==x)throw Error('Invalid address '+x);return k;};
/** The secret-free configs every hosted service reads; scope and signer come from the manifest so they cannot drift. */
export function serviceConfigs(manifest,{signerUrl='http://kids-signer-v3.railway.internal:4177',floorLamports='20000000',policy='creator-funded-v1'}={}){
 const policyFor=lane=>({ratePerSecond:10,burst:20,lanes:{[lane]:{ratePerSecond:10,burst:20}}});
 const configs={'signer-v3.json':{listen:{host:'::',port:4177},rpcAdmission:{resource:'signer-rpc',ratePerSecond:20,burst:40},policy,feeOperator:manifest.signerPublicKey}};
 for(const lane of LANES){
  const c={mode:'hosted',lane,programVersion:3,genesisHash:manifest.genesisHash,programId:manifest.programId,concurrency:2,rpcAdmission:{resource:'rpc-'+lane,policy:policyFor(lane)}};
  if(lane!=='accounting'){c.signer={url:signerUrl,publicKey:manifest.signerPublicKey};c.signerAdmission={resource:'signer-'+lane,policy:policyFor(lane)};}
  if(['lifecycle','recovery'].includes(lane))c.receiptBatchSize=4;
  if(lane==='accounting'||lane==='recovery')c.operating={payer:manifest.signerPublicKey,policy};
  if(lane==='lifecycle')c.lifecycle={setupHandoff:true,policy,minimumReserveLamports:floorLamports,refundAllowanceSeconds:86400,treasury:manifest.treasury};
  if(lane==='provisioning'){c.feeOperator=manifest.signerPublicKey;c.feeActivation={policy,minimumReserveLamports:floorLamports,treasury:manifest.treasury};}
  configs['worker-'+lane+'.json']=c;
 }
 configs['market-indexing.json']={mode:'hosted',lane:'indexing',programVersion:3,genesisHash:manifest.genesisHash,programId:manifest.programId,concurrency:2,rpcAdmission:{resource:'rpc-indexing',policy:policyFor('indexing')}};
 return configs;
}
export async function main(argv,{connectionFactory=url=>new Connection(url,'finalized'),root=new URL('../../',import.meta.url).pathname,stdout=process.stdout}={}){
 const a=parseArgs(argv);
 for(const k of ['network','rpc','program','binary','signer','treasury'])if(!a[k])throw Error('--'+k+' is required');
 if(!GENESIS[a.network])throw Error('--network must be mainnet or devnet');
 const tier=AMM_CONFIG_TIERS.find(t=>t.index===Number(a['amm-index']??7));if(!tier)throw Error('Unknown AMM config index');
 const connection=connectionFactory(a.rpc),genesisHash=await connection.getGenesisHash();
 if(genesisHash!==GENESIS[a.network])throw Error('The RPC answers for another network');
 const binary=readFileSync(a.binary),config=await connection.getAccountInfo(tier.address,'finalized');if(!config)throw Error('Sealed AMM config account not found');
 const presets=readFileSync(join(root,PRESETS_FILE));
 const manifest={version:RELEASE_MANIFEST_VERSION,network:a.network,genesisHash,programId:address(a.program),programVersion:3,binarySha256:sha(binary),binarySize:binary.length,ammConfig:{address:tier.address.toBase58(),index:tier.index,tradeFeeRate:String(tier.tradeFeeRate)},ammConfigHash:sha(config.data),presets:{file:PRESETS_FILE,sha256:sha(presets)},treasury:address(a.treasury),signerPublicKey:address(a.signer),registrySchemaVersion:REGISTRY_SCHEMA_VERSION};
 // A program deployed seconds ago is confirmed before it is finalized; the verification reads finalized state, so it is
 // retried for a bounded time instead of failing on the finality lag (any other mismatch fails at once).
 const waitMs=Number(a['wait-seconds']??120)*1000,started=Date.now();let result;
 for(;;){
  try{result=await verifyReleaseManifest(manifest,{connection,presetsBytes:presets,registrySchemaVersion:REGISTRY_SCHEMA_VERSION});break;}
  catch(error){if(error.code!=='RELEASE_MISMATCH'||!['program','binary'].includes(error.check)||Date.now()-started>waitMs)throw error;stdout.write(JSON.stringify({event:'waiting-for-finality',check:error.check})+'\n');await new Promise(r=>setTimeout(r,5000));}
 }
 const out=join(root,a.out??'deployment/hosted');mkdirSync(out,{recursive:true});
 const written=['release-'+a.network+'.json'];writeFileSync(join(out,written[0]),JSON.stringify(manifest,null,2)+'\n');
 for(const [name,config] of Object.entries(serviceConfigs(manifest))){writeFileSync(join(out,name),JSON.stringify(config,null,2)+'\n');written.push(name);}
 stdout.write(JSON.stringify({event:'release-written',network:a.network,programId:manifest.programId,binarySha256:manifest.binarySha256,binarySize:manifest.binarySize,checks:result.checks,files:written},null,2)+'\n');
 return {manifest,written};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exit(1);});
