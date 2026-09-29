import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {nextProgramManifest} from './program-lineage.mjs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Connection} from '@solana/web3.js';
import {directory,key,bin} from './setup.mjs';
const rpc='http://127.0.0.1:19099',connection=new Connection(rpc,'confirmed'),genesisHash=await connection.getGenesisHash();
const admin=key('admin'),program=key('atomic-launch-program-key'),out=directory+'/atomic-launch-build';mkdirSync(out,{recursive:true});
if((await connection.getBalance(new (await import('@solana/web3.js')).PublicKey(admin.address)))<20000000000){const signature=await connection.requestAirdrop(new (await import('@solana/web3.js')).PublicKey(admin.address),100000000000);await connection.confirmTransaction(signature,'confirmed');}
const manifest=fileURLToPath(new URL('../programs/atomic-launch/Cargo.toml',import.meta.url));
execFileSync(bin+'/cargo-build-sbf',['--manifest-path',manifest,'--sbf-out-dir',out],{stdio:'inherit'});
const binary=out+'/kids_atomic_launch.so',bytes=readFileSync(binary),sha256=createHash('sha256').update(bytes).digest('hex');
execFileSync(bin+'/solana',['program','deploy',binary,'--program-id','atomic-launch-program-key.json','--keypair','admin.json','--url',rpc],{cwd:directory,stdio:'inherit'});
const info=JSON.parse(execFileSync(bin+'/solana',['program','show',program.address,'--url',rpc,'--output','json'],{encoding:'utf8'}));
const manifestPath=directory+'/atomic-launch-program.json',previous=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):null;
const result=nextProgramManifest(previous,{network:'localnet',rpcUrl:rpc,genesisHash,programId:program.address,upgradeAuthority:info.authority??null,sha256,binarySize:bytes.length,source:'programs/atomic-launch/src/lib.rs',status:'local-development-only'});
writeFileSync(manifestPath,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));
