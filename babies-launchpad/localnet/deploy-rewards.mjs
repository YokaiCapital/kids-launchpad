// Deploys only to this workspace's genesis-checked localnet. KIDS program logic is unchanged.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {directory,key,bin} from './setup.mjs';
import {readLocalConfig} from '../interaction-review/server/local-config.mjs';
import {rpc} from '../shared/solana.mjs';
const commit='aa1cfd9276375e44e57d1917d110ff095fb6d475',config=readLocalConfig();
if(config.network!=='localnet'||config.rpcUrl!=='http://127.0.0.1:18999'||await rpc(config.rpcUrl,'getGenesisHash')!==config.genesisHash)throw Error('Localnet identity mismatch');
const program=key('dev-vesting-program'),source=directory+'/rewards-source',out=directory+'/rewards-build';
const run=(cmd,args,options={})=>execFileSync(cmd,args,{stdio:'inherit',...options});
if(!existsSync(source))run('git',['clone','https://github.com/solana-foundation/rewards.git',source]);
run('git',['-C',source,'checkout',commit]);
const lib=source+'/program/src/lib.rs';let text=readFileSync(lib,'utf8');
text=text.replace(/declare_id!\("[^\"]+"\);/,`declare_id!("${program.address}");`);writeFileSync(lib,text);
mkdirSync(out,{recursive:true});
run(bin+'/cargo-build-sbf',['--manifest-path',source+'/program/Cargo.toml','--sbf-out-dir',out]);
const binary=out+'/rewards_program.so';
if(!(await rpc(config.rpcUrl,'getAccountInfo',[program.address])).value)
 run(bin+'/solana',['program','deploy',binary,'--program-id','dev-vesting-program.json','--keypair','admin.json','--url',config.rpcUrl,'--final'],{cwd:directory});
writeFileSync(directory+'/vesting-program.json',JSON.stringify({programId:program.address,genesisHash:config.genesisHash,sourceCommit:commit,localChange:'declare_id only; unchanged program logic',sha256:createHash('sha256').update(readFileSync(binary)).digest('hex')},null,2)+'\n',{mode:0o600});
console.log('Localnet vesting program ready: '+program.address);
