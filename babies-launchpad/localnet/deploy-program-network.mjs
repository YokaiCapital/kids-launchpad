// Operator tool: deploy (or upgrade) the KIDS program on devnet or mainnet from the reproducible CI binary and write
// the program manifest with lineage. Usage:
//   KIDS_NETWORK=mainnet KIDS_HELIUS_RPC_URL=<server-side URL> node localnet/deploy-program-network.mjs <binary.so> [--check-only]
// Keys: ~/.config/kids/<network>/program-keypair.json (program id) and operator-keypair.json (payer + upgrade authority).
// The RPC URL goes to the Solana CLI through a temporary config file, never on the command line or in output.
import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync,mkdtempSync} from 'node:fs';import {homedir,tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';import {Connection,Keypair,PublicKey} from '@solana/web3.js';
import {networkProfile} from './network.mjs';import {acceptedBuilds} from './program-builds.mjs';import {nextProgramManifest} from './program-lineage.mjs';import {bin,directory} from './setup.mjs';
const profile=networkProfile();if(profile.network==='localnet')throw Error('Use atomic-launch-deploy.mjs for localnet');
// --program launch (default) deploys the launch program (key program-keypair.json, record `program`); --program distribution
// deploys kids-distribution (key distribution-program-keypair.json, record `distribution`, first deploy creates the key).
const argv=process.argv.slice(2),which=argv.includes('--program')?argv[argv.indexOf('--program')+1]:'launch';if(!['launch','distribution'].includes(which))throw Error('--program launch|distribution');
const positional=argv.filter((a,i)=>!a.startsWith('--')&&argv[i-1]!=='--program');const [binaryPath]=positional;if(!binaryPath)throw Error('usage: <binary.so> [--check-only] [--program launch|distribution]');const checkOnly=argv.includes('--check-only');
const recordKey=which==='launch'?'program':'distribution',keyName=which==='launch'?'program':'distribution-program',manifestName=which==='launch'?'atomic-launch-program':'kids-distribution-program';
const identities=JSON.parse(readFileSync(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url),'utf8'));
const bytes=readFileSync(binaryPath),sha256=createHash('sha256').update(bytes).digest('hex');
const record=identities[recordKey]||{};const accepted=[process.env.KIDS_PROGRAM_SHA256,...acceptedBuilds(record).map(b=>b.sha256)].filter(Boolean);const expectedHash=accepted.join(' or ');if(profile.network==='mainnet'&&!accepted.includes(sha256))throw Error('Binary hash '+sha256.slice(0,16)+' is not the expected reproducible build '+expectedHash.slice(0,16)+' (set KIDS_PROGRAM_SHA256 to the CI hash of the new build)');
const keyDir=join(homedir(),'.config/kids',profile.network);const load=name=>{const p=join(keyDir,name+'-keypair.json');if(!existsSync(p))throw Error('Missing key file '+p);return {path:p,keypair:Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p,'utf8'))))};};
const program=(()=>{const p=join(keyDir,keyName+'-keypair.json');if(!existsSync(p)){if(which!=='distribution')throw Error('Missing key file '+p);const k=Keypair.generate();writeFileSync(p,JSON.stringify(Array.from(k.secretKey)),{mode:0o600});console.log(JSON.stringify({event:'program-key-created',path:p,programId:k.publicKey.toBase58()}));}return load(keyName);})(),operator=load('operator');const governancePath=join(keyDir,'governance-keypair.json'),authorityPath=existsSync(governancePath)?governancePath:operator.path;
if(profile.network==='mainnet'&&record.programId&&program.keypair.publicKey.toBase58()!==record.programId)throw Error('Program keypair does not match the recorded program id');
const connection=new Connection(profile.rpcUrl,'confirmed');const genesisHash=await connection.getGenesisHash();if(genesisHash!==profile.genesisHash)throw Error('RPC genesis mismatch for '+profile.network);
// Program data is sized to the binary (future upgrades that grow use `solana program extend`). Peak cost is the write
// buffer plus the program-data rent, both at the current rent rate, plus about 0.1 SOL of write-transaction fees.
const rentPerByte=await connection.getMinimumBalanceForRentExemption(1)-await connection.getMinimumBalanceForRentExemption(0);
const bufferRent=await connection.getMinimumBalanceForRentExemption(bytes.length+37),programDataRent=await connection.getMinimumBalanceForRentExemption(bytes.length+45);
const balance=await connection.getBalance(operator.keypair.publicKey);let needed=bufferRent+programDataRent+100_000_000;void rentPerByte;
console.log(JSON.stringify({network:profile.network,programId:program.keypair.publicKey.toBase58(),operator:operator.keypair.publicKey.toBase58(),binarySha256:sha256,binaryBytes:bytes.length,operatorBalanceSol:balance/1e9,neededSolEstimate:needed/1e9}));
const programInfo=await connection.getAccountInfo(program.keypair.publicKey);
// An upgrade with a bigger binary needs the program-data account extended first (paid by the payer, signed by nobody else).
let extendBy=0;if(programInfo?.executable){const dataInfo=await connection.getAccountInfo(new PublicKey(programInfo.data.subarray(4,36)));const capacity=dataInfo.data.length-45;if(bytes.length>capacity)extendBy=bytes.length-capacity;}
if(programInfo?.executable){needed=bufferRent+(extendBy?await connection.getMinimumBalanceForRentExemption(extendBy):0)+100_000_000;console.log(JSON.stringify({upgrade:true,programDataExtendBytes:extendBy,neededSolEstimate:needed/1e9,note:'the write buffer rent is returned when the buffer closes after the upgrade'}));}
if(checkOnly){console.log(JSON.stringify({deployed:!!programInfo?.executable,check:'only'}));process.exit(0);}
if(balance<needed)throw Error('Operator wallet needs about '+(needed/1e9).toFixed(2)+' SOL (has '+(balance/1e9).toFixed(3)+'); fund '+operator.keypair.publicKey.toBase58());
const tmp=mkdtempSync(join(tmpdir(),'kids-cli-'));const config=join(tmp,'cli.yml');writeFileSync(config,'json_rpc_url: "'+profile.rpcUrl+'"\nwebsocket_url: ""\nkeypair_path: '+operator.path+'\ncommitment: confirmed\n',{mode:0o600});
try{
 // Extension (verified on a local ledger, 23 September 2026): the loader extends by at least 10,240 bytes, and the CLI
 // accepts the extension only when the upgrade authority is the default signer and the payer. The governance key is
 // therefore topped up from the operator with just enough for the rent, and signs the extension itself.
 if(extendBy){
  extendBy=Math.max(extendBy,10240);const {SystemProgram,Transaction,sendAndConfirmTransaction}=await import('@solana/web3.js');
  const authorityKeypair=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(authorityPath,'utf8'))));
  const need=await connection.getMinimumBalanceForRentExemption(extendBy)+20_000_000,have=await connection.getBalance(authorityKeypair.publicKey);
  if(have<need){const lamports=need-have;console.log(JSON.stringify({event:'fund-upgrade-authority-for-extension',from:operator.keypair.publicKey.toBase58(),to:authorityKeypair.publicKey.toBase58(),sol:lamports/1e9}));
   const sig=await sendAndConfirmTransaction(connection,new Transaction().add(SystemProgram.transfer({fromPubkey:operator.keypair.publicKey,toPubkey:authorityKeypair.publicKey,lamports})),[operator.keypair],{commitment:'confirmed'});console.log(JSON.stringify({funded:true,signature:sig}));}
  const configAuthority=join(tmp,'cli-authority.yml');writeFileSync(configAuthority,'json_rpc_url: "'+profile.rpcUrl+'"\nwebsocket_url: ""\nkeypair_path: '+authorityPath+'\ncommitment: confirmed\n',{mode:0o600});
  console.log('solana program extend by '+extendBy+' bytes (authority signs and pays)');execFileSync(join(bin,'solana'),['program','extend',program.keypair.publicKey.toBase58(),String(extendBy),'--keypair',authorityPath,'--config',configAuthority],{stdio:'inherit'});
 }
 const upgrade=!!programInfo?.executable;
 const args=upgrade?['program','deploy',binaryPath,'--program-id',program.keypair.publicKey.toBase58(),'--upgrade-authority',authorityPath,'--keypair',operator.path,'--config',config,'--commitment','confirmed','--use-rpc']:['program','deploy',binaryPath,'--program-id',program.path,'--upgrade-authority',authorityPath,'--keypair',operator.path,'--config',config,'--commitment','confirmed','--use-rpc','--max-len',String(bytes.length)];
 console.log(JSON.stringify({mode:upgrade?'upgrade':'first-deploy',upgradeAuthorityKey:authorityPath===governancePath?'governance':'operator'}));
 console.log('solana program deploy (URL hidden in a temp config)');execFileSync(join(bin,'solana'),args,{stdio:'inherit'});
}finally{rmSync(tmp,{recursive:true,force:true});}
const info=await connection.getAccountInfo(program.keypair.publicKey);if(!info?.executable)throw Error('Program is not executable after deploy');
const dataAddress=new PublicKey(info.data.subarray(4,36)),data=await connection.getAccountInfo(dataAddress);
const onChain=createHash('sha256').update(data.data.subarray(45,45+bytes.length)).digest('hex');if(onChain!==sha256||data.data.subarray(45+bytes.length).some(n=>n!==0))throw Error('On-chain program bytes differ from the binary');
const authority=data.data[12]?new PublicKey(data.data.subarray(13,45)).toBase58():null;
mkdirSync(directory,{recursive:true,mode:0o700});const manifestPath=join(directory,manifestName+'.'+profile.network+'.json'),previous=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):null;
const manifest=nextProgramManifest(previous,{network:profile.network,rpcUrl:profile.rpcLabel,genesisHash,programId:program.keypair.publicKey.toBase58(),upgradeAuthority:authority,sha256,binarySize:bytes.length,source:(which==='launch'?'programs/atomic-launch':'programs/kids-distribution')+'/src/lib.rs (reproducible CI build)',status:profile.network+'-deployed'});
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({deployed:true,manifest:manifestPath,upgradeAuthority:authority,lineage:manifest.lineage?.length??1}));
