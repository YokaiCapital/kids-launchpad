// Client layout gates: the create body is the vector-checked sealed encoding, every builder carries the README's
// account table in order with the right signer and writable flags, PDAs derive as the program derives them, and the
// decoders reject an altered sealed region exactly as the program does.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PublicKey,Keypair,SystemProgram,SYSVAR_RENT_PUBKEY} from '@solana/web3.js';
import * as c from './client.mjs';
import * as p from './policy.mjs';
const vectors=JSON.parse(readFileSync(new URL('./test-vectors.json',import.meta.url),'utf8'));
const PROGRAM=Keypair.generate().publicKey;
const keysOf=ix=>ix.keys.map(k=>[k.pubkey.toBase58(),k.isSigner,k.isWritable]);
const standard=vectors.termsHash.find(v=>v.name==='standard');
function fullCampaign(terms,state={}){
 const d=Buffer.alloc(p.CAMPAIGN_LEN);c.CAMPAIGN_MAGIC.copy(d,0);p.encodeTerms(terms).copy(d,8);p.termsHash(d.subarray(8,808)).copy(d,808);
 d[840]=state.phase??0;d[841]=state.bump??254;
 for(const [k,at] of [['total',848],['refunded',856],['receiptCount',864],['settledCount',872],['settledAccepted',880],['participantClaimed',888],['devClaimed',896]])d.writeBigUInt64LE(BigInt(state[k]??0),at);
 d.writeBigInt64LE(BigInt(state.launchTime??0),920);if(state.pool)new PublicKey(state.pool).toBuffer().copy(d,928);if(state.feeNft)new PublicKey(state.feeNft).toBuffer().copy(d,960);
 return d;
}
test('create: the body is the vector-checked sealed encoding, hashed with the domain; accounts creator, campaign PDA, System, AMM config',()=>{
 for(const v of vectors.termsHash){
  const built=c.createInstruction(PROGRAM,v.terms);
  assert.equal(built.instruction.data[0],0);assert.equal(built.instruction.data.length,801);
  assert.equal(built.instruction.data.subarray(1).toString('hex'),v.sealedHex,v.name);assert.equal(built.hash.toString('hex'),v.hash,v.name);
  assert.ok(built.campaign.equals(c.campaignAddress(PROGRAM,v.terms.creator,v.terms.nonce)));
  const keys=keysOf(built.instruction);
  assert.deepEqual(keys.slice(0,4),[[c.toKey(v.terms.creator).toBase58(),true,true],[built.campaign.toBase58(),false,true],[SystemProgram.programId.toBase58(),false,false],[c.toKey(v.terms.ammConfig).toBase58(),false,false]]);
  const family=v.terms.mode===1,dist=!/^0+$/.test(v.terms.distributionProgram);
  assert.equal(keys.length,4+(dist?1:0)+(family?2:0),v.name+': distribution program then the two parent mints');
  if(dist)assert.equal(keys[4][0],c.toKey(v.terms.distributionProgram).toBase58());
  if(family)assert.deepEqual(keys.slice(-2).map(k=>k[0]),v.terms.parentMint.map(m=>c.toKey(m).toBase58()));
 }
 // keys in any form encode identically
 const asKeys={...standard.terms,creator:new PublicKey(Buffer.from(standard.terms.creator,'hex')),dev:new PublicKey(Buffer.from(standard.terms.dev,'hex')).toBase58(),metadataHash:Buffer.from(standard.terms.metadataHash,'hex')};
 assert.equal(c.createInstruction(PROGRAM,asKeys).instruction.data.subarray(1).toString('hex'),standard.sealedHex);
});
test('PDAs: campaign, receipt, launch authority, fee state and fee authority use the program seeds; foreign PDAs use theirs',()=>{
 const creator=Keypair.generate().publicKey,campaign=c.campaignAddress(PROGRAM,creator,11n),owner=Keypair.generate().publicKey;
 const n=Buffer.alloc(8);n.writeBigUInt64LE(11n);
 assert.ok(campaign.equals(PublicKey.findProgramAddressSync([Buffer.from('campaign'),creator.toBuffer(),n],PROGRAM)[0]));
 assert.ok(c.receiptAddress(PROGRAM,campaign,owner).equals(PublicKey.findProgramAddressSync([Buffer.from('commitment'),campaign.toBuffer(),owner.toBuffer()],PROGRAM)[0]));
 assert.ok(c.launchAuthority(PROGRAM,campaign).equals(PublicKey.findProgramAddressSync([Buffer.from('launch_authority'),campaign.toBuffer()],PROGRAM)[0]));
 assert.ok(c.feeStateAddress(PROGRAM,campaign).equals(PublicKey.findProgramAddressSync([Buffer.from('fees'),campaign.toBuffer()],PROGRAM)[0]));
 assert.ok(c.feeAuthority(PROGRAM,campaign).equals(PublicKey.findProgramAddressSync([Buffer.from('fee_authority'),campaign.toBuffer()],PROGRAM)[0]));
 // the approved tiers derive from their index under the CPMM program (big-endian index, as fees.rs)
 for(const t of c.AMM_CONFIG_TIERS)assert.ok(c.ammConfigAddress(c.RAYDIUM_CPMM,t.index).equals(t.address),'tier '+t.index);
 assert.ok(c.lockAuthority(c.RAYDIUM_LOCK).equals(new PublicKey('3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH')),'the lock authority of the mainnet lock program');
 const pool=c.cpmmAddresses(c.RAYDIUM_CPMM,c.AMM_CONFIG_TIERS[0].address,Keypair.generate().publicKey);
 assert.ok(Buffer.compare(pool.mint0.toBuffer(),pool.mint1.toBuffer())<0,'mint 0 is the lower key');
 assert.ok(c.associatedTokenAddress(owner,c.WSOL).equals(PublicKey.findProgramAddressSync([owner.toBuffer(),c.TOKEN_PROGRAM.toBuffer(),c.WSOL.toBuffer()],c.ASSOCIATED_TOKEN_PROGRAM)[0]));
});
test('commit, finalize, refund, settle, assert-ready: bodies and account tables',()=>{
 const campaign=Keypair.generate().publicKey,owner=Keypair.generate().publicKey,genesis=Keypair.generate().publicKey,receipt=c.receiptAddress(PROGRAM,campaign,owner);
 const commit=c.commitInstruction(PROGRAM,campaign,owner,genesis,123456789n,2n);
 assert.equal(commit.data.length,1+c.COMMIT_BODY_LEN);assert.equal(commit.data[0],1);assert.equal(commit.data.subarray(1,33).toString('hex'),Buffer.from(genesis.toBytes()).toString('hex'));
 assert.equal(commit.data.readBigUInt64LE(33),123456789n);assert.equal(commit.data.readBigUInt64LE(41),2n);
 assert.deepEqual(keysOf(commit),[[owner.toBase58(),true,true],[campaign.toBase58(),false,true],[receipt.toBase58(),false,true],[SystemProgram.programId.toBase58(),false,false]]);
 assert.throws(()=>c.commitInstruction(PROGRAM,campaign,owner,genesis,-1n,0n),RangeError);
 assert.deepEqual(keysOf(c.finalizeInstruction(PROGRAM,campaign)),[[campaign.toBase58(),false,true]]);assert.deepEqual([...c.finalizeInstruction(PROGRAM,campaign).data],[2]);
 assert.deepEqual(keysOf(c.refundInstruction(PROGRAM,campaign,owner)),[[campaign.toBase58(),false,true],[receipt.toBase58(),false,true],[owner.toBase58(),false,true]]);assert.deepEqual([...c.refundInstruction(PROGRAM,campaign,owner).data],[3]);
 assert.deepEqual(keysOf(c.settleInstruction(PROGRAM,campaign,owner)),[[campaign.toBase58(),false,true],[receipt.toBase58(),false,true]]);assert.deepEqual([...c.settleInstruction(PROGRAM,campaign,owner).data],[4]);
 assert.deepEqual(keysOf(c.assertReadyInstruction(PROGRAM,campaign)),[[campaign.toBase58(),false,false]]);assert.deepEqual([...c.assertReadyInstruction(PROGRAM,campaign).data],[5]);
});
test('launch: the 29 accounts of the README in order, keeper and fee NFT signing, every derived address in place',()=>{
 const terms={...standard.terms,ammProgram:c.RAYDIUM_CPMM,ammConfig:c.AMM_CONFIG_TIERS[0].address,lockProgram:c.RAYDIUM_LOCK,childMint:Keypair.generate().publicKey};
 const campaign=c.campaignAddress(PROGRAM,terms.creator,terms.nonce),keeper=Keypair.generate().publicKey,nft=Keypair.generate().publicKey;
 const {instruction,addresses:a}=c.launchInstruction(PROGRAM,campaign,terms,keeper,nft);
 assert.deepEqual([...instruction.data],[6]);
 const expected=[[campaign,false,true],[keeper,true,true],[a.authority,false,true],[terms.childMint,false,true],[a.child,false,true],[a.wsol,false,true],[nft,true,true],[a.feeNftAccount,false,true],[a.locked,false,true],[a.lockVault,false,true],[a.metadata,false,true],[c.TOKEN_PROGRAM,false,false],[c.ASSOCIATED_TOKEN_PROGRAM,false,false],[SystemProgram.programId,false,false],[SYSVAR_RENT_PUBKEY,false,false],[c.RAYDIUM_CPMM,false,false],[c.AMM_CONFIG_TIERS[0].address,false,false],[a.ammAuthority,false,false],[a.pool,false,true],[a.lpMint,false,true],[a.lp,false,true],[a.vault0,false,true],[a.vault1,false,true],[c.CPMM_CREATE_POOL_FEE_RECEIVER,false,true],[a.observation,false,true],[c.RAYDIUM_LOCK,false,false],[a.lockAuthority,false,false],[c.METADATA_PROGRAM,false,false],[c.WSOL,false,false]];
 assert.equal(expected.length,c.LAUNCH_ACCOUNTS);
 assert.deepEqual(keysOf(instruction),expected.map(([k,s,w])=>[k.toBase58(),s,w]));
 assert.ok(a.authority.equals(c.launchAuthority(PROGRAM,campaign)));assert.ok(a.child.equals(c.associatedTokenAddress(a.authority,terms.childMint)));assert.ok(a.wsol.equals(c.associatedTokenAddress(a.authority,c.WSOL)));
 assert.ok(a.feeNftAccount.equals(c.associatedTokenAddress(campaign,nft)));assert.ok(a.locked.equals(PublicKey.findProgramAddressSync([Buffer.from('locked_liquidity'),nft.toBuffer()],c.RAYDIUM_LOCK)[0]));
 assert.ok(a.metadata.equals(PublicKey.findProgramAddressSync([Buffer.from('metadata'),c.METADATA_PROGRAM.toBuffer(),nft.toBuffer()],c.METADATA_PROGRAM)[0]));
 assert.ok(a.lockVault.equals(c.associatedTokenAddress(a.lockAuthority,a.lpMint)));assert.ok(a.lp.equals(c.associatedTokenAddress(a.authority,a.lpMint)));
 const pool=c.cpmmAddresses(c.RAYDIUM_CPMM,c.AMM_CONFIG_TIERS[0].address,terms.childMint);assert.ok(a.pool.equals(pool.pool)&&a.vault0.equals(pool.vault0)&&a.vault1.equals(pool.vault1)&&a.observation.equals(pool.observation)&&a.lpMint.equals(pool.lpMint));
});
test('claims: participant and dev account tables; custody is the launch authority ATA, destinations are ATAs of the recipient',()=>{
 const campaign=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,owner=Keypair.generate().publicKey,dev=Keypair.generate().publicKey,authority=c.launchAuthority(PROGRAM,campaign);
 const custody=c.associatedTokenAddress(authority,mint);
 assert.deepEqual(keysOf(c.claimParticipantInstruction(PROGRAM,campaign,mint,owner)),[[campaign.toBase58(),false,true],[c.receiptAddress(PROGRAM,campaign,owner).toBase58(),false,true],[authority.toBase58(),false,false],[mint.toBase58(),false,false],[custody.toBase58(),false,true],[c.associatedTokenAddress(owner,mint).toBase58(),false,true],[c.TOKEN_PROGRAM.toBase58(),false,false]]);
 assert.deepEqual([...c.claimParticipantInstruction(PROGRAM,campaign,mint,owner).data],[7]);
 assert.deepEqual(keysOf(c.claimDevInstruction(PROGRAM,campaign,mint,dev)),[[campaign.toBase58(),false,true],[authority.toBase58(),false,false],[mint.toBase58(),false,false],[custody.toBase58(),false,true],[c.associatedTokenAddress(dev,mint).toBase58(),false,true],[c.TOKEN_PROGRAM.toBase58(),false,false]]);
 assert.deepEqual([...c.claimDevInstruction(PROGRAM,campaign,mint,dev).data],[8]);
});
test('fee cycle: tags 20, 22, 21, 23, 26 and the layout-only tag 25 builder carry the README tables',()=>{
 const family=vectors.termsHash.find(v=>v.name==='family').terms;
 const terms={...family,ammProgram:c.RAYDIUM_CPMM,ammConfig:c.AMM_CONFIG_TIERS[0].address,lockProgram:c.RAYDIUM_LOCK,childMint:Keypair.generate().publicKey,parentMint:[Keypair.generate().publicKey,Keypair.generate().publicKey],parentProgram:[c.TOKEN_PROGRAM,c.TOKEN_2022_PROGRAM]};
 const campaign=c.campaignAddress(PROGRAM,terms.creator,terms.nonce),treasury=c.toKey(terms.treasury),operator=Keypair.generate().publicKey,caller=Keypair.generate().publicKey;
 const feeState=c.feeStateAddress(PROGRAM,campaign),authority=c.feeAuthority(PROGRAM,campaign);
 const common=(who,signs,writable)=>[[campaign.toBase58(),false,false],[who.toBase58(),signs,writable],[feeState.toBase58(),false,true],[authority.toBase58(),false,false]];
 const init=c.feesInitInstruction(PROGRAM,campaign,treasury,operator);
 assert.deepEqual(keysOf(init),[...common(treasury,true,true),[SystemProgram.programId.toBase58(),false,false]]);assert.equal(init.data[0],20);assert.equal(init.data.length,33);assert.ok(new PublicKey(init.data.subarray(1)).equals(operator));
 const rotate=c.feesRotateOperatorInstruction(PROGRAM,campaign,treasury,operator);assert.deepEqual(keysOf(rotate),common(treasury,true,false));assert.equal(rotate.data[0],22);assert.equal(rotate.data.length,33);
 const nft=Keypair.generate().publicKey,pool=c.cpmmAddresses(c.RAYDIUM_CPMM,c.AMM_CONFIG_TIERS[0].address,terms.childMint),lockAuth=c.lockAuthority(c.RAYDIUM_LOCK);
 const collect=c.feesCollectInstruction(PROGRAM,campaign,terms,{pool:pool.pool,feeNft:nft},caller,5n);
 assert.equal(collect.data[0],21);assert.equal(collect.data.readBigUInt64LE(1),5n);
 assert.deepEqual(keysOf(collect),[...common(caller,false,false),[c.associatedTokenAddress(authority,terms.childMint).toBase58(),false,true],[c.associatedTokenAddress(authority,c.WSOL).toBase58(),false,true],[c.associatedTokenAddress(campaign,nft).toBase58(),false,true],[c.lockedLiquidityAddress(c.RAYDIUM_LOCK,nft).toBase58(),false,true],[pool.pool.toBase58(),false,true],[pool.lpMint.toBase58(),false,true],[pool.vault0.toBase58(),false,true],[pool.vault1.toBase58(),false,true],[pool.mint0.toBase58(),false,false],[pool.mint1.toBase58(),false,false],[c.associatedTokenAddress(lockAuth,pool.lpMint).toBase58(),false,true],[c.RAYDIUM_CPMM.toBase58(),false,false],[pool.authority.toBase58(),false,false],[c.RAYDIUM_LOCK.toBase58(),false,false],[lockAuth.toBase58(),false,false],[c.TOKEN_PROGRAM.toBase58(),false,false],[c.TOKEN_2022_PROGRAM.toBase58(),false,false],[c.MEMO_PROGRAM.toBase58(),false,false]]);
 assert.equal(collect.keys.length,22);
 assert.throws(()=>c.feesCollectInstruction(PROGRAM,campaign,terms,{pool:Keypair.generate().publicKey,feeNft:nft},caller,5n),/canonical/);
 assert.throws(()=>c.feesCollectInstruction(PROGRAM,campaign,terms,{pool:pool.pool,feeNft:nft},caller,0n),RangeError);
 const distribute=c.feesDistributeInstruction(PROGRAM,campaign,terms,caller);
 assert.deepEqual(keysOf(distribute),[...common(caller,false,false),[c.associatedTokenAddress(authority,c.WSOL).toBase58(),false,true],[c.associatedTokenAddress(treasury,c.WSOL).toBase58(),false,true],[c.associatedTokenAddress(c.toKey(terms.dev),c.WSOL).toBase58(),false,true],[c.TOKEN_PROGRAM.toBase58(),false,false]]);assert.deepEqual([...distribute.data],[23]);
 const burn=c.feesBurnChildInstruction(PROGRAM,campaign,terms,caller,77n);
 assert.deepEqual(keysOf(burn),[...common(caller,false,false),[c.associatedTokenAddress(authority,terms.childMint).toBase58(),false,true],[terms.childMint.toBase58(),false,true],[c.TOKEN_PROGRAM.toBase58(),false,false]]);assert.equal(burn.data[0],26);assert.equal(burn.data.readBigUInt64LE(1),77n);
 // tag 25: layout only (no Jupiter on the localnet). Parent B is Token-2022 and quotes against config index 7 (stored 8).
 const route=Buffer.concat([Buffer.from('bb64facc31c4af14','hex'),Buffer.alloc(26)]);const extra=[{pubkey:Keypair.generate().publicKey,isWritable:true},{pubkey:Keypair.generate().publicKey,isWritable:false}];
 const buy=c.feesBuyBurnInstruction(PROGRAM,campaign,terms,operator,{parent:1,amount:1000n,minOut:9n,expiry:1790000000n,route,remainingAccounts:extra});
 assert.equal(buy.data[0],25);assert.equal(buy.data[1],1);assert.equal(buy.data.readBigUInt64LE(2),1000n);assert.equal(buy.data.readBigUInt64LE(10),9n);assert.equal(buy.data.readBigInt64LE(18),1790000000n);assert.ok(buy.data.subarray(26).equals(route));
 const refConfig=c.ammConfigAddress(c.RAYDIUM_CPMM,7);assert.ok(refConfig.equals(c.AMM_CONFIG_TIERS[1].address));
 const [m0,m1]=[terms.parentMint[1],c.WSOL].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));
 const refPool=PublicKey.findProgramAddressSync([Buffer.from('pool'),refConfig.toBuffer(),m0.toBuffer(),m1.toBuffer()],c.RAYDIUM_CPMM)[0];
 const vault=m=>PublicKey.findProgramAddressSync([Buffer.from('pool_vault'),refPool.toBuffer(),m.toBuffer()],c.RAYDIUM_CPMM)[0];
 assert.deepEqual(keysOf(buy),[...common(operator,true,false),[c.associatedTokenAddress(authority,c.WSOL).toBase58(),false,true],[c.associatedTokenAddress(authority,terms.parentMint[1],c.TOKEN_2022_PROGRAM).toBase58(),false,true],[terms.parentMint[1].toBase58(),false,true],[c.WSOL.toBase58(),false,false],[c.TOKEN_PROGRAM.toBase58(),false,false],[c.TOKEN_2022_PROGRAM.toBase58(),false,false],[c.JUPITER_PROGRAM.toBase58(),false,false],[c.jupiterEventAuthority().toBase58(),false,false],[refConfig.toBase58(),false,false],[refPool.toBase58(),false,false],[vault(terms.parentMint[1]).toBase58(),false,false],[vault(c.WSOL).toBase58(),false,false],[extra[0].pubkey.toBase58(),false,true],[extra[1].pubkey.toBase58(),false,false]]);
 assert.equal(buy.keys.length,16+extra.length);
 assert.throws(()=>c.feesBuyBurnInstruction(PROGRAM,campaign,{...terms,parentReferenceConfig:[0,0]},operator,{parent:0,amount:1n,minOut:1n,expiry:1n,route}),/reference pool/);
 assert.throws(()=>c.feesBuyBurnInstruction(PROGRAM,campaign,terms,operator,{parent:1,amount:1n,minOut:1n,expiry:1n,route:route.subarray(0,20)}),/too short/);
});
test('decoders: the campaign round-trips, an altered sealed byte is unreadable (hash re-check), receipts and fee state decode',()=>{
 const pool=Keypair.generate().publicKey,nft=Keypair.generate().publicKey;
 const d=fullCampaign(standard.terms,{phase:3,bump:251,total:5n,refunded:1n,receiptCount:2n,settledCount:2n,settledAccepted:4n,participantClaimed:3n,devClaimed:9n,launchTime:1790007301n,pool,feeNft:nft});
 const decoded=c.decodeCampaign(d);
 assert.equal(decoded.terms.layoutVersion,2);assert.equal(decoded.terms.mode,0);assert.equal(decoded.terms.nonce,11n);assert.equal(decoded.terms.supply,BigInt(standard.terms.supply));assert.equal(decoded.terms.opensAt,1790000100n);
 assert.equal(c.keyHex(decoded.terms.creator),standard.terms.creator);assert.equal(c.keyHex(decoded.terms.treasury),p.PLATFORM_TREASURY_HEX);assert.equal(decoded.terms.metadataUri,standard.terms.metadataUri);assert.equal(decoded.terms.genesis,standard.terms.genesis);
 assert.deepEqual(decoded.terms.splitBps,{...p.SPLIT_STANDARD});assert.deepEqual(decoded.terms.feeWeights,{...p.FEE_WEIGHTS_STANDARD});assert.deepEqual(decoded.terms.vesting,{...p.VESTING_THREE_MONTHS});
 assert.equal(decoded.state.phase,3);assert.equal(decoded.state.bump,251);assert.equal(decoded.state.total,5n);assert.equal(decoded.state.refunded,1n);assert.equal(decoded.state.receiptCount,2n);assert.equal(decoded.state.settledAccepted,4n);assert.equal(decoded.state.devClaimed,9n);assert.equal(decoded.state.launchTime,1790007301n);
 assert.ok(decoded.state.pool.equals(pool));assert.ok(decoded.state.feeNft.equals(nft));assert.equal(decoded.state.termsHash,standard.hash);
 assert.equal(decoded.split.liquidity,BigInt(vectors.split.find(v=>v.policy===1&&v.supply===standard.terms.supply).liquidity));
 // re-encoding the decoded terms through the single encoder reproduces the sealed bytes
 assert.equal(p.encodeTerms(c.normalizeTerms(decoded.terms)).toString('hex'),standard.sealedHex);
 for(const at of [8,10,80,184,216,329,331,676,700,805,807]){const bad=Buffer.from(d);bad[at]^=1;assert.throws(()=>c.decodeCampaign(bad),/hash mismatch|layout version|campaign account/,'byte '+at);}
 const badMagic=Buffer.from(d);badMagic[0]^=1;assert.throws(()=>c.decodeCampaign(badMagic),/not a kids-launch-v2 campaign/);
 assert.throws(()=>c.decodeCampaign(d.subarray(0,1023)),/not a kids-launch-v2 campaign/);
 const version=Buffer.from(d);version.writeUInt16LE(3,8);p.termsHash(version.subarray(8,808)).copy(version,808);assert.throws(()=>c.decodeCampaign(version),/layout version/);
 // mutable state does not enter the hash: changing it keeps the campaign readable
 const moved=Buffer.from(d);moved.writeBigUInt64LE(99n,848);assert.equal(c.decodeCampaign(moved).state.total,99n);
 const r=Buffer.alloc(128);c.RECEIPT_MAGIC.copy(r,0);const campaign=Keypair.generate().publicKey,owner=Keypair.generate().publicKey;campaign.toBuffer().copy(r,8);owner.toBuffer().copy(r,40);
 r.writeBigUInt64LE(1000n,72);r.writeBigUInt64LE(250n,80);r.writeBigUInt64LE(2n,88);r.writeBigUInt64LE(750n,96);r.writeBigUInt64LE(33n,104);r[112]=253;r[113]=1;r[114]=0;
 const receipt=c.decodeReceipt(r);assert.ok(receipt.campaign.equals(campaign)&&receipt.owner.equals(owner));assert.equal(receipt.committed,1000n);assert.equal(receipt.refunded,250n);assert.equal(receipt.sequence,2n);assert.equal(receipt.accepted,750n);assert.equal(receipt.claimedTokens,33n);assert.equal(receipt.bump,253);assert.equal(receipt.settled,true);assert.equal(receipt.claimed,false);
 assert.throws(()=>c.decodeReceipt(Buffer.alloc(128)),/receipt/);assert.throws(()=>c.decodeReceipt(r.subarray(0,127)),/receipt/);
 const f=Buffer.alloc(160);c.FEE_STATE_MAGIC.copy(f,0);campaign.toBuffer().copy(f,8);for(let i=0;i<11;i++)f.writeBigUInt64LE(BigInt(i+1),40+8*i);owner.toBuffer().copy(f,128);
 const fee=c.decodeFeeState(f,campaign);assert.equal(fee.coinPending,1n);assert.equal(fee.solCollected,2n);assert.equal(fee.treasuryPaid,3n);assert.equal(fee.devPaid,4n);assert.deepEqual(fee.parentAllocated,[5n,6n]);assert.deepEqual(fee.parentSpent,[7n,8n]);assert.deepEqual(fee.parentBurned,[9n,10n]);assert.equal(fee.coinBurned,11n);assert.ok(fee.operator.equals(owner));
 assert.throws(()=>c.decodeFeeState(f,owner),/another campaign/);
 const filters=c.receiptFilters(campaign);assert.equal(filters[0].dataSize,128);assert.equal(filters[1].memcmp.offset,0);assert.equal(filters[2].memcmp.bytes,campaign.toBase58());
 assert.equal(Buffer.from(require58(filters[1].memcmp.bytes)).toString(),'KIDSLV2R');
});
function require58(text){const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const ch of text)n=n*58n+BigInt(A.indexOf(ch));let hex=n.toString(16);if(hex.length%2)hex='0'+hex;return Buffer.from(hex,'hex');}
