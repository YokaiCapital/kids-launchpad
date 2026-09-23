// Real-network service (KIDS_NETWORK=devnet|mainnet). Order: volume check, operator key from the service secret,
// program manifest verified against the chain and the recorded identities, campaign provisioning (idempotent),
// then the API with its keepers behind the authenticated gateway. Never prints a key or the RPC URL.
import {mkdirSync,existsSync,readFileSync,writeFileSync,statSync,unlinkSync} from 'node:fs';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';const require=createRequire(new URL('../../localnet/package.json',import.meta.url));const {Connection,Keypair,PublicKey}=require('@solana/web3.js');
const {networkProfile}=await import('../../localnet/network.mjs');const {nextProgramManifest}=await import('../../localnet/program-lineage.mjs');
if(process.env.KIDS_ROLE==='signer'){await import('./signer-supervisor.mjs');}else{
const profile=networkProfile();if(profile.network==='localnet')throw Error('This supervisor is for devnet or mainnet');
if(process.platform!=='linux'||!readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>line.split(' ')[4]==='/data'))throw Error('A dedicated persistent volume must be mounted at /data');
const runtime='/data/localnet';mkdirSync(runtime,{recursive:true,mode:0o700});mkdirSync('/data/protocol',{recursive:true,mode:0o700});
// Operator signatures (architecture audit, key isolation): on a real network the API holds NO operator key. It talks to
// the signer service; any key left on this volume by an earlier boot is wiped. Local mode exists for tests only.
const {resolveOperatorMode}=await import('./operator-mode.mjs');const mode=resolveOperatorMode(process.env);
if(mode.mode==='invalid')throw Error('Operator mode: '+mode.reason);
const keyFile=runtime+'/admin.json';
if(mode.mode==='signer'){
 if(existsSync(keyFile)){const size=statSync(keyFile).size;writeFileSync(keyFile,Buffer.alloc(size));unlinkSync(keyFile);console.log(JSON.stringify({event:'operator-key-wiped-from-volume'}));}
 for(const name of Object.keys(process.env))if(/^KIDS_OPERATOR_KEY/.test(name))delete process.env[name];
}else{
 if(!existsSync(keyFile)){const raw=process.env.KIDS_OPERATOR_KEY_JSON;if(!raw)throw Error('KIDS_OPERATOR_KEY_JSON is required on first boot in local mode');const bytes=JSON.parse(raw);if(!Array.isArray(bytes)||bytes.length!==64)throw Error('Operator key must be a 64-byte array');writeFileSync(keyFile,JSON.stringify(bytes),{mode:0o600,flag:'wx'});}
 process.env.KIDS_OPERATOR_KEY_FILE=keyFile;
}
const operatorPublicKey=mode.mode==='signer'?mode.publicKey:Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile,'utf8')))).publicKey.toBase58();
const identities=JSON.parse(readFileSync(new URL('../MAINNET-IDENTITIES.json',import.meta.url),'utf8'));
if(profile.network==='mainnet'&&identities.operatorWallet?.address!==operatorPublicKey)throw Error('Operator public key does not match the recorded operator wallet');
const operator={publicKey:new PublicKey(operatorPublicKey)};
const connection=new Connection(profile.rpcUrl,'confirmed');
let healthy=false;for(let i=0;i<30;i++){try{if(await connection.getGenesisHash()===profile.genesisHash){healthy=true;break;}throw Error('genesis');}catch{await new Promise(r=>setTimeout(r,2000));}}if(!healthy)throw Error('RPC unreachable or wrong network');
// Program manifest from the chain: id from identities (or KIDS_PROGRAM_ID for devnet), bytes hashed and compared.
const programId=process.env.KIDS_PROGRAM_ID||identities.program?.programId;if(!programId)throw Error('Program id unknown');
const expectedHash=process.env.KIDS_PROGRAM_SHA256||identities.program?.binarySha256;
const info=await connection.getAccountInfo(new PublicKey(programId));if(!info?.executable||info.owner.toBase58()!=='BPFLoaderUpgradeab1e11111111111111111111111')throw Error('Program is not deployed on '+profile.network);
const data=await connection.getAccountInfo(new PublicKey(info.data.subarray(4,36)));const body=data.data.subarray(45);
// The binary itself ends in zero bytes, so trailing zeros are NOT stripped blindly: hash the recorded binary size when
// known (program data is sized to the binary), otherwise the whole program data.
const recordedSize=Number(process.env.KIDS_PROGRAM_SIZE||identities.program?.binarySize||0);const size=recordedSize>0&&recordedSize<=body.length?recordedSize:body.length;
const sha256=createHash('sha256').update(body.subarray(0,size)).digest('hex');if(expectedHash&&sha256!==expectedHash)throw Error('Deployed program hash '+sha256.slice(0,16)+' differs from the recorded build (hashed '+size+' of '+body.length+' bytes)');
if(body.subarray(size).some(n=>n!==0))throw Error('Program data has bytes beyond the recorded binary size');
const authority=data.data[12]?new PublicKey(data.data.subarray(13,45)).toBase58():null;
const manifestPath=runtime+'/atomic-launch-program.json',previous=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):null;
const manifest=nextProgramManifest(previous,{network:profile.network,rpcUrl:profile.rpcLabel,genesisHash:profile.genesisHash,programId,upgradeAuthority:authority,sha256,binarySize:size,source:'programs/atomic-launch/src/lib.rs (reproducible CI build)',status:profile.network+'-service'});
if(!previous||previous.sha256!==sha256||previous.upgradeAuthority!==authority)writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});
console.log(JSON.stringify({event:'program-verified',network:profile.network,programId,sha256,upgradeAuthority:authority,operator:operator.publicKey.toBase58(),operatorMode:mode.mode,operatorBalanceSol:(await connection.getBalance(operator.publicKey))/1e9,upgradeAuthorityIsOperator:authority===operator.publicKey.toBase58()}));
if(profile.network==='mainnet'&&authority===operator.publicKey.toBase58())console.log(JSON.stringify({event:'governance-warning',message:'the keeper key still holds the program upgrade authority; move it to the governance key'}));
// Campaign: provision only when a plan and its snapshot evidence exist; otherwise the API answers "not configured".
if(existsSync(new URL('./campaign-plan.json',import.meta.url))){
 // A finished test campaign (failed, every commitment refunded) is archived first when KIDS_ACTIVE_CAMPAIGN_RENEW is set;
 // a launched campaign is never replaced here. The new campaign then comes from the (new) plan.
 const renewSetting=process.env.KIDS_ACTIVE_CAMPAIGN_RENEW;
 if(renewSetting){const renew=await import('../../localnet/renew-active-launch.mjs');const setting=renew.parseRenewSetting(renewSetting);if(setting?.refused)console.log(JSON.stringify({event:'active-campaign-renew-refused',reason:setting.refused}));else if(setting){try{const r=await renew.renewFinishedActiveLaunch({mode:setting.mode,token:setting.token,log:line=>console.log(JSON.stringify(line))});console.log(JSON.stringify({event:'active-campaign-renew',...r}));}catch(error){console.log(JSON.stringify({event:'active-campaign-renew-failed',reason:String(error.message).slice(0,200)}));}}}
 try{const {provisionActiveLaunch}=await import('../../localnet/provision-active-launch.mjs');const state=await provisionActiveLaunch();console.log(JSON.stringify({event:'campaign-ready',campaign:state.escrowAddress,phase:state.phase,deadlineUnix:state.deadlineUnix}));}
 catch(error){console.log(JSON.stringify({event:'campaign-not-provisioned',reason:String(error.message).slice(0,300)}));if(process.env.KIDS_REQUIRE_CAMPAIGN==='1')throw error;}
}else console.log(JSON.stringify({event:'no-campaign-plan'}));
const children=new Set();let stopping=false;
function stop(code){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');setTimeout(()=>{for(const c of children)c.kill('SIGKILL');process.exit(code);},35000).unref();process.exitCode=code;}
for(const signal of['SIGTERM','SIGINT'])process.on(signal,()=>stop(0));
function start(command,args){const child=spawn(command,args,{stdio:'inherit'});children.add(child);child.on('error',error=>{console.error('spawn failed',command,error.code);stop(1);});child.on('exit',(code,signal)=>{children.delete(child);if(!stopping){console.error('child exited',command,code,signal);stop(code||1);}});return child;}
if(!existsSync('interaction-review/staging/gateway.mjs'))throw Error('Authenticated gateway not installed; refusing public listener');
start('flock',['--nonblock','--no-fork',runtime+'/api-writer.lock',process.execPath,'interaction-review/server/runtime.mjs']);
let ready=false;for(let i=0;i<240;i++){try{const r=await fetch('http://127.0.0.1:4175/_health/ready');if(r.ok){ready=true;break;}if(i%30===29)console.log(JSON.stringify({event:'waiting-for-api',status:r.status,body:(await r.text()).slice(0,200)}));}catch{}await new Promise(r=>setTimeout(r,1000));}
if(!ready){stop(1);throw Error('Internal API listener not ready');}
start(process.execPath,['interaction-review/staging/gateway.mjs']);
}
