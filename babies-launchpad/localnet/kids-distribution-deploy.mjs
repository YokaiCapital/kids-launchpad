// Localnet: build and deploy the kids-distribution program next to the launch program (same ledger, admin key pays).
import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {Connection,PublicKey} from '@solana/web3.js';import {nextProgramManifest} from './program-lineage.mjs';import {directory,key,bin} from './setup.mjs';
const rpc='http://127.0.0.1:19099',connection=new Connection(rpc,'confirmed'),genesisHash=await connection.getGenesisHash();
const admin=key('admin'),program=key('kids-distribution-program-key'),out=directory+'/kids-distribution-build';mkdirSync(out,{recursive:true});
if(await connection.getBalance(new PublicKey(admin.address))<5_000_000_000){const s=await connection.requestAirdrop(new PublicKey(admin.address),10_000_000_000);await connection.confirmTransaction(s,'confirmed');}
execFileSync(bin+'/cargo-build-sbf',['--manifest-path',fileURLToPath(new URL('../programs/kids-distribution/Cargo.toml',import.meta.url)),'--sbf-out-dir',out],{stdio:'inherit'});
const binary=out+'/kids_distribution.so',bytes=readFileSync(binary),sha256=createHash('sha256').update(bytes).digest('hex');
execFileSync(bin+'/solana',['program','deploy',binary,'--program-id','kids-distribution-program-key.json','--keypair','admin.json','--url',rpc],{cwd:directory,stdio:'inherit'});
const info=JSON.parse(execFileSync(bin+'/solana',['program','show',program.address,'--url',rpc,'--output','json'],{encoding:'utf8'}));
const manifestPath=directory+'/kids-distribution-program.json',previous=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):null;
const result=nextProgramManifest(previous,{network:'localnet',rpcUrl:rpc,genesisHash,programId:program.address,upgradeAuthority:info.authority??null,sha256,binarySize:bytes.length,source:'programs/kids-distribution/src/lib.rs',status:'local-development-only'});
writeFileSync(manifestPath,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));
