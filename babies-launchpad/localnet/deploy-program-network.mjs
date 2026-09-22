// Operator tool: deploy (or upgrade) the KIDS program on devnet or mainnet from the reproducible CI binary and write
// the program manifest with lineage. Usage:
//   KIDS_NETWORK=mainnet KIDS_HELIUS_RPC_URL=<server-side URL> node localnet/deploy-program-network.mjs <binary.so> [--check-only]
// Keys: ~/.config/kids/<network>/program-keypair.json (program id) and operator-keypair.json (payer + upgrade authority).
// The RPC URL goes to the Solana CLI through a temporary config file, never on the command line or in output.
import {execFileSync} from 'node:child_process';import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync,mkdtempSync} from 'node:fs';import {homedir,tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';import {Connection,Keypair,PublicKey} from '@solana/web3.js';
import {networkProfile} from './network.mjs';import {nextProgramManifest} from './program-lineage.mjs';import {bin,directory} from './setup.mjs';
const profile=networkProfile();if(profile.network==='localnet')throw Error('Use atomic-launch-deploy.mjs for localnet');
const [binaryPath,flag]=process.argv.slice(2);if(!binaryPath)throw Error('usage: <binary.so> [--check-only]');const checkOnly=flag==='--check-only';
const identities=JSON.parse(readFileSync(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url),'utf8'));
const bytes=readFileSync(binaryPath),sha256=createHash('sha256').update(bytes).digest('hex');
if(profile.network==='mainnet'&&sha256!==identities.program.binarySha256)throw Error('Binary hash '+sha256.slice(0,16)+' is not the recorded reproducible build '+identities.program.binarySha256.slice(0,16));
const keyDir=join(homedir(),'.config/kids',profile.network);const load=name=>{const p=join(keyDir,name+'-keypair.json');if(!existsSync(p))throw Error('Missing key file '+p);return {path:p,keypair:Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p,'utf8'))))};};
const program=load('program'),operator=load('operator');
if(profile.network==='mainnet'&&program.keypair.publicKey.toBase58()!==identities.program.programId)throw Error('Program keypair does not match the recorded program id');
const connection=new Connection(profile.rpcUrl,'confirmed');const genesisHash=await connection.getGenesisHash();if(genesisHash!==profile.genesisHash)throw Error('RPC genesis mismatch for '+profile.network);
// Program data is sized to the binary (future upgrades that grow use `solana program extend`). Peak cost is the write
// buffer plus the program-data rent, both at the current rent rate, plus about 0.1 SOL of write-transaction fees.
const rentPerByte=await connection.getMinimumBalanceForRentExemption(1)-await connection.getMinimumBalanceForRentExemption(0);
const bufferRent=await connection.getMinimumBalanceForRentExemption(bytes.length+37),programDataRent=await connection.getMinimumBalanceForRentExemption(bytes.length+45);
const balance=await connection.getBalance(operator.keypair.publicKey);const needed=bufferRent+programDataRent+100_000_000;void rentPerByte;
console.log(JSON.stringify({network:profile.network,programId:program.keypair.publicKey.toBase58(),operator:operator.keypair.publicKey.toBase58(),binarySha256:sha256,binaryBytes:bytes.length,operatorBalanceSol:balance/1e9,neededSolEstimate:needed/1e9}));
const programInfo=await connection.getAccountInfo(program.keypair.publicKey);
if(checkOnly){console.log(JSON.stringify({deployed:!!programInfo?.executable,check:'only'}));process.exit(0);}
if(balance<needed)throw Error('Operator wallet needs about '+(needed/1e9).toFixed(2)+' SOL (has '+(balance/1e9).toFixed(3)+'); fund '+operator.keypair.publicKey.toBase58());
const tmp=mkdtempSync(join(tmpdir(),'kids-cli-'));const config=join(tmp,'cli.yml');writeFileSync(config,'json_rpc_url: "'+profile.rpcUrl+'"\nwebsocket_url: ""\nkeypair_path: '+operator.path+'\ncommitment: confirmed\n',{mode:0o600});
try{
 const args=['program','deploy',binaryPath,'--program-id',program.path,'--upgrade-authority',operator.path,'--keypair',operator.path,'--config',config,'--commitment','confirmed','--use-rpc','--max-len',String(bytes.length)];
 console.log('solana program deploy (URL hidden in a temp config)');execFileSync(join(bin,'solana'),args,{stdio:'inherit'});
}finally{rmSync(tmp,{recursive:true,force:true});}
const info=await connection.getAccountInfo(program.keypair.publicKey);if(!info?.executable)throw Error('Program is not executable after deploy');
const dataAddress=new PublicKey(info.data.subarray(4,36)),data=await connection.getAccountInfo(dataAddress);
const onChain=createHash('sha256').update(data.data.subarray(45,45+bytes.length)).digest('hex');if(onChain!==sha256||data.data.subarray(45+bytes.length).some(n=>n!==0))throw Error('On-chain program bytes differ from the binary');
const authority=data.data[12]?new PublicKey(data.data.subarray(13,45)).toBase58():null;
mkdirSync(directory,{recursive:true,mode:0o700});const manifestPath=join(directory,'atomic-launch-program.'+profile.network+'.json'),previous=existsSync(manifestPath)?JSON.parse(readFileSync(manifestPath,'utf8')):null;
const manifest=nextProgramManifest(previous,{network:profile.network,rpcUrl:profile.rpcLabel,genesisHash,programId:program.keypair.publicKey.toBase58(),upgradeAuthority:authority,sha256,binarySize:bytes.length,source:'programs/atomic-launch/src/lib.rs (reproducible CI build)',status:profile.network+'-deployed'});
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({deployed:true,manifest:manifestPath,upgradeAuthority:authority,lineage:manifest.lineage?.length??1}));
