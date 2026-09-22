// Dedicated remote LOCALNET only. Agave RPC listens on wildcard: isolate this
// service in its own Railway project and expose only the authenticated gateway.
import {mkdirSync,existsSync,readFileSync,writeFileSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../localnet/package.json',import.meta.url));
const {Keypair}=require('@solana/web3.js');
const runtime='/data/localnet',ledger=runtime+'/ledger-agave3';
if(process.env.KIDS_REMOTE_LOCALNET!=='1')throw Error('Explicit isolated staging mode required');
if(process.platform!=='linux'||!readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>line.split(' ')[4]==='/data'))throw Error('A dedicated persistent volume must be mounted at /data');
mkdirSync(runtime,{recursive:true,mode:0o700});mkdirSync('/data/protocol',{recursive:true,mode:0o700});
for(const name of['admin','alice','bob','atomic-launch-program-key']){const file=runtime+'/'+name+'.json';if(!existsSync(file)){const key=Keypair.generate();writeFileSync(file,JSON.stringify([...key.secretKey]),{mode:0o600,flag:'wx'});}}
const pub=name=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(runtime+'/'+name+'.json')))).publicKey.toBase58();
const fresh=!existsSync(ledger+'/genesis.bin')&&!existsSync(ledger+'/genesis.tar.bz2');
const args=['--ledger',ledger,'--rpc-port','19099','--faucet-port','19901','--gossip-port','19101','--dynamic-port-range','19102-19135','--bind-address','127.0.0.1','--limit-ledger-size','1000000','--quiet'];
if(fresh){
 args.push('--url','https://api.mainnet-beta.solana.com');
 // Fresh genesis only: the existing hosted ledger keeps its clones. Jupiter v6 is cloned so a new environment can rehearse aggregator buybacks.
 for(const id of['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C','LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE','metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s','JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'])args.push('--clone-upgradeable-program',id);
 for(const id of['2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5','DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'])args.push('--clone',id);
 args.push('--upgradeable-program',pub('atomic-launch-program-key'),'/opt/kids/kids_atomic_launch.so',pub('admin'));
}
const children=new Set(),validators=new Set();let stopping=false;
function finishDrain(){if(stopping&&![...children].some(c=>!validators.has(c)))for(const c of validators)c.kill('SIGTERM');}
function stop(code){if(stopping)return;stopping=true;for(const c of children)if(!validators.has(c))c.kill('SIGTERM');finishDrain();setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.exit(code);},35000).unref();process.exitCode=code;}
for(const signal of['SIGTERM','SIGINT'])process.on(signal,()=>stop(0));
function validatorLogTail(args){const at=args.indexOf('--ledger');if(at<0)return;const file=args[at+1]+'/validator.log';let fd;try{fd=openSync(file,'r');const size=fstatSync(fd).size;const b=Buffer.alloc(Math.min(size,4096));readSync(fd,b,0,b.length,Math.max(0,size-b.length));console.error('Validator log tail:',b.toString('utf8'));}catch(error){console.error('Validator log unavailable',error.code);}finally{if(fd!==undefined)closeSync(fd);}}
function start(command,args){const child=spawn(command,args,{stdio:'inherit'});children.add(child);if(command.endsWith('/solana-test-validator'))validators.add(child);child.on('error',error=>{console.error('Staging process spawn failed',command,error.code);stop(1);});child.on('exit',(code,signal)=>{children.delete(child);validators.delete(child);if(stopping)finishDrain();if(!stopping){console.error('Staging process exited',command,{code,signal});if(command.endsWith('/solana-test-validator'))validatorLogTail(args);stop(code||1);}});return child;}
const validator=start(process.env.SOLANA_BIN+'/solana-test-validator',args);
start(process.env.SOLANA_BIN+'/solana-test-validator',['--ledger',runtime+'/legacy-ledger-agave3','--rpc-port','18999','--faucet-port','19900','--gossip-port','19001','--dynamic-port-range','19002-19030','--bind-address','127.0.0.1','--limit-ledger-size','1000000','--quiet']);
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['deployment/railway/bootstrap.mjs'],{stdio:'inherit'});children.add(child);child.once('error',reject);child.once('exit',(code,signal)=>{children.delete(child);code===0?resolve():reject(Error('Staging qualification failed: exit='+code+' signal='+signal));});}).catch(e=>{stop(1);throw e;});
if(!stopping){
 if(!existsSync('interaction-review/staging/gateway.mjs')){stop(1);throw Error('Authenticated gateway not installed; refusing public listener');}
 start('flock',['--nonblock','--no-fork',runtime+'/api-writer.lock',process.execPath,'interaction-review/server/runtime.mjs']);
 let ready=false;for(let i=0;i<60;i++){try{const r=await fetch('http://127.0.0.1:4175/_health/ready');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
 if(!ready){stop(1);throw Error('Internal API listener not ready');}
 start(process.execPath,['interaction-review/staging/gateway.mjs']);
}
