// Builds programs/kids-launch-v2 for SBF with the `localnet-treasury` feature (the sealed platform treasury is the local
// key .runtime/v2-treasury.json, never the mainnet treasury) and deploys it to the v2 rehearsal ledger
// (start-v2-rehearsal.mjs, RPC 19199). Writes .runtime/kids-launch-v2-program.json for the end-to-end test. Never
// deploys anywhere but a loopback RPC. Mirrors atomic-launch-deploy.mjs.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Connection,PublicKey} from '@solana/web3.js';
import {directory,key,bin} from './setup.mjs';
import {nextProgramManifest} from './program-lineage.mjs';
const rpc=process.env.KIDS_V2_RPC||'http://127.0.0.1:19199';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc))throw Error('kids-launch-v2 deploys to a loopback localnet only');
const connection=new Connection(rpc,'confirmed'),genesisHash=await connection.getGenesisHash();
const admin=key('v2-admin'),program=key('v2-program-key'),treasury=key('v2-treasury');
const treasuryHex=Buffer.from(new PublicKey(treasury.address).toBytes()).toString('hex');
const out=directory+'/kids-launch-v2-build';mkdirSync(out,{recursive:true});
if(await connection.getBalance(new PublicKey(admin.address))<20_000_000_000){const s=await connection.requestAirdrop(new PublicKey(admin.address),100_000_000_000);await connection.confirmTransaction(s,'confirmed');}
const manifestPath=fileURLToPath(new URL('../programs/kids-launch-v2/Cargo.toml',import.meta.url));
const build=spawnSync(bin+'/cargo-build-sbf',['--manifest-path',manifestPath,'--sbf-out-dir',out,'--','--features','localnet-treasury'],{env:{...process.env,KIDS_LOCALNET_TREASURY_HEX:treasuryHex},encoding:'utf8',maxBuffer:64*1024*1024});
if(build.status!==0)throw Error('cargo-build-sbf failed:\n'+(build.stderr||'').slice(-4000));
const buildLog=(build.stdout||'')+'\n'+(build.stderr||'');process.stderr.write(build.stderr||'');
// The SBF linker reports a function whose frame exceeds the 4 KiB stack ("overflows the maximum allowed frame space",
// "overwrites values in the frame") but still links; such a function is undefined behaviour at run time, so a build
// that reports one is never deployed. The (empty) list is recorded with the deployment.
const frameWarnings=[...new Set(buildLog.split('\n').filter(l=>/overwrites values in the frame|overflows the maximum allowed frame space/.test(l)).map(l=>(/(?:in method|Function) (\S+)/.exec(l)||[])[1]||l.trim()))];
if(frameWarnings.length)throw Error('cargo-build-sbf reported a stack frame overflow in: '+frameWarnings.join(', ')+'. Split the function before deploying.');
const binary=out+'/kids_launch_v2.so',bytes=readFileSync(binary),sha256=createHash('sha256').update(bytes).digest('hex');
execFileSync(bin+'/solana',['program','deploy',binary,'--program-id','v2-program-key.json','--keypair','v2-admin.json','--url',rpc,'--commitment','confirmed'],{cwd:directory,stdio:'inherit'});
const info=JSON.parse(execFileSync(bin+'/solana',['program','show',program.address,'--url',rpc,'--output','json'],{encoding:'utf8'}));
const path=directory+'/kids-launch-v2-program.json',previous=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
const result={...nextProgramManifest(previous,{network:'localnet',rpcUrl:rpc,genesisHash,programId:program.address,upgradeAuthority:info.authority??null,sha256,binarySize:bytes.length,source:'programs/kids-launch-v2/src/lib.rs',status:'local-development-only'}),features:['localnet-treasury'],treasury:treasury.address,treasuryKeyFile:treasury.path,adminKeyFile:admin.path,stackFrameWarnings:frameWarnings};
writeFileSync(path,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));
