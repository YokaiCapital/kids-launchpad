import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {acceptedProgramHash,nextProgramManifest} from '../../localnet/program-lineage.mjs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../localnet/package.json',import.meta.url));
const {Connection,PublicKey,Keypair}=require('@solana/web3.js');
const connection=new Connection('http://127.0.0.1:19099','confirmed'),runtime='/data/localnet';
const expected=process.env.KIDS_PROGRAM_SHA256||'ef584ae7555415215b8cda0597cfff8362a7ecdbb31fdc07aa747c3f63368923';if(!/^[0-9a-f]{64}$/.test(expected))throw Error('KIDS_PROGRAM_SHA256 must be a hex SHA-256');
const binary=readFileSync('/opt/kids/kids_atomic_launch.so');if(createHash('sha256').update(binary).digest('hex')!==expected)throw Error('Custom program binary mismatch');
let healthy=false;for(let i=0;i<180;i++){try{await connection.getVersion();healthy=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}if(!healthy)throw Error('Validator did not become ready');
const genesisHash=await connection.getGenesisHash();if(genesisHash==='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')throw Error('Mainnet forbidden');
const cloned={CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C:'36537be95ba356056fa38b2847d928078c68bf6cd79b875c140e157e6452cc71',LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE:'efd657a986796e1b204ebae198e691d4137d5f89a401693b83f7fb1a142f802d',metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s:'31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011'};
async function programData(id){const account=await connection.getAccountInfo(new PublicKey(id));if(!account?.executable||account.owner.toBase58()!=='BPFLoaderUpgradeab1e11111111111111111111111'||account.data.readUInt32LE(0)!==2)throw Error('Invalid program loader');const data=await connection.getAccountInfo(new PublicKey(account.data.subarray(4,36)));if(!data||data.data.readUInt32LE(0)!==3)throw Error('Missing ProgramData');return data.data;}
for(const[id,hash]of Object.entries(cloned)){if(createHash('sha256').update((await programData(id)).subarray(45)).digest('hex')!==hash)throw Error('Upstream program changed; qualify before deployment');}
const key=name=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(runtime+'/'+name+'.json'))));
const programId=key('atomic-launch-program-key').publicKey.toBase58();let data=await programData(programId);
const deployedHash=()=>createHash('sha256').update(data.subarray(45,45+binary.length)).digest('hex');
const path=runtime+'/atomic-launch-program.json',previous=existsSync(path)?JSON.parse(readFileSync(path)):null;
if(previous&&(previous.genesisHash!==genesisHash||previous.programId!==programId))throw Error('Persistent ledger identity changed; refusing reset');
if(deployedHash()!==expected||data.subarray(45+binary.length).some(n=>n!==0)){
 // The image carries a newer program. Upgrade in place, never reset: only when the recorded manifest is ours and the
 // admin key holds the upgrade authority. Campaigns and journals stay valid through the manifest lineage.
 const authority=data[12]?new PublicKey(data.subarray(13,45)).toBase58():null,admin=key('admin');
 if(!previous||authority!==admin.publicKey.toBase58())throw Error('Deployed custom binary mismatch and no upgrade path (authority '+authority+')');
 console.log(JSON.stringify({event:'program-upgrade',from:previous.sha256,to:expected}));
 execFileSync(process.env.SOLANA_BIN+'/solana',['program','deploy','/opt/kids/kids_atomic_launch.so','--program-id',programId,'--upgrade-authority',runtime+'/admin.json','--keypair',runtime+'/admin.json','--url','http://127.0.0.1:19099','--commitment','finalized'],{stdio:'inherit'});
 data=await programData(programId);
 if(deployedHash()!==expected||data.subarray(45+binary.length).some(n=>n!==0))throw Error('Program upgrade did not land');
}
const manifest=nextProgramManifest(previous,{network:'localnet',rpcUrl:'http://127.0.0.1:19099',genesisHash,programId,upgradeAuthority:data[12]?new PublicKey(data.subarray(13,45)).toBase58():null,sha256:expected,binarySize:binary.length,source:'programs/atomic-launch/src/lib.rs',status:'private-remote-localnet-only'});
if(!previous||previous.sha256!==expected)writeFileSync(path,JSON.stringify(manifest,null,2),{mode:0o600});
for(const name of['admin','alice','bob']){const wallet=key(name).publicKey;if(await connection.getBalance(wallet)<100000000000){const signature=await connection.requestAirdrop(wallet,1000000000000);await connection.confirmTransaction(signature,'confirmed');}}
const receipt=runtime+'/staging-ready.json';
if(existsSync(receipt)){const old=JSON.parse(readFileSync(receipt));if(old.genesisHash!==genesisHash||!acceptedProgramHash(manifest,old.sha256))throw Error('Staging receipt differs from ledger');}
else{
 if(existsSync(runtime+'/staging-bootstrap-started.json'))throw Error('Previous qualification incomplete; operator recovery required, no automatic duplicate fixture');
 writeFileSync(runtime+'/staging-bootstrap-started.json',JSON.stringify({genesisHash,sha256:expected}),{mode:0o600,flag:'wx'});
 await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['localnet/full-launch-verify.mjs'],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Full launch qualification failed')));});
 writeFileSync(receipt,JSON.stringify({genesisHash,sha256:expected,qualifiedAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
}

// A separate compatibility ledger supports the existing session/config readers.
const legacy=new Connection('http://127.0.0.1:18999','confirmed');
let legacyReady=false;for(let i=0;i<120;i++){try{await legacy.getVersion();legacyReady=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}}if(!legacyReady)throw Error('Compatibility validator unavailable');
const legacyGenesis=await legacy.getGenesisHash(),configPath=runtime+'/config.json';
if(existsSync(configPath)){if(JSON.parse(readFileSync(configPath)).genesisHash!==legacyGenesis)throw Error('Compatibility ledger identity changed');}
else{
 const {createMint,getOrCreateAssociatedTokenAccount,mintTo,getMint}=require('@solana/spl-token');
 const {withLaunchPolicy}=await import('../../localnet/launch-policy.mjs');
 const admin=key('admin'),alice=key('alice'),bob=key('bob');
 for(const wallet of[admin,alice,bob]){if(await legacy.getBalance(wallet.publicKey)<1000000000000){const sig=await legacy.requestAirdrop(wallet.publicKey,2000000000000);await legacy.confirmTransaction(sig,'confirmed');}}
 const mints={};
 for(const name of['KIDS','FARTCOIN','BUTTCOIN','SHART']){
  const mintFile=runtime+'/mint-'+name+'.json';if(!existsSync(mintFile))writeFileSync(mintFile,JSON.stringify([...Keypair.generate().secretKey]),{mode:0o600,flag:'wx'});
  const mintKey=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(mintFile)))),mint=mintKey.publicKey;
  if(!await legacy.getAccountInfo(mint))await createMint(legacy,admin,admin.publicKey,null,6,mintKey);
  const info=await getMint(legacy,mint);if(info.supply===0n){for(const[wallet,amount]of[[admin,998000000000000n],[alice,1000000000000n],[bob,1000000000000n]]){const ata=await getOrCreateAssociatedTokenAccount(legacy,admin,mint,wallet.publicKey);await mintTo(legacy,admin,mint,ata.address,admin,amount);}}
  if((await getMint(legacy,mint)).supply!==1000000000000000n)throw Error('Incomplete compatibility mint initialization; operator recovery required');
  mints[name]=mint.toBase58();
 }
 writeFileSync(configPath,JSON.stringify(withLaunchPolicy({version:1,network:'localnet',rpcUrl:'http://127.0.0.1:18999',genesisHash:legacyGenesis,admin:admin.publicKey.toBase58(),wallets:{alice:alice.publicKey.toBase58(),bob:bob.publicKey.toBase58()},mints,launch:{poolUsd:200000,solUsd:200,capLamports:'500000000000',parentShareBps:1000,holderMinimumBps:5,commitmentsOpen:false},createdAt:new Date().toISOString()}),null,2),{mode:0o600,flag:'wx'});
}

// KIDS_ACTIVE_CAMPAIGN_RENEW (private test environments only): 'finished' archives a failed campaign with every commitment
// refunded; 'any' also archives a launched campaign with nothing pending. A fresh test campaign is then opened with the
// terms from KIDS_ACTIVE_SOFT_CAP_SOL / KIDS_ACTIVE_HARD_CAP_SOL / KIDS_ACTIVE_DEADLINE_SECONDS (defaults 100 / 500 / 86400).
{const renew=await import('../../localnet/renew-active-launch.mjs');const setting=renew.parseRenewSetting(process.env.KIDS_ACTIVE_CAMPAIGN_RENEW);if(setting?.refused)console.log(JSON.stringify({event:'active-campaign-renew-refused',reason:setting.refused}));else if(setting){const r=await renew.renewFinishedActiveLaunch({mode:setting.mode,token:setting.token,log:line=>console.log(JSON.stringify(line))});console.log(JSON.stringify({event:'active-campaign-renew',...r}));}}
await (await import('../../localnet/provision-active-launch.mjs')).provisionActiveLaunch();
console.log('Remote isolated localnet verified; active campaign provisioned, test-only keys and ledger retained on volume.');
