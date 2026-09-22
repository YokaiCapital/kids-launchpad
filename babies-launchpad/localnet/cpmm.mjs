// Pinned upstream Raydium CPMM wire layout. Localnet-only qualification helpers.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Connection,PublicKey,TransactionInstruction,SystemProgram,SYSVAR_RENT_PUBKEY} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
const isTokenProgram=k=>k.equals(TOKEN_PROGRAM_ID)||k.equals(TOKEN_2022_PROGRAM_ID);
import {validateCpmmProgramAccount,validateCpmmProgramData} from './cpmm-program-validation.mjs';
import {readLocalConfig} from '../interaction-review/server/local-config.mjs';
export const discriminator=name=>createHash('sha256').update(name).digest().subarray(0,8);
const pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds.map(x=>typeof x==='string'?Buffer.from(x):x.toBuffer()),program)[0];
export function poolAddresses(program,config,mintA,mintB){
 const [mint0,mint1]=[mintA,mintB].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
 if(mint0.equals(mint1))throw Error('Pool mints must differ');
 const pool=pda(program,'pool',config,mint0,mint1);
 return {mint0,mint1,pool,authority:pda(program,'vault_and_lp_mint_auth_seed'),lpMint:pda(program,'pool_lp_mint',pool),vault0:pda(program,'pool_vault',pool,mint0),vault1:pda(program,'pool_vault',pool,mint1),observation:pda(program,'observation',pool)};
}
export function decodeConfig(info,program){
 if(!info||!info.owner.equals(program)||info.data.length!==236||!info.data.subarray(0,8).equals(discriminator('account:AmmConfig')))throw Error('Invalid CPMM config account');
 const d=info.data;return {disabled:d[9]!==0,index:d.readUInt16LE(10),trade:d.readBigUInt64LE(12),protocol:d.readBigUInt64LE(20),fund:d.readBigUInt64LE(28),creationFee:d.readBigUInt64LE(36),creator:d.readBigUInt64LE(108)};
}
export async function cpmmContext(){
 const config=readLocalConfig();if(config?.network!=='localnet'||config.rpcUrl!=='http://127.0.0.1:18999')throw Error('CPMM rehearsal is localnet only');
 const connection=new Connection(config.rpcUrl,'confirmed');if(await connection.getGenesisHash()!==config.genesisHash)throw Error('Localnet genesis mismatch');
 const manifest=JSON.parse(readFileSync(new URL('./.runtime/cpmm-program.json',import.meta.url)));
 if(manifest.genesisHash!==config.genesisHash)throw Error('CPMM manifest belongs to another ledger');
 const programId=new PublicKey(manifest.programId),ammConfig=new PublicKey(manifest.ammConfig),account=await connection.getAccountInfo(programId);
 const programDataAddress=validateCpmmProgramAccount(account);
 const programData=await connection.getAccountInfo(programDataAddress);
 // Older manifests lack binarySize: derive it only from the matching local SBF.
 const fallback=manifest.binarySize===undefined?readFileSync(new URL('./.runtime/cpmm-build/raydium_cp_swap.so',import.meta.url)):undefined;
 validateCpmmProgramData(programData,manifest,fallback);
 const fee=decodeConfig(await connection.getAccountInfo(ammConfig),programId);
 if(fee.disabled||fee.index!==2||fee.trade!==20000n||fee.protocol!==120000n||fee.fund!==40000n||fee.creator!==0n)throw Error('CPMM fee policy differs from approved 2% tier');
 const [expected]=PublicKey.findProgramAddressSync([Buffer.from('amm_config'),Buffer.from([0,2])],programId);if(!expected.equals(ammConfig))throw Error('Wrong CPMM config PDA');
 return {connection,config,manifest,programId,ammConfig,fee};
}
/** programs: {[mint base58]: token program} for any Token-2022 mint; classic by default. */
export function initializePoolInstruction(ctx,creator,mint,quote,baseAmount,quoteAmount,programs={}){
 const p=poolAddresses(ctx.programId,ctx.ammConfig,mint,quote),amount0=p.mint0.equals(mint)?baseAmount:quoteAmount,amount1=p.mint1.equals(mint)?baseAmount:quoteAmount;
 const prog=m=>programs[m.toBase58()]??TOKEN_PROGRAM_ID;
 const data=Buffer.alloc(32);discriminator('global:initialize').copy(data);data.writeBigUInt64LE(amount0,8);data.writeBigUInt64LE(amount1,16);data.writeBigUInt64LE(0n,24);
 const spec=[[creator,true,true],[ctx.ammConfig,false,false],[p.authority,false,false],[p.pool,false,true],[p.mint0,false,false],[p.mint1,false,false],[p.lpMint,false,true],[getAssociatedTokenAddressSync(p.mint0,creator,true,prog(p.mint0)),false,true],[getAssociatedTokenAddressSync(p.mint1,creator,true,prog(p.mint1)),false,true],[getAssociatedTokenAddressSync(p.lpMint,creator,true),false,true],[p.vault0,false,true],[p.vault1,false,true],[new PublicKey(ctx.manifest.feeAccount),false,true],[p.observation,false,true],[TOKEN_PROGRAM_ID,false,false],[prog(p.mint0),false,false],[prog(p.mint1),false,false],[ASSOCIATED_TOKEN_PROGRAM_ID,false,false],[SystemProgram.programId,false,false],[SYSVAR_RENT_PUBKEY,false,false]];
 return {addresses:p,instruction:new TransactionInstruction({programId:ctx.programId,data,keys:spec.map(([pubkey,isSigner,isWritable])=>({pubkey,isSigner,isWritable}))})};
}
export function decodePool(info,program,p){
 if(!info||!info.owner.equals(program)||info.data.length!==637||!info.data.subarray(0,8).equals(discriminator('account:PoolState')))throw Error('Invalid CPMM pool');
 const d=info.data,keys=Array.from({length:10},(_,i)=>new PublicKey(d.subarray(8+i*32,40+i*32)));
 for(const [i,key]of [[2,p.vault0],[3,p.vault1],[4,p.lpMint],[5,p.mint0],[6,p.mint1],[9,p.observation]])if(!keys[i].equals(key))throw Error('CPMM pool identity mismatch');
 if(!isTokenProgram(keys[7])||!isTokenProgram(keys[8]))throw Error('CPMM pool token program mismatch');
 return {config:keys[0],creator:keys[1],status:d[329],lpSupply:d.readBigUInt64LE(333),creatorFeesEnabled:d[390]!==0,program0:keys[7],program1:keys[8]};
}
export function swapInstruction(ctx,p,owner,inputMint,amount,minOutput,programs={}){
 if(!inputMint.equals(p.mint0)&&!inputMint.equals(p.mint1))throw Error('Input mint is not in pool');
 const prog=m=>programs[m.toBase58()]??TOKEN_PROGRAM_ID;
 const forward=inputMint.equals(p.mint0),outputMint=forward?p.mint1:p.mint0,data=Buffer.alloc(24);
 discriminator('global:swap_base_input').copy(data);data.writeBigUInt64LE(amount,8);data.writeBigUInt64LE(minOutput,16);
 const spec=[[owner,true,true],[p.authority,false,false],[ctx.ammConfig,false,false],[p.pool,false,true],[getAssociatedTokenAddressSync(inputMint,owner,true,prog(inputMint)),false,true],[getAssociatedTokenAddressSync(outputMint,owner,true,prog(outputMint)),false,true],[forward?p.vault0:p.vault1,false,true],[forward?p.vault1:p.vault0,false,true],[prog(inputMint),false,false],[prog(outputMint),false,false],[inputMint,false,false],[outputMint,false,false],[p.observation,false,true]];
 return new TransactionInstruction({programId:ctx.programId,data,keys:spec.map(([pubkey,isSigner,isWritable])=>({pubkey,isSigner,isWritable}))});
}
