import {withLaunchPolicy} from './launch-policy.mjs';
import {mkdirSync,existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {generateKeypair,encodeBase58,rpc} from '../shared/solana.mjs';

export const directory=fileURLToPath(new URL('./.runtime/',import.meta.url));
export const rpcUrl='http://127.0.0.1:18999';
export const configPath=directory+'/config.json';
export const bin=process.env.SOLANA_BIN||homedir()+'/.local/share/solana/install/active_release/bin';
mkdirSync(directory,{recursive:true,mode:0o700});
export function key(name){
 const path=directory+'/'+name+'.json';
 if(!existsSync(path)){const generated=generateKeypair();writeFileSync(path,JSON.stringify([...generated.secretKey]),{mode:0o600,flag:'wx'});generated.secretKey.fill(0);generated.seed.fill(0);}
 chmodSync(path,0o600);
 const bytes=JSON.parse(readFileSync(path,'utf8'));return {path,address:encodeBase58(bytes.slice(32))};
}
export function cli(program,args){return execFileSync(bin+'/'+program,args.map(arg=>arg.startsWith(directory)?arg.slice(directory.length).replace(/^\//,''):arg),{cwd:directory,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});}
export async function setup(){
 await rpc(rpcUrl,'getHealth');
 const genesis=await rpc(rpcUrl,'getGenesisHash');
 const admin=key('admin'),alice=key('alice'),bob=key('bob');
 const cliConfig=directory+'/solana.yml';
 writeFileSync(cliConfig,`json_rpc_url: ${rpcUrl}\nwebsocket_url: ws://127.0.0.1:19000\nkeypair_path: admin.json\ncommitment: finalized\n`,{mode:0o600});
 for(const wallet of [admin,alice,bob]){
  const balance=(await rpc(rpcUrl,'getBalance',[wallet.address])).value;
  if(balance<1000e9)cli('solana',['--url',rpcUrl,'airdrop','2000',wallet.address]);
 }
 const mints={};
 for(const name of ['KIDS','FARTCOIN','BUTTCOIN','SHART']){
  const mint=key('mint-'+name);mints[name]=mint.address;
  if(!(await rpc(rpcUrl,'getAccountInfo',[mint.address,{commitment:'confirmed'}])).value)cli('spl-token',['--config',cliConfig,'create-token','--decimals','6',mint.path]);
  const accounts=await rpc(rpcUrl,'getTokenAccountsByOwner',[admin.address,{mint:mint.address},{encoding:'jsonParsed',commitment:'confirmed'}]);
  if(!accounts.value.length)cli('spl-token',['--config',cliConfig,'create-account',mint.address]);
  const supply=await rpc(rpcUrl,'getTokenSupply',[mint.address,{commitment:'confirmed'}]);
  if(supply.value.amount==='0')cli('spl-token',['--config',cliConfig,'mint',mint.address,'1000000000']);
  if(name!=='SHART')for(const wallet of [alice,bob]){
   const existing=await rpc(rpcUrl,'getTokenAccountsByOwner',[wallet.address,{mint:mint.address},{encoding:'jsonParsed',commitment:'confirmed'}]);
   if(!existing.value.length)cli('spl-token',['--config',cliConfig,'transfer',mint.address,'1000000',wallet.address,'--fund-recipient','--allow-unfunded-recipient']);
  }
 }
 if(!existsSync(configPath))writeFileSync(configPath,JSON.stringify(withLaunchPolicy({version:1,network:'localnet',rpcUrl,genesisHash:genesis,admin:admin.address,wallets:{alice:alice.address,bob:bob.address},mints,launch:{poolUsd:200000,solUsd:200,capLamports:'500000000000',parentShareBps:1000,holderMinimumBps:5,commitmentsOpen:false},createdAt:new Date().toISOString()}),null,2)+'\n',{mode:0o600});
 const config=JSON.parse(readFileSync(configPath));
 if(config.genesisHash!==genesis)throw Error('Local ledger differs from configuration. Restore the original ledger before continuing.');
 console.log(JSON.stringify({network:'localnet',rpcUrl,admin:config.admin,mints:config.mints},null,2));
}
if(process.argv[1]===fileURLToPath(import.meta.url))await setup();
