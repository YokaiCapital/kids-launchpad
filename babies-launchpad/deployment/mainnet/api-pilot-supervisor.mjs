// Pilot API service (KIDS_ROLE=api-pilot): the public-launch API and its authenticated gateway, on its own service and
// volume, beside the existing coin's service. It runs no legacy keeper, provisions no legacy campaign and holds no
// operator key: the version-3 workers and signer own every job. The API proves the release manifest before serving.
import {mkdirSync,existsSync,readFileSync} from 'node:fs';import {spawn} from 'node:child_process';
const required=['KIDS_NETWORK','KIDS_HELIUS_RPC_URL','KIDS_RPC_URL','KIDS_REGISTRY_URL','KIDS_RELEASE_MANIFEST','KIDS_PUBLIC_PILOT_WALLET','KIDS_MINT_ENCRYPTION_KEY','KIDS_PINATA_JWT','KIDS_CSRF_SECRET','KIDS_BACKEND_TOKEN','KIDS_GATEWAY_INTERNAL_TOKEN','KIDS_OPERATOR_BACKEND_TOKEN'];
for(const name of required)if(!process.env[name])throw Error(name+' is required for the pilot API');
if(process.env.KIDS_NETWORK==='localnet')throw Error('The pilot API runs on devnet or mainnet');
if(process.env.KIDS_CREATOR_FLOW!=='hosted')throw Error('KIDS_CREATOR_FLOW=hosted is required for the pilot API');
for(const name of Object.keys(process.env))if(/^KIDS_(?:OPERATOR_KEY|SIGNER_KEY|SIGNER_URL|SIGNER_TOKEN|SIGNER_PUBKEY|ALLOW_LOCAL_OPERATOR_KEY|DRILL)/.test(name))throw Error(name+' must not be set on the pilot API');
if(process.platform!=='linux'||!readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>line.split(' ')[4]==='/data'))throw Error('A dedicated persistent volume must be mounted at /data');
mkdirSync('/data/localnet',{recursive:true,mode:0o700});mkdirSync('/data/protocol',{recursive:true,mode:0o700});
if(!existsSync('interaction-review/staging/gateway.mjs'))throw Error('Authenticated gateway not installed; refusing public listener');
const env={...process.env,KIDS_BACKGROUND_SERVICES:'0',KIDS_ADMIN_PLUGIN:'0',KIDS_CLOUD:'1'};
const children=new Set();let stopping=false;
function stop(code){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.exit(code);},35000).unref();process.exitCode=code;}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stop(0));
function start(args){const child=spawn(process.execPath,args,{stdio:'inherit',env});children.add(child);child.on('error',error=>{console.error('spawn failed',error.code);stop(1);});child.on('exit',(code,signal)=>{children.delete(child);if(!stopping){console.error(JSON.stringify({event:'pilot-child-exited',code,signal}));stop(code??1);}});return child;}
start(['interaction-review/server/runtime.mjs']);
let ready=false;for(let i=0;i<240;i++){try{const r=await fetch('http://127.0.0.1:4175/_health/ready');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
if(!ready){stop(1);throw Error('Pilot API listener not ready');}
console.log(JSON.stringify({event:'pilot-api-ready'}));
start(['interaction-review/staging/gateway.mjs']);
