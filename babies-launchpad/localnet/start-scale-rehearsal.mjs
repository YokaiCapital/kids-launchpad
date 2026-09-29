// Separate capacity ledger. Never resets or reconfigures the existing rehearsals.
// The 2.5% AMM account must be an explicitly supplied canonical public account dump.
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Connection,PublicKey} from '@solana/web3.js';
import {directory,bin} from './setup.mjs';
import {AMM_CONFIG_TIERS,RAYDIUM_CPMM} from './protocol-v2/client.mjs';
const RPC='http://127.0.0.1:19499',LEDGER=directory+'/scale-ledger';
export function validateScaleConfigDump(dump){
 const tier=AMM_CONFIG_TIERS.find(x=>x.tradeFeeRate===25000n),a=dump?.account,data=Buffer.from(a?.data?.[0]??'','base64');
 const [address,bump]=PublicKey.findProgramAddressSync([Buffer.from('amm_config'),Buffer.from([0,tier.index])],RAYDIUM_CPMM);
 const discriminator=createHash('sha256').update('account:AmmConfig').digest().subarray(0,8);
 if(dump.pubkey!==String(tier.address)||!address.equals(tier.address)||a.owner!==String(RAYDIUM_CPMM)||a.executable!==false||a.data[1]!=='base64'||data.length!==236||!data.subarray(0,8).equals(discriminator)||data[8]!==bump||data[9]!==0||data.readUInt16LE(10)!==tier.index||data.readBigUInt64LE(12)!==25000n||data.readBigUInt64LE(20)!==120000n||data.readBigUInt64LE(28)!==40000n)throw Error('Canonical 2.5% config differs');
 return createHash('sha256').update(data).digest('hex');
}
export async function requireUnusedScalePort(port=19499){
 return new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();reject(Error('Capacity RPC port is already occupied'));});socket.once('timeout',()=>{socket.destroy();reject(Error('Capacity port availability is unknown'));});socket.once('error',e=>{socket.destroy();if(e.code==='ECONNREFUSED')resolve();else reject(Error('Capacity port availability is unknown'));});});
}
export async function main(env=process.env){
 const source=JSON.parse(readFileSync(directory+'/kids-launch-v3-program.json','utf8'));
 if(source.network!=='localnet'||source.programVersion!==3||source.rpcUrl!=='http://127.0.0.1:19199')throw Error('Owned v3 source ledger required');
 const upstream=new Connection(source.rpcUrl,{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(2000)})});if(await upstream.getGenesisHash()!==source.genesisHash)throw Error('Source genesis differs');
 const tier=AMM_CONFIG_TIERS.find(x=>x.tradeFeeRate===25000n),file=env.KIDS_SCALE_AMM_CONFIG_FILE;if(!file)throw Error('Canonical 2.5% AMM dump required');
 const configHash=validateScaleConfigDump(JSON.parse(readFileSync(file,'utf8')));
 await requireUnusedScalePort();
 const args=['--ledger',LEDGER,'--rpc-port','19499','--faucet-port','19903','--gossip-port','19601','--dynamic-port-range','19602-19635','--bind-address','127.0.0.1','--limit-ledger-size','1000000','--quiet'];
 if(!existsSync(LEDGER+'/genesis.bin')&&!existsSync(LEDGER+'/genesis.tar.bz2')){
  args.push('--url',source.rpcUrl,'--account',String(tier.address),file);
  for(const id of [source.programId,String(RAYDIUM_CPMM),'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE','metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'])args.push('--clone-upgradeable-program',id);
  for(const id of ['DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8',source.pilotCreator,source.treasury])args.push('--clone',id);
 }
 const validator=spawn(bin+'/solana-test-validator',args,{stdio:'inherit'});let ended=false;const done=new Promise(resolve=>{validator.once('error',()=>{ended=true;resolve(1);});validator.once('exit',code=>{ended=true;resolve(code);});});
 const stop=()=>validator.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  const c=new Connection(RPC,{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(2000)})});let genesis=null;
  for(let n=0;n<120&&!ended;n++){try{genesis=await c.getGenesisHash();break;}catch{await new Promise(r=>setTimeout(r,500));}}
  if(!genesis)throw Error('Capacity validator did not start');
  const actual=await c.getAccountInfo(tier.address,'finalized');if(!actual||createHash('sha256').update(actual.data).digest('hex')!==configHash)throw Error('Capacity AMM clone differs');
  const program=await c.getAccountInfo(new PublicKey(source.programId),'finalized');if(!program?.executable||program.data.readUInt32LE(0)!==2)throw Error('Capacity program unavailable');
  const executable=await c.getAccountInfo(new PublicKey(program.data.subarray(4,36)),'finalized');if(!executable||createHash('sha256').update(executable.data.subarray(45,45+source.binarySize)).digest('hex')!==source.sha256)throw Error('Capacity program binary differs');
  writeFileSync(directory+'/kids-scale-v3-program.json',JSON.stringify({...source,rpcUrl:RPC,genesisHash:genesis,scaleQualification:true,ammConfig:String(tier.address),ammConfigHash:configHash},null,2),{mode:0o600});
  console.log(JSON.stringify({event:'scale-ledger-ready',rpcUrl:RPC,genesisHash:genesis,programId:source.programId,tradeFeeBps:250}));
  const code=await done;if(code)throw Error('Capacity validator exited');
 }catch(e){stop();await done.catch(()=>{});throw e;}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Isolated capacity validator failed');process.exitCode=1;});
