import {readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Connection,PublicKey,Keypair,Transaction,ComputeBudgetProgram,SYSVAR_CLOCK_PUBKEY,sendAndConfirmTransaction,token,rewards,merkle} from './rewards-client.mjs';
import {devPlan,scheduleBytes,unlockedRaw} from './vesting-plan.mjs';
import {readLocalConfig} from '../interaction-review/server/local-config.mjs';
const runtime=fileURLToPath(new URL('./.runtime/',import.meta.url)),registry=runtime+'/dev-vesting.json';
const MAX_CLAWBACK=9223372036854775807n;
export function localKey(name){if(!/^(admin|alice|bob|dev-unlock-seed|dev-linear-seed)$/.test(name))throw Error('Unknown local identity');const path=runtime+'/'+name+'.json';if(!existsSync(path)){if(!name.endsWith('-seed'))throw Error('Wallet missing');const k=Keypair.generate();writeFileSync(path,JSON.stringify([...k.secretKey]),{mode:0o600,flag:'wx'});}const bytes=Uint8Array.from(JSON.parse(readFileSync(path)));try{return Keypair.fromSecretKey(bytes.slice());}finally{bytes.fill(0);}}
export async function context(){
 const config=readLocalConfig();if(config?.network!=='localnet'||config.rpcUrl!=='http://127.0.0.1:18999')throw Error('Vesting service requires isolated localnet');
 const connection=new Connection(config.rpcUrl,'confirmed');if(await connection.getGenesisHash()!==config.genesisHash)throw Error('Localnet genesis changed');
 if(!existsSync(runtime+'/vesting-program.json'))throw Error('Vesting program is not deployed');
 const deployment=JSON.parse(readFileSync(runtime+'/vesting-program.json','utf8'));if(deployment.genesisHash!==config.genesisHash)throw Error('Vesting deployment belongs to another ledger');
 const programId=new PublicKey(deployment.programId),program=await connection.getAccountInfo(programId);
 if(!program?.executable||program.owner.toBase58()!=='BPFLoaderUpgradeab1e11111111111111111111111'||program.data.readUInt32LE(0)!==2)throw Error('Vesting program missing or unsupported loader');
 const programData=await connection.getAccountInfo(new PublicKey(program.data.subarray(4,36)));
 if(!programData||!programData.owner.equals(program.owner)||programData.data.readUInt32LE(0)!==3||programData.data[12]!==0)throw Error('Vesting program must have no upgrade authority');
 return {config,connection,programId};
}
export async function chainTime(connection){const c=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);if(!c)throw Error('Clock unavailable');return Number(c.data.readBigInt64LE(32));}
function save(plan){writeFileSync(registry+'.tmp',JSON.stringify(plan,null,2)+'\n',{mode:0o600});renameSync(registry+'.tmp',registry);}
function load(ctx){if(!existsSync(registry))return null;const plan=JSON.parse(readFileSync(registry,'utf8'));if(plan.genesisHash!==ctx.config.genesisHash||plan.mint!==ctx.config.mints.SHART||plan.programId!==ctx.programId.toBase58())throw Error('Vesting configuration changed; existing allocation must not be replaced');return plan;}
export function trancheInstruction(ctx,plan,tranche){
 const authority=new PublicKey(plan.authority),mint=new PublicKey(plan.mint),schedule=Buffer.from(tranche.schedule,'hex');
 return rewards.createMerkleDistributionInstruction({payer:authority,authority,seed:new PublicKey(tranche.seed),mint,tokenProgram:token.TOKEN_PROGRAM_ID,authorityTokenAccount:token.getAssociatedTokenAddressSync(mint,authority),merkleRoot:merkle.rewardsLeafHash(new PublicKey(plan.dev),BigInt(tranche.amountRaw),schedule),amount:BigInt(tranche.amountRaw),totalAmount:BigInt(tranche.amountRaw),clawbackTs:MAX_CLAWBACK,revocable:0,programId:ctx.programId});
}
export async function provisionDevVesting(){
 const ctx=await context(),{connection,config}=ctx,admin=localKey('admin');if(admin.publicKey.toBase58()!==config.admin)throw Error('Configured admin differs from local funding key');
 let plan=load(ctx);
 if(!plan){
  const mint=await token.getMint(connection,new PublicKey(config.mints.SHART));const timing=devPlan(mint.supply,await chainTime(connection));
  plan={version:1,network:'localnet',purpose:'Isolated dev vesting test; not a SHART pool launch',genesisHash:config.genesisHash,programId:ctx.programId.toBase58(),mint:config.mints.SHART,dev:config.wallets.alice,authority:config.admin,decimals:mint.decimals,...timing,tranches:[]};
  for(const [kind,amountRaw,name] of [['launch',timing.immediateRaw,'dev-unlock-seed'],['linear',timing.linearRaw,'dev-linear-seed']]){
   const tranche={kind,amountRaw,seed:localKey(name).publicKey.toBase58(),schedule:scheduleBytes(kind,timing.start,timing.end).toString('hex')};
   const built=trancheInstruction(ctx,plan,tranche);plan.tranches.push({...tranche,distribution:built.distribution.toBase58(),vault:built.vault.toBase58()});
  }save(plan);
 }
 for(const tranche of plan.tranches){
  if(await connection.getAccountInfo(new PublicKey(tranche.distribution)))continue;
  const built=trancheInstruction(ctx,plan,tranche),seed=localKey(tranche.kind==='launch'?'dev-unlock-seed':'dev-linear-seed');
  const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:400000}),built.instruction);
  tranche.fundingSignature=await sendAndConfirmTransaction(connection,tx,[admin,seed],{commitment:'confirmed'});save(plan);
 }
 return devVestingState();
}
export async function devVestingState(){
 const ctx=await context(),plan=load(ctx);if(!plan)return {funded:false};
 const now=await chainTime(ctx.connection),tranches=[];
 for(const tranche of plan.tranches){
  const address=new PublicKey(tranche.distribution),info=await ctx.connection.getAccountInfo(address);
  if(!info){tranches.push({...tranche,funded:false,claimedRaw:'0',claimableRaw:'0'});continue;}
  if(!info.owner.equals(ctx.programId))throw Error('Wrong distribution owner');
  const state=rewards.decodeMerkleDistribution(info.data),built=trancheInstruction(ctx,plan,tranche);
  const expected=merkle.rewardsLeafHash(new PublicKey(plan.dev),BigInt(tranche.amountRaw),Buffer.from(tranche.schedule,'hex'));
  if(!built.distribution.equals(address)||!state.mint.equals(new PublicKey(plan.mint))||!state.authority.equals(new PublicKey(plan.authority))||!state.seed.equals(new PublicKey(tranche.seed))||!Buffer.from(state.merkleRoot).equals(Buffer.from(expected))||state.revocable!==0||state.clawbackTs!==MAX_CLAWBACK||state.totalAmount!==BigInt(tranche.amountRaw))throw Error('On-chain vesting terms do not match the saved plan');
  const vault=await token.getAccount(ctx.connection,built.vault);if(vault.amount+state.totalClaimed<BigInt(tranche.amountRaw))throw Error('Vesting allocation underfunded');
  const vested=unlockedRaw(tranche.kind,tranche.amountRaw,plan.start,plan.end,now),available=vested-state.totalClaimed;
  tranches.push({...tranche,funded:true,claimedRaw:state.totalClaimed.toString(),claimableRaw:(available>0n?available:0n).toString(),vaultRaw:vault.amount.toString()});
 }
 return {...plan,now,funded:tranches.every(t=>t.funded),tranches,claimedRaw:tranches.reduce((n,t)=>n+BigInt(t.claimedRaw),0n).toString(),claimableRaw:tranches.reduce((n,t)=>n+BigInt(t.claimableRaw),0n).toString()};
}
export async function claimDevVesting(owner){
 const ctx=await context(),state=await devVestingState();if(!state.funded)throw Error('Vesting allocation is not fully funded');if(owner!==state.dev)throw Error('Only the designated dev wallet can claim');
 const name=Object.keys(ctx.config.wallets).find(k=>ctx.config.wallets[k]===owner);if(!['alice','bob'].includes(name))throw Error('Local test signing only; external-wallet transaction signing is not enabled');
 const signer=localKey(name),mint=new PublicKey(state.mint),ata=token.getAssociatedTokenAddressSync(mint,signer.publicKey);
 const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),token.createAssociatedTokenAccountIdempotentInstruction(signer.publicKey,ata,signer.publicKey,mint));
 let count=0;for(const t of state.tranches){if(BigInt(t.claimableRaw)<=0n)continue;count++;tx.add(rewards.claimMerkleInstruction({payer:signer.publicKey,claimant:signer.publicKey,distribution:new PublicKey(t.distribution),mint,tokenProgram:token.TOKEN_PROGRAM_ID,claimantTokenAccount:ata,totalAmount:BigInt(t.amountRaw),amount:BigInt(t.claimableRaw),schedule:Buffer.from(t.schedule,'hex'),proof:[],programId:ctx.programId}).instruction);}
 if(!count)throw Error('Nothing vested to claim yet');
 const signature=await sendAndConfirmTransaction(ctx.connection,tx,[signer],{commitment:'confirmed'});
 return {signature,state:await devVestingState()};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await provisionDevVesting(),null,2));
