import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const SOURCE='https://github.com/raydium-io/raydium-cp-swap';
const COMMIT='59fb845a9e5bb569c8b2f3415f13b0c0ebcc6b92';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateCpmmProgramAccount(info){
 if(!info?.executable||info.owner.toBase58()!==LOADER||info.data.length!==36||info.data.readUInt32LE(0)!==2)throw Error('CPMM executable unavailable or malformed');
 return new PublicKey(info.data.subarray(4,36));
}
export function validateCpmmProgramData(info,manifest,fallbackBinary){
 if(manifest.network!=='localnet'||manifest.sourceRepository!==SOURCE||manifest.sourceCommit!==COMMIT||manifest.upgradeAuthority!==null||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw Error('CPMM source/deployment manifest does not match the pinned build');
 if(!info||info.executable||info.owner.toBase58()!==LOADER||info.data.length<45||info.data.readUInt32LE(0)!==3||info.data[12]!==0)throw Error('Local CPMM must have valid immutable ProgramData');
 let size=manifest.binarySize;
 if(size===undefined){
  if(!Buffer.isBuffer(fallbackBinary)||hash(fallbackBinary)!==manifest.sha256)throw Error('Legacy manifest requires a matching local SBF binary');
  size=fallbackBinary.length;
 }
 if(!Number.isSafeInteger(size)||size<4||size>info.data.length-45)throw Error('Invalid CPMM binary size');
 const binary=info.data.subarray(45,45+size);
 if(binary[0]!==0x7f||binary.subarray(1,4).toString()!=='ELF'||hash(binary)!==manifest.sha256)throw Error('Deployed CPMM binary hash mismatch');
 if(info.data.subarray(45+size).some(byte=>byte!==0))throw Error('Unexpected nonzero CPMM deployment padding');
 return size;
}
