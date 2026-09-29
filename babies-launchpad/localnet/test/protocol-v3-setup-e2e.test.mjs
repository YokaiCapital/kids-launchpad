// Real SBF/Raydium rehearsal on the existing isolated ledger; never mainnet.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';import {randomBytes,createHash} from 'node:crypto';
import {Connection,PublicKey,Keypair,Transaction,SystemProgram,ComputeBudgetProgram,sendAndConfirmTransaction,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {createMint,getOrCreateAssociatedTokenAccount,mintTo,setAuthority,AuthorityType,NATIVE_MINT,getAccount,getMint} from '@solana/spl-token';
import * as client from '../protocol-v2/client.mjs';import * as policy from '../protocol-v2/policy.mjs';
import {returnSetupInstruction} from '../protocol-v3/client.mjs';
import {openRegistry} from '../registry/registry.mjs';
import {createPublicWalletService} from '../protocol-v2/public-wallet.mjs';
import {decodePublicPacket,checkedSignedPacket} from '../../interaction-review/src/public/public-signing.mjs';
const path=new URL('../.runtime/kids-launch-v3-program.json',import.meta.url);
const manifest=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
if(!manifest&&process.env.KIDS_REQUIRE_LOCALNET_TESTS==='1')throw Error('Deploy local v3 rehearsal first');
const key=path=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path,'utf8'))));
const SOL=1_000_000_000n;
test('v3 terminal setup return preserves participant money, token claims and the old deployment',{skip:!manifest,timeout:240000},async t=>{
 assert.match(manifest.rpcUrl,/^http:\/\/127\.0\.0\.1:\d+$/);assert.equal(manifest.programVersion,3);assert.equal(manifest.layoutVersion,2);
 const connection=new Connection(manifest.rpcUrl,'confirmed'),programId=new PublicKey(manifest.programId),genesis=await connection.getGenesisHash();
 assert.equal(genesis,manifest.genesisHash);assert.ok((await connection.getAccountInfo(programId)).executable);
 const old=JSON.parse(readFileSync(new URL('../.runtime/kids-launch-v2-program.json',import.meta.url),'utf8'));
 assert.notEqual(manifest.programId,old.programId);assert.equal(genesis,old.genesisHash);
 const oldProgramBefore=(await connection.getAccountInfo(new PublicKey(old.programId))).data;
 const oldProgramData=new PublicKey(oldProgramBefore.subarray(4,36)),oldBinaryBefore=(await connection.getAccountInfo(oldProgramData)).data;
 const admin=key(manifest.adminKeyFile),treasury=key(manifest.treasuryKeyFile),dev=Keypair.generate(),stranger=Keypair.generate();
 assert.equal(admin.publicKey.toBase58(),manifest.pilotCreator);
 const send=async(instructions,signers=[],payer=admin)=>sendAndConfirmTransaction(connection,new Transaction().add(...instructions),[payer,...signers.filter(s=>!s.publicKey.equals(payer.publicKey))],{commitment:'confirmed'});
 const transfer=(from,to,n)=>SystemProgram.transfer({fromPubkey:from,toPubkey:to,lamports:n});
 await send([transfer(admin.publicKey,stranger.publicKey,3n*SOL)]);
 const balance=async k=>BigInt(await connection.getBalance(k));
 const time=async()=> (await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)).data.readBigInt64LE(32);
 const tier=client.AMM_CONFIG_TIERS[0],now=await time();
 const baseTerms=(nonce,childMint,soft,hard)=>({layoutVersion:2,mode:0,decimals:6,splitPolicy:policy.SPLIT_POLICY_STANDARD_V3,vestingRule:policy.VESTING_RULE_STANDARD_V3,feeRoutingVersion:1,creatorFeeEnabled:0,genesis:new PublicKey(genesis),creator:admin.publicKey,nonce,dev:dev.publicKey,treasury:treasury.publicKey,childMint,supply:1_000_000_000_000_000n,
  opensAt:now-5n,deadline:now+40n,launchDeadline:now+40n+3600n,soft,hard,ammProgram:client.RAYDIUM_CPMM,ammConfig:tier.address,ammTradeFeeRate:tier.tradeFeeRate,ammConfigIndex:tier.index,
  feeWeights:policy.FEE_WEIGHTS_STANDARD,splitBps:policy.SPLIT_STANDARD_V3,vesting:policy.VESTING_STANDARD_V3,buybackMaxSlippageBps:0,lockProgram:client.RAYDIUM_LOCK,distributionProgram:PublicKey.default,
  parentMint:[PublicKey.default,PublicKey.default],parentProgram:[PublicKey.default,PublicKey.default],parentSlot:[0,0],parentRoot:['00'.repeat(32),'00'.repeat(32)],parentSupply:[0,0],parentEligible:[0,0],parentExpirySeconds:0,
  metadataHash:createHash('sha256').update('kids-launch-v2 rehearsal '+nonce).digest(),metadataUri:'https://kids.fun/rehearsal/'+childMint.toBase58()+'.json',parentReferenceConfig:[0,0]});
 // A foreign creator cannot bypass the pilot, and a top-up in the same failed
 // transaction cannot leave an orphan balance at its derived authority.
 const foreignTerms={...baseTerms(randomBytes(8).readBigUInt64LE(),Keypair.generate().publicKey,SOL,2n*SOL),creator:stranger.publicKey};
 const foreign=client.createInstruction(programId,foreignTerms),foreignAuthority=client.launchAuthority(programId,foreign.campaign);
 await assert.rejects(send([transfer(stranger.publicKey,foreignAuthority,10_000_000n),foreign.instruction],[stranger]),/custom program error: 0x66/);
 assert.equal(await balance(foreignAuthority),0n);assert.equal(await connection.getAccountInfo(foreign.campaign),null);
 const mintA=await createMint(connection,admin,admin.publicKey,admin.publicKey,6);
 const termsA=baseTerms(randomBytes(8).readBigUInt64LE(),mintA,SOL/2n,SOL),createdA=client.createInstruction(programId,termsA),campaignA=createdA.campaign,authorityA=client.launchAuthority(programId,campaignA);
 const custody=await getOrCreateAssociatedTokenAccount(connection,admin,mintA,authorityA,true);
 await getOrCreateAssociatedTokenAccount(connection,admin,NATIVE_MINT,authorityA,true);
 await mintTo(connection,admin,mintA,custody.address,admin,termsA.supply);
 await setAuthority(connection,admin,mintA,admin,AuthorityType.MintTokens,authorityA);
 await setAuthority(connection,admin,mintA,admin,AuthorityType.FreezeAccount,authorityA);
 await send([createdA.instruction,transfer(admin.publicKey,authorityA,300_000_000n)]);
 const termsB=baseTerms(randomBytes(8).readBigUInt64LE(),Keypair.generate().publicKey,2n*SOL,3n*SOL),createdB=client.createInstruction(programId,termsB),campaignB=createdB.campaign,authorityB=client.launchAuthority(programId,campaignB);
 await send([createdB.instruction,transfer(admin.publicKey,authorityB,30_000_000n)]);
 const retA=()=>returnSetupInstruction(programId,campaignA,admin.publicKey,genesis);
 await assert.rejects(send([retA()],[],stranger),/custom program error: 0x64/,'creator and anyone else cannot withdraw while funding');
 await send([client.commitInstruction(programId,campaignA,stranger.publicKey,genesis,2n*SOL,0n)],[stranger]);
 await send([client.commitInstruction(programId,campaignB,stranger.publicKey,genesis,SOL/2n,0n)],[stranger]);
 while(await time()<termsA.deadline)await new Promise(r=>setTimeout(r,500));
 await send([client.finalizeInstruction(programId,campaignA),client.settleInstruction(programId,campaignA,stranger.publicKey)]);
 await assert.rejects(send([retA()],[],stranger),/custom program error: 0x64/,'settled but unlaunched still needs its setup budget');
 const nft=Keypair.generate(),launch=client.launchInstruction(programId,campaignA,termsA,admin.publicKey,nft.publicKey);
 await send([ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),launch.instruction],[nft]);
 assert.equal(client.decodeCampaign((await connection.getAccountInfo(campaignA)).data).state.phase,3);
 const refundLiabilityBefore=await balance(campaignA),custodyBefore=(await getAccount(connection,custody.address)).amount;
 const setup=await balance(authorityA),creatorBefore=await balance(admin.publicKey);assert.ok(setup>0n);
 // Adversarial inputs all fail before a transfer.
 const wrongCreator=returnSetupInstruction(programId,campaignA,stranger.publicKey,genesis);
 await assert.rejects(send([wrongCreator],[],stranger),/custom program error: 0x65/);
 const wrongScope=retA();wrongScope.keys[1].pubkey=authorityB;
 await assert.rejects(send([wrongScope],[],stranger),/custom program error: 0x65/);
 const participantEscrow=retA();participantEscrow.keys[1].pubkey=campaignA;
 await assert.rejects(send([participantEscrow],[],stranger),/custom program error: 0x65/);
 const feeCustody=retA();feeCustody.keys[1].pubkey=client.feeAuthority(programId,campaignA);
 await assert.rejects(send([feeCustody],[],stranger),/custom program error: 0x65/);
 await assert.rejects(send([returnSetupInstruction(programId,campaignA,admin.publicKey,Keypair.generate().publicKey)],[],stranger),/custom program error: 0xd/);
 const oldInstruction=retA();oldInstruction.programId=new PublicKey(old.programId);
 await assert.rejects(send([oldInstruction],[],stranger),/invalid instruction data/,'old program did not acquire a new withdrawal capability');
 const signature=await send([retA()],[],stranger);
 assert.equal(await balance(authorityA),0n);assert.equal(await balance(admin.publicKey)-creatorBefore,setup);
 assert.equal(await balance(campaignA),refundLiabilityBefore);assert.equal((await getAccount(connection,custody.address)).amount,custodyBefore);
 await send([retA()],[],stranger);assert.equal(await balance(admin.publicKey)-creatorBefore,setup,'repeat does not pay twice');
 // Returning setup must not prevent any paid participant entitlement.
 const beforeRefund=await balance(stranger.publicKey);await send([client.refundInstruction(programId,campaignA,stranger.publicKey)]);
 assert.equal(await balance(stranger.publicKey)-beforeRefund,SOL);
 const tokens=await getOrCreateAssociatedTokenAccount(connection,admin,mintA,stranger.publicKey);
 await send([client.claimParticipantInstruction(programId,campaignA,mintA,stranger.publicKey)]);
 assert.equal((await getAccount(connection,tokens.address)).amount,policy.split(termsA.supply,policy.SPLIT_STANDARD_V3).participants);
 const mint=await getMint(connection,mintA);assert.equal(mint.mintAuthority,null);assert.equal(mint.freezeAuthority,null);
 // A finalized failed raise returns setup independently of participant refunds.
 await send([client.finalizeInstruction(programId,campaignB)]);
 const beforeB=await balance(campaignB),creatorB=await balance(admin.publicKey);
 await send([returnSetupInstruction(programId,campaignB,admin.publicKey,genesis)],[],stranger);
 assert.equal(await balance(admin.publicKey)-creatorB,30_000_000n);assert.equal(await balance(campaignB),beforeB);
 const beforeRefundB=await balance(stranger.publicKey);await send([client.refundInstruction(programId,campaignB,stranger.publicKey)]);
 assert.equal(await balance(stranger.publicKey)-beforeRefundB,SOL/2n);
 // Unsolicited terminal donations follow the disclosed fixed creator destination.
 await send([transfer(stranger.publicKey,authorityB,1_000_000n)],[stranger]);const beforeDonation=await balance(admin.publicKey);
 await send([returnSetupInstruction(programId,campaignB,admin.publicKey,genesis)],[],stranger);
 assert.equal(await balance(admin.publicKey)-beforeDonation,1_000_000n);
 // The actual wallet service builds, journals, independently validates and submits
 // the return on this validator. No operator key participates in this path.
 const registry=openRegistry();registry.migrate();
 try{
  const row={genesisHash:genesis,programId:programId.toBase58(),campaign:campaignB.toBase58(),mode:'standard',campaignVersion:3,registryStatus:'planned'};
  registry.campaigns.upsert(row);const id=[row.genesisHash,row.programId,row.campaign].join(':');
  const service=createPublicWalletService({registry,connection,genesisHash:genesis,programIds:[row.programId],programVersion:3,enabled:true});
  await send([transfer(stranger.publicKey,authorityB,2_000_000n)],[stranger]);
  const owner=admin.publicKey.toBase58(),vm={identity:row,creator:owner,terms:{version:'3'}};
  const packet=await service.prepare(owner,{campaignId:id,action:'setup',requestId:'actual-wallet-return'});
  assert.equal(packet.expectedReturnLamports,'2000000');
  const walletTx=decodePublicPacket(packet.unsignedTransactionBase64,{vm,owner,action:'setup'}),approved=walletTx.serialize();walletTx.sign([admin]);
  const before=await balance(admin.publicKey);
  const sent=await service.submit(owner,{intentId:packet.intentId,signedTransactionBase64:checkedSignedPacket(walletTx,approved)});
  assert.ok(sent.signature);await connection.confirmTransaction({signature:sent.signature,blockhash:packet.blockhash,lastValidBlockHeight:packet.lastValidBlockHeight},'confirmed');
  const status=await service.status(owner,{intentId:packet.intentId});assert.ok(['confirmed','finalized'].includes(status.status));
  assert.equal(await balance(authorityB),0n);assert.equal(await balance(admin.publicKey)-before,2_000_000n-BigInt(packet.feeLamports));
  assert.equal((await service.prepare(owner,{campaignId:id,action:'setup',requestId:'actual-wallet-return'})).signature,sent.signature);
 }finally{registry.close();}
 assert.deepEqual((await connection.getAccountInfo(new PublicKey(old.programId))).data,oldProgramBefore);
 assert.deepEqual((await connection.getAccountInfo(oldProgramData)).data,oldBinaryBefore,'existing program binary and upgrade metadata unchanged');
 t.diagnostic(JSON.stringify({programId:programId.toBase58(),campaignA:campaignA.toBase58(),campaignB:campaignB.toBase58(),setupReturned:String(setup),failedSetupReturned:'30000000',participantRefunds:String(SOL+SOL/2n),signature}));
});
