// Resumable local operator only. No HTTP route or public-campaign switch.
import {existsSync,readFileSync} from 'node:fs';
import {acceptedProgramHash} from './program-lineage.mjs';
import {fileURLToPath} from 'node:url';
import {Keypair,PublicKey,Transaction,ComputeBudgetProgram,AddressLookupTableProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {activeContext,activeManifest,activeManifestPath,saveActiveFile,readActive,settleActive} from './active-launch.mjs';
import {readCampaign,launchInstruction} from './atomic-launch.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
import {createOperatorSender} from './operator-journal.mjs';
import {operatorSigner} from './operator-signer.mjs';
const runtime=fileURLToPath(new URL('./.runtime/',import.meta.url)),journalPath=runtime+'active-launch-operator.json';
const read=path=>JSON.parse(readFileSync(path,'utf8'));
let pending;
export function launchActive(){if(pending)return pending;pending=run().finally(()=>{pending=null;});return pending;}
async function run(){
 const ctx=await activeContext(),m=activeManifest(ctx),c=ctx.connection,admin=await operatorSigner();
 let state=await readCampaign(ctx,m.address);if(state.phase===3)return {alreadyLaunched:true,state:await readActive()};
 const now=await chainTime(c);if(now<state.deadline)throw Error('Funding must close before operator launch');if(now>=state.launchDeadline)throw Error('Launch window expired; run settleActive for full refunds');
 await settleActive();state=await readCampaign(ctx,m.address);
 if(state.phase===2||state.receiptCount===0n||state.settledReceiptCount!==state.receiptCount||state.settledAccepted<state.soft)throw Error('Campaign is not fully settled above the soft cap');
 const keys=read(runtime+'active-launch-setup-keys.json'),nft=Keypair.fromSecretKey(Uint8Array.from(keys.nft));if(nft.publicKey.toBase58()!==m.feeNft)throw Error('Fee NFT identity mismatch');
 const good=launchInstruction(ctx,new PublicKey(m.address),admin.publicKey,new PublicKey(m.mint),nft.publicKey);
 const journal=existsSync(journalPath)?read(journalPath):{campaign:m.address,genesisHash:m.genesisHash,programSha256:m.programSha256,attempts:{}};
 if(journal.campaign!==m.address||journal.genesisHash!==m.genesisHash||!acceptedProgramHash(ctx.manifest,journal.programSha256))throw Error('Operator journal identity mismatch');
 const persist=()=>saveActiveFile(journalPath,journal);
 const send=createOperatorSender({connection:c,journal,persist});
 const legacy=instruction=>async block=>{const tx=new Transaction({feePayer:admin.publicKey,...block}).add(instruction);await admin.sign(tx);return tx;};
 if(!journal.table){const recentSlot=await c.getSlot('finalized'),[,address]=AddressLookupTableProgram.createLookupTable({authority:admin.publicKey,payer:admin.publicKey,recentSlot});journal.table={address:address.toBase58(),recentSlot};persist();}
 let tableAddress=new PublicKey(journal.table.address),table=(await c.getAddressLookupTable(tableAddress)).value;
 if(!table){
  // A stale, never-created table can be replaced only once the previous create
  // transaction is absent and finalized-expired (or definitively failed).
  if(await c.getSlot('finalized')-journal.table.recentSlot>400){
   const attempt=journal.attempts['table:'+journal.table.address];
   if(attempt){const status=(await c.getSignatureStatuses([attempt.signature],{searchTransactionHistory:true})).value[0];if(status&&!(status.err&&status.confirmationStatus==='finalized')||!status&&await c.getBlockHeight('finalized')<=attempt.block.lastValidBlockHeight)throw Error('Table creation is unresolved; retry after finalization');}
   const recentSlot=await c.getSlot('finalized'),[,address]=AddressLookupTableProgram.createLookupTable({authority:admin.publicKey,payer:admin.publicKey,recentSlot});journal.table={address:address.toBase58(),recentSlot};tableAddress=address;persist();
  }
  const [instruction,address]=AddressLookupTableProgram.createLookupTable({authority:admin.publicKey,payer:admin.publicKey,recentSlot:journal.table.recentSlot});if(!address.equals(tableAddress))throw Error('Table identity mismatch');await send('table:'+tableAddress,legacy(instruction));table=(await c.getAddressLookupTable(tableAddress)).value;
 }
 if(!table?.state.authority?.equals(admin.publicKey)||table.state.deactivationSlot!==18446744073709551615n)throw Error('Unexpected operator lookup table authority or deactivation');
 const addresses=[...new Map(good.instruction.keys.map(k=>[k.pubkey.toBase58(),k.pubkey])).values()];
 const missing=addresses.filter(a=>!table.state.addresses.some(b=>a.equals(b)));
 for(let i=0;i<missing.length;i+=20){const chunk=missing.slice(i,i+20);await send('extend:'+tableAddress+':'+chunk.map(x=>x.toBase58()).join(','),legacy(AddressLookupTableProgram.extendLookupTable({lookupTable:tableAddress,authority:admin.publicKey,payer:admin.publicKey,addresses:chunk})));}
 table=(await c.getAddressLookupTable(tableAddress)).value;const start=Date.now();while(await c.getSlot('confirmed')<=table.state.lastExtendedSlot){if(Date.now()-start>30000)throw Error('Lookup table activation stalled');await new Promise(resolve=>setTimeout(resolve,200));}
 const signature=await send('launch',async block=>{const message=new TransactionMessage({payerKey:admin.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1200000}),good.instruction]}).compileToV0Message([table]),tx=new VersionedTransaction(message);tx.sign([nft]);await admin.sign(tx);return tx;});
 state=await readCampaign(ctx,m.address);if(state.phase!==3||!state.pool.equals(good.addresses.pool)||!state.feeNft.equals(nft.publicKey))throw Error('Launch postconditions failed');
 m.launchSignature=signature;m.pool=state.pool.toBase58();saveActiveFile(activeManifestPath,m);return {signature,state:await readActive()};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await launchActive(),null,2));
