// Hosted release manifest: the exact chain identity a hosted worker, signer or API may serve.
// One committed file per release names the network, genesis, program, program bytes, sealed
// AMM tier, presets file and registry schema. Every hosted process verifies the manifest
// against the ledger and its own registry before doing any work and refuses to run on a
// mismatch. Nothing here reads keys or credentials.
import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
export const RELEASE_MANIFEST_VERSION=1;
export const RELEASE_NETWORKS=Object.freeze(['mainnet','devnet']);
const key=v=>{try{return new PublicKey(v).toBase58();}catch{throw Error('Release manifest field is not an address: '+String(v).slice(0,44));}};
const hex64=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function parseReleaseManifest(raw){
 if(raw?.version!==RELEASE_MANIFEST_VERSION)throw Error('Release manifest version must be '+RELEASE_MANIFEST_VERSION);
 if(!RELEASE_NETWORKS.includes(raw.network))throw Error('Release manifest network must be mainnet or devnet');
 if(raw.programVersion!==3)throw Error('Hosted public launches run program version 3 only');
 if(!hex64(raw.binarySha256)||!Number.isInteger(raw.binarySize)||raw.binarySize<=0)throw Error('Release manifest needs the program binary sha256 and size');
 if(!raw.ammConfig||!Number.isInteger(raw.ammConfig.index)||raw.ammConfig.index<0||!/^[0-9]{1,12}$/.test(String(raw.ammConfig.tradeFeeRate))||!hex64(raw.ammConfigHash))throw Error('Release manifest needs the sealed AMM config, its index, trade fee rate and account hash');
 if(!raw.presets||typeof raw.presets.file!=='string'||!/^[A-Za-z0-9_./-]{1,200}$/.test(raw.presets.file)||raw.presets.file.includes('..')||!hex64(raw.presets.sha256))throw Error('Release manifest needs the presets file and its sha256');
 if(!Number.isInteger(raw.registrySchemaVersion)||raw.registrySchemaVersion<1)throw Error('Release manifest needs the registry schema version');
 return Object.freeze({version:RELEASE_MANIFEST_VERSION,network:raw.network,genesisHash:key(raw.genesisHash),programId:key(raw.programId),programVersion:3,binarySha256:raw.binarySha256,binarySize:raw.binarySize,
  ammConfig:Object.freeze({address:key(raw.ammConfig.address),index:raw.ammConfig.index,tradeFeeRate:String(raw.ammConfig.tradeFeeRate)}),ammConfigHash:raw.ammConfigHash,
  presets:Object.freeze({file:raw.presets.file,sha256:raw.presets.sha256}),treasury:key(raw.treasury),signerPublicKey:key(raw.signerPublicKey),registrySchemaVersion:raw.registrySchemaVersion});
}
export function loadReleaseManifest(path){return parseReleaseManifest(JSON.parse(readFileSync(path,'utf8')));}
const mismatch=(check,detail)=>Object.assign(Error('Release manifest check failed: '+check+(detail?' ('+detail+')':'')),{code:'RELEASE_MISMATCH',check});
/** Verifies the manifest against the ledger (genesis, executable upgradeable program, exact program bytes with a zero
 * tail, sealed AMM config account hash), the presets file bytes and the registry schema. Throws RELEASE_MISMATCH. */
export async function verifyReleaseManifest(manifest,{connection,presetsBytes,registrySchemaVersion}){
 const m=parseReleaseManifest(manifest),checks={};
 const genesis=await connection.getGenesisHash();checks.genesis=genesis===m.genesisHash;if(!checks.genesis)throw mismatch('genesis');
 const program=await connection.getAccountInfo(new PublicKey(m.programId),'finalized');
 checks.program=!!program?.executable&&program.data.length>=36&&program.data.readUInt32LE(0)===2;if(!checks.program)throw mismatch('program','not an executable upgradeable program');
 const data=await connection.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');
 const bytes=data?.data?.length>=45+m.binarySize?data.data.subarray(45,45+m.binarySize):null;
 checks.binary=!!bytes&&createHash('sha256').update(bytes).digest('hex')===m.binarySha256&&data.data.subarray(45+m.binarySize).every(b=>b===0);if(!checks.binary)throw mismatch('binary');
 const config=await connection.getAccountInfo(new PublicKey(m.ammConfig.address),'finalized');
 checks.ammConfig=!!config&&createHash('sha256').update(config.data).digest('hex')===m.ammConfigHash;if(!checks.ammConfig)throw mismatch('amm-config');
 checks.presets=Buffer.isBuffer(presetsBytes)&&createHash('sha256').update(presetsBytes).digest('hex')===m.presets.sha256;if(!checks.presets)throw mismatch('presets');
 checks.registrySchema=registrySchemaVersion===m.registrySchemaVersion;if(!checks.registrySchema)throw mismatch('registry-schema',String(registrySchemaVersion)+' vs '+m.registrySchemaVersion);
 return Object.freeze({ok:true,manifest:m,checks:Object.freeze(checks)});
}
