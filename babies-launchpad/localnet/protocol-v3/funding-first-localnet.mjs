// Funding-first increment 1 on the isolated local validator (RPC 19199, program from .runtime/kids-launch-v3-program.json):
// opens a version-2 campaign with tag 41 (pre-funded adversary addresses included), checks the record marker, extension
// and reservations, refuses a duplicate binding, applies the commit limits, refuses the old money tags on the version-2
// record, and proves a version-0 campaign (tag 40) is untouched. Prints compute units and packet size. Loopback only.
import {readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {Connection,Keypair,PublicKey,SystemProgram,Transaction,TransactionMessage,VersionedTransaction,sendAndConfirmTransaction,ComputeBudgetProgram,AddressLookupTableAccount} from '@solana/web3.js';
import {key,directory} from '../setup.mjs';
import {chainTime} from '../dev-vesting.mjs';
import {openFundingInstruction,compactCreateInstruction,displayHash,decodeExt,decodeReservation,extAddress,mintReservationAddress,nftReservationAddress,programErrorNameV3,CREATE_V3_URI_PREFIX,OFF_ACCOUNTING_VERSION,MIN_COMMIT_LAMPORTS_V2,SOFT_FLOOR_LAMPORTS_V2,COLLATERAL_LAMPORTS_V2,launchFundingFirstInstruction,closeV2Instruction,refundV2Instruction,accountV2Instruction,returnCollateralV2Instruction,claimV2Instruction} from './client.mjs';
import {createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {launchAddresses,launchAuthority} from '../protocol-v2/client.mjs';
import {AddressLookupTableProgram} from '@solana/web3.js';
import {getMint,getAccount} from '@solana/spl-token';
import {commitInstruction,finalizeInstruction,settleInstruction,decodeCampaign,receiptAddress,decodeReceipt} from '../protocol-v2/client.mjs';
const record=JSON.parse(readFileSync(directory+'/kids-launch-v3-program.json','utf8'));
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(record.rpcUrl))throw Error('loopback only');
const connection=new Connection(record.rpcUrl,'confirmed'),programId=new PublicKey(record.programId);
const admin=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(key('v2-admin').path,'utf8'))));
if(admin.publicKey.toBase58()!==record.pilotCreator)throw Error('local pilot key differs from the program record');
const genesisHash=await connection.getGenesisHash();if(genesisHash!==record.genesisHash)throw Error('ledger changed');
const cid='QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
const J=v=>JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x);
const results=[];const ok=(name,cond,detail='')=>{results.push({name,ok:!!cond,detail});if(!cond)console.log('FAIL',name,detail);};
const custom=e=>{const m=/custom program error: 0x([0-9a-f]+)/i.exec(String(e?.message??e)+' '+JSON.stringify(e?.logs??[]));return m?parseInt(m[1],16):null;};
async function send(ixs,signers,label){const tx=new Transaction().add(...ixs);tx.feePayer=signers[0].publicKey;try{const sig=await sendAndConfirmTransaction(connection,tx,signers,{commitment:'confirmed'});const t=await connection.getTransaction(sig,{commitment:'confirmed',maxSupportedTransactionVersion:0});return {sig,cu:t?.meta?.computeUnitsConsumed??null,err:null};}catch(e){return {sig:null,cu:null,err:e,code:custom(e)};}}
async function fund(pub,lamports){const sig=await connection.requestAirdrop(pub,lamports);await connection.confirmTransaction(sig,'confirmed');}
if(await connection.getBalance(admin.publicKey)<5e9)await fund(admin.publicKey,20e9);
const fields=(nonce,mint,feeNft,{funding=8,window=60,soft=SOFT_FLOOR_LAMPORTS_V2}={})=>({creator:admin.publicKey.toBase58(),genesisHash,nonce:String(nonce),childMint:mint.toBase58(),opensAt:'0',fundingDurationSeconds:funding,launchWindowSeconds:window,softCapLamports:soft,hardCapLamports:String(10n*1_000_000_000n),ammConfigIndex:2,metadataHash:randomBytes(32).toString('hex'),metadataUri:CREATE_V3_URI_PREFIX+cid,displayHash:displayHash({name:'Funding First','symbol':'FF',uri:CREATE_V3_URI_PREFIX+cid}),feeNft:feeNft.toBase58()});
// 1. Pre-funded adversary: the smallest system account the runtime allows (rent-exempt minimum for zero data) at every
//    predictable address before the opening; the program must complete them with allocate + assign, never refuse them.
const mint=Keypair.generate(),feeNft=Keypair.generate(),nonce=BigInt('0x'+randomBytes(6).toString('hex'));
const open=openFundingInstruction(programId,fields(nonce,mint.publicKey,feeNft.publicKey));
const predictable=[mint.publicKey,feeNft.publicKey,extAddress(programId,open.campaign),mintReservationAddress(programId,mint.publicKey),nftReservationAddress(programId,feeNft.publicKey)];
const minimal=await connection.getMinimumBalanceForRentExemption(0);const pre=await send(predictable.map(to=>SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:to,lamports:minimal})),[admin],'prefund');ok('prefund transfers sent',!pre.err,String(pre.err?.message).slice(0,200));
for(const p of predictable){const i=await connection.getAccountInfo(p);ok('prefunded '+p.toBase58().slice(0,6),i&&i.lamports===minimal&&i.owner.equals(SystemProgram.programId)&&i.data.length===0);}
// 2. Opening: one transaction, signers creator + mint + fee NFT.
// Packet size of the complete submitted opening: budget, opening, setup transfer, three signatures (the same instructions `send` submits).
const openTx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:200000}),open.instruction,SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:launchAuthority(programId,open.campaign),lamports:500_000_000}));openTx.feePayer=admin.publicKey;openTx.recentBlockhash=(await connection.getLatestBlockhash()).blockhash;openTx.sign(admin,mint,feeNft);
const packetBytes=openTx.serialize().length;
// The creator's packet also funds the launch authority's setup budget (pool creation fee and rents), as tag 40's packet does today.
const authorityBudget=SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:launchAuthority(programId,open.campaign),lamports:500_000_000});
const opened=await send([ComputeBudgetProgram.setComputeUnitLimit({units:200000}),open.instruction,authorityBudget],[admin,mint,feeNft],'open');
ok('opening succeeded',!opened.err,opened.err?String(opened.err.message).slice(0,200):'');
const camp=await connection.getAccountInfo(open.campaign);
ok('record marker byte 992 = 2',camp&&camp.data[OFF_ACCOUNTING_VERSION]===2);
const decoded=camp?decodeCampaign(camp.data):null;
ok('record sealed: child mint, phase 0, total 0',decoded&&String(decoded.terms.childMint??decoded.terms.mint)===mint.publicKey.toBase58()&&decoded.state.phase===0&&String(decoded.state.total)==='0',J({childMint:decoded?.terms?.childMint,mint:decoded?.terms?.mint,phase:decoded?.state?.phase,total:decoded?.state?.total}));
const rent1024=await connection.getMinimumBalanceForRentExemption(1024);
ok('campaign holds rent + collateral (pre-funded lamports become part of the record balance)',camp&&camp.lamports===rent1024+Number(COLLATERAL_LAMPORTS_V2),camp?String(camp.lamports)+' vs '+(rent1024+65535):'');
const extInfo=await connection.getAccountInfo(extAddress(programId,open.campaign));const ext=extInfo?decodeExt(extInfo.data):null;
ok('extension header',ext&&ext.campaign===open.campaign.toBase58()&&ext.mint===mint.publicKey.toBase58()&&ext.feeNft===feeNft.publicKey.toBase58()&&ext.version===2&&!ext.sealed&&ext.displayHash===fields(nonce,mint.publicKey,feeNft.publicKey).displayHash&&extInfo.owner.equals(programId),J(ext).slice(0,200));
ok('extension terms hash = record terms hash',ext&&decoded&&ext.termsHash===Buffer.from(camp.data.subarray(808,840)).toString('hex'));
for(const [label,addr,k] of [['mint reservation',mintReservationAddress(programId,mint.publicKey),mint.publicKey],['nft reservation',nftReservationAddress(programId,feeNft.publicKey),feeNft.publicKey]]){const i=await connection.getAccountInfo(addr);const r=i?decodeReservation(i.data):null;ok(label,r&&r.campaign===open.campaign.toBase58()&&r.key===k.toBase58()&&i.owner.equals(programId));}
for(const p of [mint.publicKey,feeNft.publicKey]){const i=await connection.getAccountInfo(p);ok('no token account exists for '+p.toBase58().slice(0,6),i===null||(i.owner.equals(SystemProgram.programId)&&i.data.length===0));}
// Lookup tables for the 33-account launch packets: created and extended on the ledger, one slot of warm-up.
const evidence={rounds:[]};
async function makeTable(ix){const addresses=[...new Set(ix.keys.filter(k=>!k.isSigner).map(k=>k.pubkey.toBase58()))].map(k=>new PublicKey(k));const [create,key]=AddressLookupTableProgram.createLookupTable({authority:admin.publicKey,payer:admin.publicKey,recentSlot:await connection.getSlot('finalized')});const c=await send([create],[admin],'table');if(c.err)throw Error('table create: '+c.err.message);for(let i=0;i<addresses.length;i+=20){const e=await send([AddressLookupTableProgram.extendLookupTable({payer:admin.publicKey,authority:admin.publicKey,lookupTable:key,addresses:addresses.slice(i,i+20)})],[admin],'extend');if(e.err)throw Error('table extend: '+e.err.message);}await new Promise(r=>setTimeout(r,2500));const table=(await connection.getAddressLookupTable(key)).value;if(!table||table.state.addresses.length!==addresses.length)throw Error('table not active');return {key,table,count:addresses.length};}
async function sendV0With(table,ixs,signers){const bh=await connection.getLatestBlockhash('confirmed');const msg=new TransactionMessage({payerKey:signers[0].publicKey,recentBlockhash:bh.blockhash,instructions:ixs}).compileToV0Message([table]);const tx=new VersionedTransaction(msg);tx.sign(signers);const bytes=tx.serialize().length;try{const sig=await connection.sendTransaction(tx,{skipPreflight:false});await connection.confirmTransaction({signature:sig,...bh},'confirmed');const t=await connection.getTransaction(sig,{commitment:'confirmed',maxSupportedTransactionVersion:0});return {sig,bytes,cu:t?.meta?.computeUnitsConsumed??null,err:t?.meta?.err??null,logs:t?.meta?.logMessages??[]};}catch(e){let logs=e?.logs??[];try{const sim=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});logs=sim.value.logs??logs;}catch{}return {sig:null,bytes,cu:null,err:e,code:custom({message:String(e?.message)+' '+JSON.stringify(logs)}),logs};}}
async function probeV0(table,ixs,signers){const bh=await connection.getLatestBlockhash('confirmed');const msg=new TransactionMessage({payerKey:signers[0].publicKey,recentBlockhash:bh.blockhash,instructions:ixs}).compileToV0Message([table]);const tx=new VersionedTransaction(msg);tx.sign(signers);const sim=await connection.simulateTransaction(tx,{sigVerify:true}).catch(e=>({value:{err:String(e.message),logs:[]}}));return {code:custom({message:JSON.stringify(sim.value?.err??'')+' '+JSON.stringify(sim.value?.logs??[])}),err:sim.value?.err??null};}
// 3. Duplicate binding of the same mint by a second opening is refused (reservation exists).
const dup=openFundingInstruction(programId,fields(nonce+1n,mint.publicKey,Keypair.generate().publicKey));
const dupRes=await send([dup.instruction],[admin,mint,Keypair.fromSecretKey(Keypair.generate().secretKey)],'dup');
// the second fee NFT must sign: rebuild with a proper keypair
const nft2=Keypair.generate();const dup2=openFundingInstruction(programId,fields(nonce+2n,mint.publicKey,nft2.publicKey));const dupRes2=await send([dup2.instruction],[admin,mint,nft2],'dup2');
ok('duplicate mint binding refused with openBody (106)',dupRes2.err&&dupRes2.code===106,'code '+dupRes2.code+' '+String(dupRes2.err?.message).slice(0,120));
// 4. Commits: the minimum applies to a NEW receipt; a top-up below it is fine; the cap is a program constant.
const alice=Keypair.generate(),bob=Keypair.generate();await fund(alice.publicKey,2e9);await fund(bob.publicKey,2e9);
const c1=await send([commitInstruction(programId,open.campaign,alice.publicKey,genesisHash,20_000_000n,0n)],[alice],'commit');ok('commit 0.02 SOL accepted',!c1.err,String(c1.err?.message).slice(0,120));
const c2=await send([commitInstruction(programId,open.campaign,bob.publicKey,genesisHash,500_000n,0n)],[bob],'commit-small');ok('new receipt below the minimum refused (107)',c2.err&&c2.code===107,'code '+c2.code);
const c3=await send([commitInstruction(programId,open.campaign,alice.publicKey,genesisHash,1_000n,1n)],[alice],'topup');ok('top-up below the minimum accepted',!c3.err,String(c3.err?.message).slice(0,120));
const rec=await connection.getAccountInfo(receiptAddress(programId,open.campaign,alice.publicKey));const r=rec?decodeReceipt(rec.data):null;ok('receipt committed 20,001,000',r&&String(r.committed)==='20001000',J(r).slice(0,120));
// 5. Old money tags are refused on the version-2 record (after the deadline, when they would otherwise run). Before the
//    deadline the version-2 launch itself is refused as not ready (12): submitted here with a legacy-size probe (an early
//    submission fails in the program, not on packet size: the instruction is checked before any account is touched).
const earlyTerms={...decoded.terms,childMint:mint.publicKey,ammProgram:new PublicKey(decoded.terms.ammProgram),ammConfig:new PublicKey(decoded.terms.ammConfig),lockProgram:new PublicKey(decoded.terms.lockProgram)};
const earlyLaunch=launchFundingFirstInstruction(programId,open.campaign,earlyTerms,admin.publicKey,feeNft.publicKey,{name:'Funding First',symbol:'FF',uri:CREATE_V3_URI_PREFIX+cid});
const mainTable=await makeTable(earlyLaunch.instruction);
{const early=await probeV0(mainTable.table,[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),earlyLaunch.instruction],[admin,mint,feeNft]);ok('launch before the deadline refused by the program (not ready, 12)',early.code===12,'code '+early.code+' '+JSON.stringify(early.err).slice(0,120));}
// 5. Old money tags are refused on the version-2 record (after the deadline, when they would otherwise run).
const deadline=Number(decoded.terms.deadline);while(await chainTime(connection)<deadline+1)await new Promise(r=>setTimeout(r,500));
const fin=await send([finalizeInstruction(programId,open.campaign)],[admin],'finalize');ok('finalize (tag 2) refused with accountingVersion (105)',fin.err&&fin.code===105,'code '+fin.code);
const set=await send([settleInstruction(programId,open.campaign,alice.publicKey)],[admin],'settle');ok('settle (tag 4) refused with accountingVersion (105)',set.err&&set.code===105,'code '+set.code);
const after=decodeCampaign((await connection.getAccountInfo(open.campaign)).data);ok('version-2 record unchanged by refused tags: phase 0, total 20,001,000',after.state.phase===0&&String(after.state.total)==='20001000');
// 5b. Launch before the deadline is refused (not ready, 12); after the deadline the keeper launches with tag 42 through
//     a lookup table (the 33-account packet does not fit a legacy transaction), one v0 transaction, signers keeper + mint + fee NFT.
const display={name:'Funding First',symbol:'FF',uri:CREATE_V3_URI_PREFIX+cid};
const decodedTerms=decodeCampaign((await connection.getAccountInfo(open.campaign)).data).terms;
const termsForLaunch={...decodedTerms,childMint:mint.publicKey,ammProgram:new PublicKey(decodedTerms.ammProgram),ammConfig:new PublicKey(decodedTerms.ammConfig),lockProgram:new PublicKey(decodedTerms.lockProgram)};
const launch=launchFundingFirstInstruction(programId,open.campaign,termsForLaunch,admin.publicKey,feeNft.publicKey,display);
const tableAddresses=mainTable.table.state.addresses,tableKey=mainTable.key,table=mainTable.table;ok('lookup table active with '+tableAddresses.length+' addresses (built before the deadline)',tableAddresses.length===mainTable.count);
async function sendV0(ixs,signers,label){const bh=await connection.getLatestBlockhash('confirmed');const msg=new TransactionMessage({payerKey:signers[0].publicKey,recentBlockhash:bh.blockhash,instructions:ixs}).compileToV0Message([table]);const tx=new VersionedTransaction(msg);tx.sign(signers);const bytes=tx.serialize().length;try{const sig=await connection.sendTransaction(tx,{skipPreflight:false});await connection.confirmTransaction({signature:sig,...bh},'confirmed');const t=await connection.getTransaction(sig,{commitment:'confirmed',maxSupportedTransactionVersion:0});return {sig,bytes,cu:t?.meta?.computeUnitsConsumed??null,err:t?.meta?.err??null,logs:t?.meta?.logMessages??[]};}catch(e){let logs=e?.logs??[];try{const sim=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});logs=sim.value.logs??logs;}catch{}return {sig:null,bytes,cu:null,err:e,code:custom({message:String(e?.message)+' '+JSON.stringify(logs)}),logs};}}
const budget=[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000})];
const launched=await sendV0([...budget,launch.instruction],[admin,mint,feeNft],'launch42');
ok('tag 42 launch succeeded',!launched.err,launched.err?(String(launched.err?.message??launched.err).slice(0,200)+' | code '+launched.code+' | '+(launched.logs||[]).slice(-6).join(' // ').slice(0,900)):'');
const live=decodeCampaign((await connection.getAccountInfo(open.campaign)).data);
ok('record phase 3 (live), launch time and pool recorded',live.state.phase===3&&Number(live.state.launchTime)>0&&String(live.state.pool)!=='11111111111111111111111111111111',J({phase:live.state.phase,pool:live.state.pool}));
const extAfter=decodeExt((await connection.getAccountInfo(extAddress(programId,open.campaign))).data);
ok('extension sealed: N 1, T 20,001,000, A 20,001,000',extAfter.sealed&&extAfter.sealedReceipts===1&&extAfter.sealedTotal==='20001000'&&extAfter.acceptedTarget==='20001000',J(extAfter).slice(0,200));
const addrs=launchAddresses(programId,open.campaign,termsForLaunch,feeNft.publicKey);
const mintInfo=await getMint(connection,mint.publicKey,'confirmed').catch(e=>null);
ok('child mint exists: supply 1e15, decimals 6, no mint or freeze authority',mintInfo&&mintInfo.supply===1000000000000000n&&mintInfo.decimals===6&&mintInfo.mintAuthority===null&&mintInfo.freezeAuthority===null,mintInfo?J({supply:mintInfo.supply,ma:mintInfo.mintAuthority,fa:mintInfo.freezeAuthority}):'no mint');
const custody=await getAccount(connection,addrs.child,'confirmed').catch(()=>null);
ok('custody holds supply minus liquidity (525e12)',custody&&custody.amount===525000000000000n,custody?String(custody.amount):'none');
const lockVault=await getAccount(connection,addrs.lockVault,'confirmed').catch(()=>null);const lp=await getAccount(connection,addrs.lp,'confirmed').catch(()=>null);
const lpMintInfo=await getMint(connection,addrs.lpMint,'confirmed').catch(()=>null);
ok('all LP locked: lock vault = LP mint supply, launch authority LP 0',lockVault&&lpMintInfo&&lockVault.amount>0n&&lockVault.amount===lpMintInfo.supply&&(!lp||lp.amount===0n),J({locked:lockVault?.amount,supply:lpMintInfo?.supply,lp:lp?.amount}));
const pool=await connection.getAccountInfo(addrs.pool);ok('pool state exists (637 bytes, AMM-owned)',pool&&pool.data.length===637&&pool.owner.equals(termsForLaunch.ammProgram));
const solVault=await getAccount(connection,addrs.vault0.equals(addrs.wsol)?addrs.vault1:addrs.vault0,'confirmed').catch(()=>null);
const vaults=[await getAccount(connection,addrs.vault0,'confirmed').catch(()=>null),await getAccount(connection,addrs.vault1,'confirmed').catch(()=>null)];
const wsolVault=vaults.find(v=>v&&v.mint.equals(new PublicKey('So11111111111111111111111111111111111111112')));
ok('WSOL vault holds the accepted target 20,001,000',wsolVault&&wsolVault.amount===20001000n,J({wsol:wsolVault?.amount}));
const campAfter=await connection.getAccountInfo(open.campaign);
ok('campaign keeps rent + collateral after launch (excess 0)',campAfter&&campAfter.lamports===rent1024+Number(COLLATERAL_LAMPORTS_V2),String(campAfter?.lamports)+' vs '+(rent1024+65535));
const metaInfo=await connection.getAccountInfo(launch.instruction.keys[30].pubkey);ok('child metadata account created by the metadata program',metaInfo&&metaInfo.owner.toBase58()==='metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const again=await sendV0([...budget,launch.instruction],[admin,mint,feeNft],'launch42-again');ok('second launch refused (not ready, 12)',again.err&&again.code===12,'code '+again.code);
const lateCommit=await send([commitInstruction(programId,open.campaign,bob.publicKey,genesisHash,2_000_000n,0n)],[bob],'late-commit');ok('commit after the deadline refused (fundingClosed 2)',lateCommit.err&&lateCommit.code===2,'code '+lateCommit.code);
const launchStats={launchSignature:launched.sig,launchPacketBytes:launched.bytes,launchComputeUnits:launched.cu,lookupTable:tableKey.toBase58(),tableAddresses:tableAddresses.length};
// 5c. After the launch: exact-once accounting, the collateral return (R - d, d = 0 here) and the Q claim of the only receipt.
const acc1=await send([accountV2Instruction(programId,open.campaign,alice.publicKey)],[admin],'account');ok('accounting of the receipt succeeded',!acc1.err,String(acc1.err?.message).slice(0,160));
const acc2=await send([accountV2Instruction(programId,open.campaign,alice.publicKey)],[admin],'account-again');ok('second accounting of the same receipt refused (109)',acc2.err&&acc2.code===109,'code '+acc2.code);
const extAcc=decodeExt((await connection.getAccountInfo(extAddress(programId,open.campaign))).data);ok('extension accounted 1/1, accepted sum = A',extAcc.accountedCount===1&&extAcc.accountedAccepted==='20001000',J(extAcc).slice(0,160));
const creatorBefore=await connection.getBalance(admin.publicKey);
const ret=await send([returnCollateralV2Instruction(programId,open.campaign,admin.publicKey)],[bob],'return');ok('collateral return after full accounting succeeded (permissionless payer)',!ret.err,String(ret.err?.message).slice(0,160));
ok('creator received R - d = 65,535',(await connection.getBalance(admin.publicKey))-creatorBefore===65535);
ok('campaign now holds exactly its rent',(await connection.getAccountInfo(open.campaign)).lamports===rent1024);
const ret2=await send([returnCollateralV2Instruction(programId,open.campaign,admin.publicKey)],[bob],'return-again');ok('second collateral return refused (109)',ret2.err&&ret2.code===109,'code '+ret2.code);
const aliceAta=getAssociatedTokenAddressSync(mint.publicKey,alice.publicKey);
const cl=await send([createAssociatedTokenAccountIdempotentInstruction(alice.publicKey,aliceAta,alice.publicKey,mint.publicKey),claimV2Instruction(programId,open.campaign,mint.publicKey,alice.publicKey)],[alice],'claim');ok('Q claim succeeded',!cl.err,String(cl.err?.message).slice(0,160));
const aliceTokens=await getAccount(connection,aliceAta,'confirmed').catch(()=>null);ok('sole participant received the whole participant reserve (475e12 raw)',aliceTokens&&aliceTokens.amount===475000000000000n,String(aliceTokens?.amount));
const cl2=await send([claimV2Instruction(programId,open.campaign,mint.publicKey,alice.publicKey)],[alice],'claim-again');ok('second claim is a no-op (paid once)',!cl2.err&&(await getAccount(connection,aliceAta,'confirmed')).amount===475000000000000n);
const liveAfter=decodeCampaign((await connection.getAccountInfo(open.campaign)).data);ok('participant_claimed = reserve, refunded 0',String(liveAfter.state.participantClaimed)==='475000000000000'&&String(liveAfter.state.refunded)==='0');

// 7. Failed round (soft cap missed): open, commit below the soft cap, close after the deadline → refund only; full refund; R back.
async function openRound(label,{funding,window,soft,hard,commits}){
 const m=Keypair.generate(),n=Keypair.generate(),nonce=BigInt('0x'+randomBytes(6).toString('hex'));
 const f=fields(nonce,m.publicKey,n.publicKey,{funding,window,soft});if(hard)f.hardCapLamports=hard;
 const o=openFundingInstruction(programId,f);
 const r=await send([ComputeBudgetProgram.setComputeUnitLimit({units:200000}),o.instruction,SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:launchAuthority(programId,o.campaign),lamports:500_000_000})],[admin,m,n],label+'-open');ok(label+': opened',!r.err,String(r.err?.message).slice(0,160));
 const wallets=[];for(const amount of commits){const w=Keypair.generate();await fund(w.publicKey,Number(amount)+50_000_000);const c=await send([commitInstruction(programId,o.campaign,w.publicKey,genesisHash,amount,0n)],[w],label+'-commit');ok(label+': commit '+amount,!c.err,String(c.err?.message).slice(0,160));wallets.push(w);}
 const terms=decodeCampaign((await connection.getAccountInfo(o.campaign)).data).terms;
 return {campaign:o.campaign,mint:m,nft:n,wallets,terms,fields:f};
}
const waitPast=async t=>{while(await chainTime(connection)<t+1)await new Promise(r=>setTimeout(r,500));};
const B=await openRound('B',{funding:6,window:30,soft:SOFT_FLOOR_LAMPORTS_V2,commits:[5_000_000n]});
await waitPast(Number(B.terms.deadline));
const closeB=await send([closeV2Instruction(programId,B.campaign)],[bob],'B-close');ok('B: close after the deadline succeeded',!closeB.err,String(closeB.err?.message).slice(0,160));
ok('B: phase 2 (refund only)',decodeCampaign((await connection.getAccountInfo(B.campaign)).data).state.phase===2);
const bw=B.wallets[0];const balB=await connection.getBalance(bw.publicKey);
const refB=await send([refundV2Instruction(programId,B.campaign,bw.publicKey)],[bob],'B-refund');ok('B: full refund paid by anyone',!refB.err&&(await connection.getBalance(bw.publicKey))-balB===5_000_000,String(refB.err?.message).slice(0,160));
const refB2=await send([refundV2Instruction(programId,B.campaign,bw.publicKey)],[bob],'B-refund-again');ok('B: second refund is a no-op',!refB2.err&&(await connection.getBalance(bw.publicKey))-balB===5_000_000);
const retB=await send([returnCollateralV2Instruction(programId,B.campaign,admin.publicKey)],[bob],'B-return');ok('B: collateral R returned on failure',!retB.err&&(await connection.getAccountInfo(B.campaign)).lamports===rent1024,String(retB.err?.message).slice(0,160)+' lamports '+(await connection.getAccountInfo(B.campaign)).lamports);
const lB=launchFundingFirstInstruction(programId,B.campaign,{...B.terms,childMint:B.mint.publicKey,ammProgram:new PublicKey(B.terms.ammProgram),ammConfig:new PublicKey(B.terms.ammConfig),lockProgram:new PublicKey(B.terms.lockProgram)},admin.publicKey,B.nft.publicKey,display);
const launchB=await sendV0([...budget,lB.instruction],[admin,B.mint,B.nft],'B-launch');ok('B: launch of a failed round refused (not ready, 12)',launchB.err&&launchB.code===12,'code '+launchB.code);

// 8. Missed launch deadline: funded above the soft cap, nobody launches, the second close after the launch deadline fails the round.
const C=await openRound('C',{funding:6,window:6,soft:SOFT_FLOOR_LAMPORTS_V2,commits:[8_000_000n]});
await waitPast(Number(C.terms.deadline));
const closeC=await send([closeV2Instruction(programId,C.campaign)],[bob],'C-close');ok('C: close seals totals and moves to phase 1',!closeC.err&&decodeCampaign((await connection.getAccountInfo(C.campaign)).data).state.phase===1,String(closeC.err?.message).slice(0,160));
const extC=decodeExt((await connection.getAccountInfo(extAddress(programId,C.campaign))).data);ok('C: sealed T 8,000,000 = A, N 1',extC.sealed&&extC.sealedTotal==='8000000'&&extC.acceptedTarget==='8000000'&&extC.sealedReceipts===1);
const earlyRet=await send([returnCollateralV2Instruction(programId,C.campaign,admin.publicKey)],[bob],'C-early-return');ok('C: collateral return before launch or failure refused (109)',earlyRet.err&&earlyRet.code===109,'code '+earlyRet.code);
await waitPast(Number(C.terms.launchDeadline));
const closeC2=await send([closeV2Instruction(programId,C.campaign)],[bob],'C-close-2');ok('C: second close after the launch deadline → phase 2',!closeC2.err&&decodeCampaign((await connection.getAccountInfo(C.campaign)).data).state.phase===2,String(closeC2.err?.message).slice(0,160));
const cw=C.wallets[0];const balC=await connection.getBalance(cw.publicKey);
const refC=await send([refundV2Instruction(programId,C.campaign,cw.publicKey)],[bob],'C-refund');ok('C: full refund after the missed launch deadline',!refC.err&&(await connection.getBalance(cw.publicKey))-balC===8_000_000,String(refC.err?.message).slice(0,160));
const retC=await send([returnCollateralV2Instruction(programId,C.campaign,admin.publicKey)],[bob],'C-return');ok('C: collateral R returned; campaign holds rent',!retC.err&&(await connection.getAccountInfo(C.campaign)).lamports===rent1024,String(retC.err?.message).slice(0,160));

// 8b. Content binding: an opening that committed the display hash over URI_B while sealing URI_A. Launch data with the
//     sealed URI (A) fails the display-hash check; launch data with URI_B fails the sealed-URI check; both refused with 108.
{
 const m=Keypair.generate(),n=Keypair.generate(),nonce=BigInt('0x'+randomBytes(6).toString('hex'));
 const f=fields(nonce,m.publicKey,n.publicKey,{funding:6,window:60});f.displayHash=displayHash({name:'Funding First',symbol:'FF',uri:CREATE_V3_URI_PREFIX+'QmSomeOtherCidThatIsNotTheSealedOneXXXXXXXXXXXXX'});
 const o=openFundingInstruction(programId,f);const r=await send([ComputeBudgetProgram.setComputeUnitLimit({units:200000}),o.instruction,SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:launchAuthority(programId,o.campaign),lamports:500_000_000})],[admin,m,n],'E-open');ok('E: opened with a display hash over another URI (the program cannot know at opening)',!r.err,String(r.err?.message).slice(0,160));
 const w=Keypair.generate();await fund(w.publicKey,60_000_000);await send([commitInstruction(programId,o.campaign,w.publicKey,genesisHash,8_000_000n,0n)],[w],'E-commit');
 const t=decodeCampaign((await connection.getAccountInfo(o.campaign)).data).terms;await waitPast(Number(t.deadline));
 const et={...t,childMint:m.publicKey,ammProgram:new PublicKey(t.ammProgram),ammConfig:new PublicKey(t.ammConfig),lockProgram:new PublicKey(t.lockProgram)};
 const withSealed=launchFundingFirstInstruction(programId,o.campaign,et,admin.publicKey,n.publicKey,{name:'Funding First',symbol:'FF',uri:CREATE_V3_URI_PREFIX+cid});
 const withOther=launchFundingFirstInstruction(programId,o.campaign,et,admin.publicKey,n.publicKey,{name:'Funding First',symbol:'FF',uri:CREATE_V3_URI_PREFIX+'QmSomeOtherCidThatIsNotTheSealedOneXXXXXXXXXXXXX'});
 const tE=await makeTable(withSealed.instruction);
 const pSealed=await probeV0(tE.table,[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),withSealed.instruction],[admin,m,n]),pOther=await probeV0(tE.table,[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),withOther.instruction],[admin,m,n]);
 ok('E: launch data with the sealed URI but a foreign display commitment refused (108)',pSealed.code===108,'code '+pSealed.code);
 ok('E: launch data with the committed but unsealed URI refused (108)',pOther.code===108,'code '+pOther.code);
 evidence.rounds.push({round:'E-content-binding',campaign:o.campaign.toBase58(),probes:{sealedUri:pSealed.code,otherUri:pOther.code}});
}
// 9. Oversubscribed round with excess refunds BEFORE launch, then launch, accounting and the R - d return (the dust identity on the ledger).
const softD=BigInt(SOFT_FLOOR_LAMPORTS_V2),hardD=softD+(softD+99n)/100n; // 6,553,500 and 6,619,035
const D=await openRound('D',{funding:8,window:90,soft:String(softD),hard:String(hardD),commits:[5_000_000n,3_000_000n]});
await waitPast(Number(D.terms.deadline));
const [dA,dB]=D.wallets;const balDA=await connection.getBalance(dA.publicKey),balDB=await connection.getBalance(dB.publicKey);
const rDA=await send([refundV2Instruction(programId,D.campaign,dA.publicKey)],[bob],'D-refund-A');const rDB=await send([refundV2Instruction(programId,D.campaign,dB.publicKey)],[bob],'D-refund-B');
const gotA=(await connection.getBalance(dA.publicKey))-balDA,gotB=(await connection.getBalance(dB.publicKey))-balDB;
ok('D: excess refunds before launch: 863,104 and 517,862 (sum T - S = T - A + 1)',!rDA.err&&!rDB.err&&gotA===863104&&gotB===517862,J({gotA,gotB,eA:String(rDA.err?.message).slice(0,80),eB:String(rDB.err?.message).slice(0,80)}));
const lD=launchFundingFirstInstruction(programId,D.campaign,{...D.terms,childMint:D.mint.publicKey,ammProgram:new PublicKey(D.terms.ammProgram),ammConfig:new PublicKey(D.terms.ammConfig),lockProgram:new PublicKey(D.terms.lockProgram)},admin.publicKey,D.nft.publicKey,display);
const tableD=[...new Set(lD.instruction.keys.filter(k=>!k.isSigner).map(k=>k.pubkey.toBase58()))].map(k=>new PublicKey(k));
const [ctD,tkD]=AddressLookupTableProgram.createLookupTable({authority:admin.publicKey,payer:admin.publicKey,recentSlot:await connection.getSlot('finalized')});
await send([ctD],[admin],'D-table');for(let i=0;i<tableD.length;i+=20)await send([AddressLookupTableProgram.extendLookupTable({payer:admin.publicKey,authority:admin.publicKey,lookupTable:tkD,addresses:tableD.slice(i,i+20)})],[admin],'D-extend');await new Promise(r=>setTimeout(r,2500));
const tD=(await connection.getAddressLookupTable(tkD)).value;
const sendV0D=async(ixs,signers)=>{const bh=await connection.getLatestBlockhash('confirmed');const msg=new TransactionMessage({payerKey:signers[0].publicKey,recentBlockhash:bh.blockhash,instructions:ixs}).compileToV0Message([tD]);const tx=new VersionedTransaction(msg);tx.sign(signers);try{const sig=await connection.sendTransaction(tx);await connection.confirmTransaction({signature:sig,...bh},'confirmed');const t=await connection.getTransaction(sig,{commitment:'confirmed',maxSupportedTransactionVersion:0});return {sig,cu:t?.meta?.computeUnitsConsumed,err:null};}catch(e){let logs=e?.logs??[];try{const sim=await connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});logs=sim.value.logs??logs;}catch{}return {sig:null,err:e,code:custom({message:String(e?.message)+' '+JSON.stringify(logs)}),logs};}};
const launchD=await sendV0D([...budget,lD.instruction],[admin,D.mint,D.nft]);ok('D: launch after excess refunds succeeded (liability = R - 1 kept)',!launchD.err,launchD.err?String(launchD.err?.message).slice(0,160)+' code '+launchD.code+' '+(launchD.logs||[]).slice(-4).join(' // ').slice(0,400):'');
const campD=await connection.getAccountInfo(D.campaign);ok('D: campaign keeps rent + R - 1 after launch (dust 1 lamport came from the collateral)',campD&&campD.lamports===rent1024+65534,String(campD?.lamports)+' vs '+(rent1024+65534));
for(const w of D.wallets){const r=await send([accountV2Instruction(programId,D.campaign,w.publicKey)],[bob],'D-account');ok('D: accounted '+w.publicKey.toBase58().slice(0,6),!r.err,String(r.err?.message).slice(0,120));}
const extD=decodeExt((await connection.getAccountInfo(extAddress(programId,D.campaign))).data);ok('D: accounted 2/2, accepted sum S = 6,619,034 = A - 1',extD.accountedCount===2&&extD.accountedAccepted==='6619034'&&extD.acceptedTarget==='6619035',J(extD).slice(0,200));
const cB=await connection.getBalance(admin.publicKey);const retD=await send([returnCollateralV2Instruction(programId,D.campaign,admin.publicKey)],[bob],'D-return');
ok('D: return pays R - d = 65,534 and the campaign holds exactly its rent',!retD.err&&(await connection.getBalance(admin.publicKey))-cB===65534&&(await connection.getAccountInfo(D.campaign)).lamports===rent1024,String(retD.err?.message).slice(0,160)+' got '+((await connection.getBalance(admin.publicKey))-cB));
for(const [w,expect] of [[dA,4136896n],[dB,2482138n]]){const ata=getAssociatedTokenAddressSync(D.mint.publicKey,w.publicKey);const c=await send([createAssociatedTokenAccountIdempotentInstruction(w.publicKey,ata,w.publicKey,D.mint.publicKey),claimV2Instruction(programId,D.campaign,D.mint.publicKey,w.publicKey)],[w],'D-claim');const bal=(await getAccount(connection,ata,'confirmed').catch(()=>null))?.amount;const q=475000000000000n*expect/6619035n;ok('D: claim of '+w.publicKey.toBase58().slice(0,6)+' = floor(P*a/A) = '+q,!c.err&&bal===q,String(c.err?.message).slice(0,120)+' bal '+bal);}
const finalD=decodeCampaign((await connection.getAccountInfo(D.campaign)).data);ok('D: participant_claimed = sum of Q claims (residual stays in custody)',String(finalD.state.participantClaimed)===String(475000000000000n*4136896n/6619035n+475000000000000n*2482138n/6619035n));

// 10. Combined path: oversubscribed, excess refunds paid BEFORE the launch deadline, then the launch deadline is missed (full
//     remaining refunds); the collateral R is returned while refunds are still outstanding, and those refunds still complete.
{
 const F=await openRound('F',{funding:6,window:8,soft:String(softD),hard:String(hardD),commits:[5_000_000n,3_000_000n]});
 await waitPast(Number(F.terms.deadline));
 const [fA,fB]=F.wallets;const b0A=await connection.getBalance(fA.publicKey),b0B=await connection.getBalance(fB.publicKey);
 const e1=await send([refundV2Instruction(programId,F.campaign,fA.publicKey)],[bob],'F-excess-A');
 ok('F: excess refund of A before the launch deadline: 863,104',!e1.err&&(await connection.getBalance(fA.publicKey))-b0A===863104,String(e1.err?.message).slice(0,120));
 await waitPast(Number(F.terms.launchDeadline));
 const closeF=await send([closeV2Instruction(programId,F.campaign)],[bob],'F-close');ok('F: close after the missed launch deadline → phase 2',!closeF.err&&decodeCampaign((await connection.getAccountInfo(F.campaign)).data).state.phase===2,String(closeF.err?.message).slice(0,120));
 const cB=await connection.getBalance(admin.publicKey);const retF=await send([returnCollateralV2Instruction(programId,F.campaign,admin.publicKey)],[bob],'F-return');
 ok('F: R returned while both refunds are still outstanding',!retF.err&&(await connection.getBalance(admin.publicKey))-cB===65535,String(retF.err?.message).slice(0,120));
 const campMid=await connection.getAccountInfo(F.campaign);ok('F: after the return the campaign still holds rent + every unpaid commitment',campMid.lamports===rent1024+(5_000_000-863104)+3_000_000,String(campMid.lamports)+' vs '+(rent1024+5_000_000-863104+3_000_000));
 const r2=await send([refundV2Instruction(programId,F.campaign,fA.publicKey)],[bob],'F-full-A');const r3=await send([refundV2Instruction(programId,F.campaign,fB.publicKey)],[bob],'F-full-B');
 ok('F: remaining refunds complete: A gets 5,000,000 in total, B 3,000,000',!r2.err&&!r3.err&&(await connection.getBalance(fA.publicKey))-b0A===5_000_000&&(await connection.getBalance(fB.publicKey))-b0B===3_000_000,J({A:(await connection.getBalance(fA.publicKey))-b0A,B:(await connection.getBalance(fB.publicKey))-b0B}));
 ok('F: campaign ends with exactly its rent',(await connection.getAccountInfo(F.campaign)).lamports===rent1024);
 const lF=launchFundingFirstInstruction(programId,F.campaign,{...F.terms,childMint:F.mint.publicKey,ammProgram:new PublicKey(F.terms.ammProgram),ammConfig:new PublicKey(F.terms.ammConfig),lockProgram:new PublicKey(F.terms.lockProgram)},admin.publicKey,F.nft.publicKey,display);
 const tF=await makeTable(lF.instruction);const lateLaunch=await probeV0(tF.table,[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),lF.instruction],[admin,F.mint,F.nft]);
 ok('F: launch after the launch deadline refused (not ready, 12)',lateLaunch.code===12,'code '+lateLaunch.code);
 evidence.rounds.push({round:'F-excess-then-expiry',campaign:F.campaign.toBase58(),signatures:{excessRefund:e1.sig,close:closeF.sig,collateralReturn:retF.sig,refundA:r2.sig,refundB:r3.sig},lateLaunchCode:lateLaunch.code});
}
// 6. Version 0 control: tag 40 creation with the same shape, commit, finalize after the deadline works as before.
const mint0=Keypair.generate();const f0=fields(nonce+7n,mint0.publicKey,Keypair.generate().publicKey,{funding:6});delete f0.displayHash;delete f0.feeNft;
const create0=compactCreateInstruction(programId,f0);const cr=await send([create0.instruction],[admin],'create40');ok('version-0 creation (tag 40) still works',!cr.err,String(cr.err?.message).slice(0,120));
const rec0=await connection.getAccountInfo(create0.campaign);ok('version-0 record marker byte 992 = 0',rec0&&rec0.data[OFF_ACCOUNTING_VERSION]===0);
const c0=await send([commitInstruction(programId,create0.campaign,bob.publicKey,genesisHash,500_000n,0n)],[bob],'commit0');ok('version-0 commit below the v2 minimum accepted (no limit)',!c0.err,String(c0.err?.message).slice(0,120));
const d0=Number(decodeCampaign(rec0.data).terms.deadline);while(await chainTime(connection)<d0+1)await new Promise(r=>setTimeout(r,500));
const fin0=await send([finalizeInstruction(programId,create0.campaign)],[admin],'finalize0');ok('version-0 finalize (tag 2) still works',!fin0.err,String(fin0.err?.message).slice(0,120));
const summary={programId:record.programId,sha256:record.sha256,genesisHash,at:new Date().toISOString(),campaign:open.campaign.toBase58(),openingSignature:opened.sig,openingComputeUnits:opened.cu,openingPacketBytes:packetBytes,...launchStats,rounds:[{round:'A-success',campaign:open.campaign.toBase58(),signatures:{opening:opened.sig,launch:launched.sig,account:acc1.sig,collateralReturn:ret.sig,claim:cl.sig}},{round:'B-soft-cap-missed',campaign:B.campaign.toBase58(),signatures:{close:closeB.sig,refund:refB.sig,collateralReturn:retB.sig}},{round:'C-launch-deadline-missed',campaign:C.campaign.toBase58(),signatures:{close:closeC.sig,close2:closeC2.sig,refund:refC.sig,collateralReturn:retC.sig}},{round:'D-oversubscribed',campaign:D.campaign.toBase58(),signatures:{refundA:rDA.sig,refundB:rDB.sig,launch:launchD.sig,collateralReturn:retD.sig}},...evidence.rounds],checks:results,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length};
writeFileSync(directory+'/funding-first-rehearsal.json',J(summary)+'\n',{mode:0o600});
console.log(J({...summary,checks:undefined,rounds:summary.rounds.length}));
if(results.some(r=>!r.ok))process.exitCode=1;
