// Isolated localnet build of pinned upstream Raydium CPMM. Never deploys mainnet.
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Connection,PublicKey,Transaction,TransactionInstruction,sendAndConfirmTransaction,SystemProgram} from '@solana/web3.js';
import {NATIVE_MINT,getOrCreateAssociatedTokenAccount} from '@solana/spl-token';
import {directory,key,bin} from './setup.mjs';
import {localKey} from './dev-vesting.mjs';
import {readLocalConfig} from '../interaction-review/server/local-config.mjs';
const commit='59fb845a9e5bb569c8b2f3415f13b0c0ebcc6b92';
const config=readLocalConfig();
if(config?.network!=='localnet'||config.rpcUrl!=='http://127.0.0.1:18999')throw Error('CPMM deployment requires isolated localnet');
const connection=new Connection(config.rpcUrl,'confirmed');
if(await connection.getGenesisHash()!==config.genesisHash)throw Error('Localnet genesis mismatch');
const admin=localKey('admin');if(admin.publicKey.toBase58()!==config.admin)throw Error('Wrong local administrator');
const program=key('cpmm-program-key'),source=directory+'/raydium-cp-swap';
if(!existsSync(source))execFileSync('git',['clone','https://github.com/raydium-io/raydium-cp-swap.git',source],{stdio:'inherit'});
execFileSync('git',['fetch','origin',commit],{cwd:source,stdio:'inherit'});
if(execFileSync('git',['rev-parse',commit+'^{commit}'],{cwd:source,encoding:'utf8'}).trim()!==commit)throw Error('Upstream commit pin mismatch');
const feeAccount=await getOrCreateAssociatedTokenAccount(connection,admin,NATIVE_MINT,admin.publicKey);
// Export committed objects only; neither a dirty checkout nor stale build files
// can enter the pinned source. This directory is generated exclusively here.
const build=directory+'/cpmm-source';rmSync(build,{recursive:true,force:true});mkdirSync(build,{recursive:true});
const archive=execFileSync('git',['archive','--format=tar',commit,'programs/cp-swap','LICENSE','Cargo.lock'],{cwd:source,maxBuffer:32*1024*1024});
execFileSync('tar',['-xf','-','-C',build],{input:archive});
writeFileSync(build+'/Cargo.toml','[workspace]\nresolver = "2"\nmembers = ["programs/cp-swap"]\n[profile.release]\noverflow-checks = true\nlto = "fat"\ncodegen-units = 1\n');
const lib=build+'/programs/cp-swap/src/lib.rs';
writeFileSync(lib,readFileSync(lib,'utf8').replace('declare_id!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C")',`declare_id!("${program.address}")`).replace('pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8")',`pubkey!("${feeAccount.address}")`));
const out=directory+'/cpmm-build';mkdirSync(out,{recursive:true});
execFileSync(bin+'/cargo-build-sbf',['--manifest-path',build+'/programs/cp-swap/Cargo.toml','--sbf-out-dir',out,'--','--features','localnet'],{env:{...process.env,CPSWAP_LOCALNET_ADMIN:admin.publicKey.toBase58()},stdio:'inherit'});
const binary=out+'/raydium_cp_swap.so',binaryBytes=readFileSync(binary),binarySize=binaryBytes.length,sha256=createHash('sha256').update(binaryBytes).digest('hex'),manifest=directory+'/cpmm-program.json';
if(await connection.getAccountInfo(new PublicKey(program.address))){
 if(!existsSync(manifest)||JSON.parse(readFileSync(manifest)).sha256!==sha256)throw Error('Existing immutable CPMM build differs; preserve deployment');
}else execFileSync(bin+'/solana',['program','deploy',binary,'--program-id','cpmm-program-key.json','--keypair','admin.json','--url',config.rpcUrl,'--final'],{cwd:directory,stdio:'inherit'});
const programId=new PublicKey(program.address),index=Buffer.from([0,2]),[ammConfig]=PublicKey.findProgramAddressSync([Buffer.from('amm_config'),index],programId);
if(!await connection.getAccountInfo(ammConfig)){
 const data=Buffer.alloc(50);createHash('sha256').update('global:create_amm_config').digest().copy(data,0,0,8);data.writeUInt16LE(2,8);
 for(const [offset,value] of [[10,20000n],[18,120000n],[26,40000n],[34,150000000n],[42,0n]])data.writeBigUInt64LE(value,offset);
 await sendAndConfirmTransaction(connection,new Transaction().add(new TransactionInstruction({programId,keys:[{pubkey:admin.publicKey,isSigner:true,isWritable:true},{pubkey:ammConfig,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}],data})),[admin]);
}
const result={network:'localnet',genesisHash:config.genesisHash,programId:program.address,upgradeAuthority:null,sourceRepository:'https://github.com/raydium-io/raydium-cp-swap',sourceCommit:commit,sourceModifications:['local program ID','local fee recipient','upstream localnet admin build feature'],sha256,binarySize,ammConfig:ammConfig.toBase58(),feeAccount:feeAccount.address.toBase58(),tradeFeePpm:20000,protocolSharePpm:120000,fundSharePpm:40000,creatorFeePpm:0};
writeFileSync(manifest,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));
