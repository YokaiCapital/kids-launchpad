// Browser-only independent reconstruction of the isolated Standard v3 creator
// packets. No Node crypto, filesystem, signer code or private inventory is bundled.
import {PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {sha256} from '@noble/hashes/sha256';
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),META=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),WSOL=new PublicKey('So11111111111111111111111111111111111111112');
const AMM='CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',LOCK='LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE',MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),COMPUTE_BUDGET=new PublicKey('ComputeBudget111111111111111111111111111111');
// One creation transaction (28 September 2026): tag 40 of the version-3 program and the metadata gateway it prepends.
const CREATE_V3_TAG=40,CREATE_V3_URI_PREFIX='https://gateway.pinata.cloud/ipfs/',CID=/^[1-9A-HJ-NP-Za-km-z]{1,64}$/;
// Funding-first accounting (29 September 2026): tag 41 opens the round with the reserved mint and fee NFT co-signing; the
// program refuses a soft cap below its floor.
const OPEN_FUNDING_TAG=41,SOFT_FLOOR_LAMPORTS_V2=6553500n;
const tiers={2:['2fGXL8uhqxJ4tpgtosHZXT4zcQap6j62z3bMDxdkMvy5',200],7:['ESLj2Rzmvn3RhDo4Z18hY1wYmGyC9xM4ZtRXhvoFkDAi',250]};
const text=new TextEncoder(),equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const fail=()=>{throw Error('Creator transaction differs from your reviewed launch');};
const exact=(value,fields)=>{if(!value||Object.keys(value).sort().join(',')!==fields.slice().sort().join(','))fail();};
const key=x=>{const k=new PublicKey(x);if(k.toBase58()!==x)fail();return k;};
const uint=x=>{if(typeof x!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(x)||BigInt(x)>18446744073709551615n)fail();return BigInt(x);};
const bytes64=x=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,uint(x),true);return b;};
const cat=(...parts)=>{const a=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){a.set(p,at);at+=p.length;}return a;};
const str=x=>{const b=text.encode(x),n=new Uint8Array(4);new DataView(n.buffer).setUint32(0,b.length,true);return cat(n,b);};
const pda=(program,seeds)=>PublicKey.findProgramAddressSync(seeds,program)[0];
const ata=(owner,mint)=>pda(ATA,[owner.toBytes(),TOKEN.toBytes(),mint.toBytes()]);
const meta=(pubkey,isSigner=false,isWritable=false)=>({pubkey,isSigner,isWritable});
const ix=(programId,keys,data)=>new TransactionInstruction({programId,keys,data});
// Canonical JSON and sha256 exactly as the server's registry/canonical.mjs: sorted keys, no whitespace, integers plain.
const canonical=v=>{if(v===null)return 'null';if(typeof v==='string')return JSON.stringify(v);if(typeof v==='boolean')return v?'true':'false';if(typeof v==='number'){if(!Number.isFinite(v))fail();return Number.isInteger(v)?String(v):JSON.stringify(v);}if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(typeof v!=='object')fail();return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';};
const canonicalHex=v=>Array.from(sha256(text.encode(canonical(v))),b=>b.toString(16).padStart(2,'0')).join('');
/** The operating reserve (option 1): one transfer from the creator to the keeper payer for exactly the reviewed amount,
 * plus the memo that binds it to this campaign. Nothing else may ride in the packet. */
function reserveInstructions(r,{owner,scope}){
 exact(r,['genesisHash','programId','campaign','payer','policy','creator','lamports']);
 if(r.creator!==owner||r.genesisHash!==scope.genesisHash||r.programId!==scope.programId||r.payer!==scope.operatingPayer||r.lamports!==scope.operatingReserveLamports||r.policy!=='creator-funded-v1'||r.payer===r.creator)fail();
 const creator=key(owner),payer=key(r.payer);key(r.campaign);key(r.genesisHash);key(r.programId);
 if(uint(r.lamports)<1n)fail();
 const terms={genesisHash:r.genesisHash,programId:r.programId,campaign:r.campaign,payer:r.payer,policy:r.policy,creator:r.creator,lamports:r.lamports};
 return {creator,instructions:[SystemProgram.transfer({fromPubkey:creator,toPubkey:payer,lamports:uint(r.lamports)}),ix(MEMO,[],text.encode('KIDS operating:'+canonicalHex(terms)))]};
}
const custodyIx=(owner,authority,mint)=>ix(ATA,[meta(owner,true,true),meta(ata(authority,mint),false,true),meta(authority),meta(mint),meta(SystemProgram.programId),meta(TOKEN)],Uint8Array.of(1));
function mintKeys(m,{owner,scope}){
 exact(m,['version','programVersion','requestId','leaseId','genesisHash','programId','creator','nonce','campaign','authority','mint','decimals','supply','rentLamports','metadata',...(m?.version>=2?['launch']:[]),...(m?.version===3?['fundingFirst']:[])]);
 exact(m.metadata,['name','symbol','uri','documentHash']);
 if(![1,2,3].includes(m?.version)||m.programVersion!==3||m.creator!==owner||m.programId!==scope.programId||m.genesisHash!==scope.genesisHash||m.decimals!==6||m.supply!=='1000000000000000')fail();
 if(m.version>=2)launchTerms(m.launch,scope,owner);
 if(m.version===3)fundingFirstTerms(m,scope,owner);
 const creator=key(owner),program=key(m.programId),mint=key(m.mint),campaign=key(m.campaign),authority=key(m.authority);key(m.genesisHash);
 if(!m.mint.endsWith('kids')||!PublicKey.isOnCurve(mint.toBytes())||new Set([owner,m.programId,m.mint,m.campaign,m.authority]).size!==5)fail();
 if(!pda(program,[text.encode('campaign'),creator.toBytes(),bytes64(m.nonce)]).equals(campaign)||!pda(program,[text.encode('launch_authority'),campaign.toBytes()]).equals(authority))fail();
 if(m.rentLamports!==scope.mintRentLamports||uint(m.rentLamports)<1n||uint(m.rentLamports)>BigInt(Number.MAX_SAFE_INTEGER))fail();
 const md=m.metadata;
 if(!md||md.name!==scope.name||md.symbol!==scope.symbol||!md.name.trim()||text.encode(md.name).length>32||!md.symbol.trim()||text.encode(md.symbol).length>10||/\s/.test(md.symbol)||!/^[a-f0-9]{64}$/.test(md.documentHash??''))fail();
 if(typeof md.uri!=='string'||text.encode(md.uri).length>128||!/^https:\/\/[\x21-\x7e]+$/.test(md.uri))fail();
 const u=new URL(md.uri);if(u.username||u.password||u.hash||!u.hostname.includes('.'))fail();
 if(/[\x00-\x1f\x7f]/.test(md.name+md.symbol))fail();
 return {creator,program,mint,campaign,authority};
}
/** The launch part of a version-2 intent must equal the reviewed scope field by field; nothing is taken from the server unchecked. */
function launchTerms(l,scope,owner){
 exact(l,['policy','treasury','opensAt','authorityBudgetLamports','reserve','priorityFeeLamports']);exact(l.reserve,['payer','lamports']);
 exact(l.policy,['policyHash','planHash','softCapLamports','hardCapLamports','fundingDurationSeconds','launchWindowSeconds','ammConfig','ammConfigIndex','tradeFeeBps']);
 for(const f of ['policyHash','planHash','softCapLamports','hardCapLamports','fundingDurationSeconds','launchWindowSeconds','ammConfig','ammConfigIndex','tradeFeeBps'])if(l.policy[f]!==scope[f])fail();
 const tier=tiers[l.policy.ammConfigIndex];if(!tier||tier[0]!==l.policy.ammConfig||tier[1]!==l.policy.tradeFeeBps)fail();
 if(l.treasury!==scope.treasury||l.opensAt!==scope.opensAt||l.authorityBudgetLamports!==scope.authorityBudgetLamports||l.reserve.payer!==scope.operatingPayer||l.reserve.lamports!==scope.operatingReserveLamports||l.reserve.payer===owner)fail();
 for(const n of [l.policy.fundingDurationSeconds,l.policy.launchWindowSeconds])if(!Number.isSafeInteger(n)||n<60||n>604800)fail();
 if(uint(l.policy.softCapLamports)<1n||uint(l.policy.hardCapLamports)<uint(l.policy.softCapLamports)||uint(l.authorityBudgetLamports)<1n||uint(l.reserve.lamports)<1n||uint(l.opensAt)>9223372036854775807n||uint(l.priorityFeeLamports)>1000000000n)fail();
 return l;
}
/** The funding-first part of a version-3 intent: the reserved fee NFT the review shows, an independent key; the soft cap
 * reaches the program's funding-first floor. */
function fundingFirstTerms(m,scope,owner){
 exact(m.fundingFirst,['feeNft']);const f=m.fundingFirst.feeNft;key(f);
 if(f!==scope.feeNft||[owner,m.mint,m.campaign,m.authority,m.programId,m.launch.treasury,m.launch.reserve.payer].includes(f)||uint(m.launch.policy.softCapLamports)<SOFT_FLOOR_LAMPORTS_V2)fail();
 return m.fundingFirst;
}
/** The funding-first opening (tag 41): priority fee, the opening (creator, reserved mint and reserved fee NFT sign; the
 * compact body, the display commitment sha256(borsh name || symbol || uri) and the fee NFT), the setup budget for the
 * launch authority and the operating reserve for the keeper. No token instruction. Same order as the server's builder. */
function openingInstructions(m,k){
 const l=m.launch,micro=String(Math.max(1,Math.floor(Number(l.priorityFeeLamports)*1000000/1400000))),feeNft=key(m.fundingFirst.feeNft),md=m.metadata;
 const display=sha256(cat(str(md.name),str(md.symbol),str(md.uri)));
 const ext=pda(k.program,[text.encode('ext'),k.campaign.toBytes()]),mintRes=pda(k.program,[text.encode('mint'),k.mint.toBytes()]),nftRes=pda(k.program,[text.encode('nft'),feeNft.toBytes()]);
 return [ix(COMPUTE_BUDGET,[],cat(Uint8Array.of(3),bytes64(micro))),
  ix(k.program,[meta(k.creator,true,true),meta(k.campaign,false,true),meta(ext,false,true),meta(mintRes,false,true),meta(nftRes,false,true),meta(k.mint,true),meta(feeNft,true),meta(SystemProgram.programId),meta(key(l.policy.ammConfig))],cat(Uint8Array.of(OPEN_FUNDING_TAG),compactBody(m,k),display,feeNft.toBytes())),
  SystemProgram.transfer({fromPubkey:k.creator,toPubkey:k.authority,lamports:uint(l.authorityBudgetLamports)}),
  SystemProgram.transfer({fromPubkey:k.creator,toPubkey:key(l.reserve.payer),lamports:uint(l.reserve.lamports)})];
}
/** Tag 40 body: genesis, nonce, mint, opening (0 = when it runs), the two windows, the caps, the AMM tier, the metadata hash and CID. */
function compactBody(m,k){
 const l=m.launch,p=l.policy,uri=m.metadata.uri;if(!uri.startsWith(CREATE_V3_URI_PREFIX))fail();const cid=text.encode(uri.slice(CREATE_V3_URI_PREFIX.length));if(!CID.test(uri.slice(CREATE_V3_URI_PREFIX.length)))fail();
 const u32=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return b;},u16=n=>{const b=new Uint8Array(2);new DataView(b.buffer).setUint16(0,n,true);return b;};
 return cat(key(m.genesisHash).toBytes(),bytes64(m.nonce),k.mint.toBytes(),bytes64(l.opensAt),u32(p.fundingDurationSeconds),u32(p.launchWindowSeconds),bytes64(p.softCapLamports),bytes64(p.hardCapLamports),u16(p.ammConfigIndex),Uint8Array.from(m.metadata.documentHash.match(/../g),x=>parseInt(x,16)),Uint8Array.of(cid.length),cid);
}
/** One creation transaction: priority fee, the mint leg, the program's SOL custody, the compact campaign creation, the
 * setup budget for the launch authority and the operating reserve for the keeper. Same order as the server's builder. */
function launchInstructions(m,k){
 const l=m.launch,micro=String(Math.max(1,Math.floor(Number(l.priorityFeeLamports)*1000000/1400000)));
 return [ix(COMPUTE_BUDGET,[],cat(Uint8Array.of(3),bytes64(micro))),...mintInstructions(m,k),custodyIx(k.creator,k.authority,WSOL),
  ix(k.program,[meta(k.creator,true,true),meta(k.campaign,false,true),meta(SystemProgram.programId),meta(key(l.policy.ammConfig))],cat(Uint8Array.of(CREATE_V3_TAG),compactBody(m,k))),
  SystemProgram.transfer({fromPubkey:k.creator,toPubkey:k.authority,lamports:uint(l.authorityBudgetLamports)}),
  SystemProgram.transfer({fromPubkey:k.creator,toPubkey:key(l.reserve.payer),lamports:uint(l.reserve.lamports)})];
}
function mintInstructions(m,k){
 const md=m.metadata,custody=ata(k.authority,k.mint),metadata=pda(META,[text.encode('metadata'),META.toBytes(),k.mint.toBytes()]);
 return [SystemProgram.createAccount({fromPubkey:k.creator,newAccountPubkey:k.mint,lamports:Number(m.rentLamports),space:82,programId:TOKEN}),
  ix(TOKEN,[meta(k.mint,false,true)],cat(Uint8Array.of(20,6),k.creator.toBytes(),Uint8Array.of(0))),
  custodyIx(k.creator,k.authority,k.mint),
  ix(TOKEN,[meta(k.mint,false,true),meta(custody,false,true),meta(k.creator,true)],cat(Uint8Array.of(7),bytes64(m.supply))),
  ix(META,[meta(metadata,false,true),meta(k.mint),meta(k.creator,true),meta(k.creator,true,true),meta(k.creator,true),meta(SystemProgram.programId)],cat(Uint8Array.of(33),str(md.name),str(md.symbol),str(md.uri),new Uint8Array(7))),
  ix(TOKEN,[meta(k.mint,false,true),meta(k.creator,true)],Uint8Array.of(6,0,0))];
}
function sealedTerms(p,k,scope){
 const m=p.mint,q=p.policy,tier=tiers[q?.ammConfigIndex];
 exact(p,['version','mint','policy','treasury','opensAt','authorityBudgetLamports',...(p.version===2?['generation']:[])]);
 exact(q,['policyHash','planHash','softCapLamports','hardCapLamports','fundingDurationSeconds','launchWindowSeconds','ammConfig','ammConfigIndex','tradeFeeBps']);
 if(!/^[a-f0-9]{64}$/.test(q.policyHash)||!/^[a-f0-9]{64}$/.test(q.planHash))fail();
 if(![1,2].includes(p.version)||p.version===2&&(!Number.isSafeInteger(p.generation)||p.generation<2)||!tier||tier[0]!==q.ammConfig||tier[1]!==q.tradeFeeBps)fail();
 for(const field of ['softCapLamports','hardCapLamports','fundingDurationSeconds','launchWindowSeconds','ammConfig','ammConfigIndex','tradeFeeBps','policyHash','planHash'])if(q[field]!==scope[field])fail();
 if(p.treasury!==scope.treasury||p.authorityBudgetLamports!==scope.authorityBudgetLamports||uint(p.authorityBudgetLamports)<1n)fail();
 if(uint(q.softCapLamports)<1n||uint(q.hardCapLamports)<uint(q.softCapLamports))fail();
 for(const n of [q.fundingDurationSeconds,q.launchWindowSeconds])if(!Number.isSafeInteger(n)||n<60||n>604800)fail();
 const opens=uint(p.opensAt),deadline=opens+BigInt(q.fundingDurationSeconds),launchDeadline=deadline+BigInt(q.launchWindowSeconds);
 if(opens<1n||launchDeadline>9223372036854775807n||p.opensAt!==scope.opensAt)fail();
 // Match all 800 sealed bytes, including zeroed Family/future-feature fields,
 // padding, permanent-liquidity policy, metadata and fixed Standard economics.
 const d=new Uint8Array(808),v=new DataView(d.buffer),u16=(at,n)=>v.setUint16(at,n,true),u64=(at,n)=>v.setBigUint64(at,BigInt(n),true),pk=(at,x)=>d.set(key(x).toBytes(),at);
 // Version-3 Standard economics sealed by the owner on 27 September 2026: split policy 3, vesting rule 2.
 u16(8,2);d[11]=6;d[12]=3;d[13]=2;d[14]=1;
 pk(16,m.genesisHash);pk(48,m.creator);u64(80,m.nonce);pk(88,m.creator);pk(120,p.treasury);pk(152,m.mint);u64(184,m.supply);
 u64(192,opens);u64(200,deadline);u64(208,launchDeadline);u64(216,q.softCapLamports);u64(224,q.hardCapLamports);
 pk(232,AMM);pk(264,q.ammConfig);u64(296,q.tradeFeeBps*100);u16(304,q.ammConfigIndex);
 [148,20,0,0].forEach((n,i)=>u16(306+2*i,n));[4750,4750,0,0,500].forEach((n,i)=>u16(314+2*i,n));u16(324,150);u16(326,350);d[328]=3;pk(332,LOCK);
 d.set(Uint8Array.from(m.metadata.documentHash.match(/../g),x=>parseInt(x,16)),644);const uri=text.encode(m.metadata.uri);d[676]=uri.length;d.set(uri,677);
 return cat(Uint8Array.of(0),d.slice(8));
}
export function decodeCreatorPacket(base64,{owner,scope,stage,intent,network='localnet'}){
 if(!scope||scope.network!==network||!['localnet','devnet','mainnet'].includes(network)||!['launch','mint','native-custody','create-campaign','operating-reserve'].includes(stage)||typeof base64!=='string'||!base64.length||base64.length>1644)fail();
 const raw=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),tx=VersionedTransaction.deserialize(raw);
 if(raw.length>1232||btoa(String.fromCharCode(...raw))!==base64||!equal(raw,tx.serialize())||tx.version!==0||tx.message.addressTableLookups.length||tx.signatures.some(s=>s.some(x=>x!==0)))fail();
 let payerKey,instructions;
 if(stage==='operating-reserve'){const r=reserveInstructions(intent,{owner,scope});payerKey=r.creator;instructions=r.instructions;}
 else{
  const m=stage==='mint'||stage==='launch'?intent:intent.mint,k=mintKeys(m,{owner,scope});payerKey=k.creator;
  if(stage==='launch'){if(m.version===3)instructions=openingInstructions(m,k);else if(m.version===2)instructions=launchInstructions(m,k);else fail();}
  else if(stage==='mint'){if(m.version!==1)fail();instructions=mintInstructions(m,k);}
  else if(stage==='native-custody')instructions=[custodyIx(k.creator,k.authority,WSOL)];
  else instructions=[ix(k.program,[meta(k.creator,true,true),meta(k.campaign,false,true),meta(SystemProgram.programId),meta(key(intent.policy.ammConfig))],sealedTerms(intent,k,scope)),SystemProgram.transfer({fromPubkey:k.creator,toPubkey:k.authority,lamports:uint(intent.authorityBudgetLamports)})];
 }
 const expected=new TransactionMessage({payerKey,recentBlockhash:tx.message.recentBlockhash,instructions}).compileToV0Message();
 if(!equal(tx.message.serialize(),expected.serialize()))fail();return tx;
}
// Creator packets are already close to the wire limit and the server validates
// exact bytes. Unlike legacy trade flows, added priority instructions are refused.
export function checkedCreatorSignature(signed,approved){
 const wire=signed.serialize(),a=VersionedTransaction.deserialize(approved),b=VersionedTransaction.deserialize(wire);
 if(wire.length>1232||!equal(a.message.serialize(),b.message.serialize())||b.signatures.length!==a.signatures.length||b.signatures[0].every(x=>x===0)||b.signatures.slice(1).some(s=>s.some(x=>x!==0)))throw Error('Wallet changed the reviewed creator transaction. No new approval was recorded.');
 return btoa(String.fromCharCode(...wire));
}
