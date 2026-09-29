// Verification of CURRENT Standard custody, not a replay of initialization balances.
// The program checks initial allocations atomically in tag 6. A later observation
// must allow trades, claims, burns, donations and third-party liquidity additions.
// One finalized RPC snapshot includes the campaign counters and all their custody
// accounts, so concurrent claims cannot create a mixed-slot deficit. v2 is untouched.
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {unpackAccount,unpackMint} from '@solana/spl-token';
import * as client from '../protocol-v2/client.mjs';
const disc=name=>createHash('sha256').update('account:'+name).digest().subarray(0,8);
export function withLiveVerification(chain,{connection,programVersion}){
 if(programVersion!==3||!connection||typeof chain?.readCampaign!=='function')throw Error('Live verification requires the explicit v3 adapter');
 const program=client.toKey(chain.programId),genesis=client.toKey(chain.genesisHash);
 return {...chain,async verifyLaunch(id){
  if(!client.toKey(id.programId).equals(program)||!client.toKey(id.genesisHash).equals(genesis))throw Error('Live verification scope mismatch');
  const campaign=client.toKey(id.campaign),initial=await chain.readCampaign(id);
  if(initial.phase!==3)return {ok:false,failures:['Campaign is not live'],checks:{}};
  const a=client.launchAddresses(program,campaign,initial.terms,initial.feeNft);
  // The extension of a funding-first campaign (accounting version 2) rides in the same finalized snapshot; a version-0
  // campaign has none, so only that address may be absent.
  const ext=PublicKey.findProgramAddressSync([Buffer.from('ext'),campaign.toBuffer()],program)[0];
  const addresses=[campaign,initial.terms.childMint,a.child,a.vault0,a.vault1,a.lockVault,a.locked,a.feeNftAccount,a.feeNft,a.pool,a.lpMint,ext];
  let response;
  try{response=await connection.getMultipleAccountsInfoAndContext(addresses,{commitment:'finalized',minContextSlot:initial.slot});}
  catch(error){if(error?.code===-32016)throw Object.assign(Error('Finalized live verification snapshot unavailable'),{code:'RPC_UNAVAILABLE'});throw error;}
  if(!Number.isSafeInteger(response?.context?.slot)||response.context.slot<initial.slot||!Array.isArray(response.value)||response.value.length!==addresses.length)throw Error('Live verification snapshot unavailable');
  const failures=[],check=(ok,why)=>{if(!ok)failures.push(why);};
  const invalid=why=>{throw Error('Live verification account: '+why);};
  const info=response.value;
  if(info.some((x,i)=>!x&&i!==11))throw Error('Live verification account missing');
  function owned(index,owner,length){const value=info[index];if(!value||value.executable||!value.owner.equals(owner)||value.data.length!==length)invalid('owner or layout at '+index);return value;}
  const record=owned(0,program,client.CAMPAIGN_LEN).data,decoded=client.decodeCampaign(record),{terms:t,state:s,split}=decoded;
  const fundingFirst=record[992]===2;
  // Anyone can send lamports to the public extension address of a version-0 campaign; only a real extension (program-owned
  // or holding data) contradicts the version-0 record.
  if(!fundingFirst&&info[11])check(info[11].owner.equals(client.SYSTEM_PROGRAM??new PublicKey('11111111111111111111111111111111'))&&info[11].data.length===0,'A version-0 campaign carries an extension account');
  check(s.phase===3,'Campaign is not live');
  check(t.genesis===client.keyHex(genesis)&&client.campaignAddress(program,t.creator,t.nonce).equals(campaign),'Campaign identity differs');
  check(s.termsHash===initial.termsHash&&s.pool.toBase58()===initial.pool&&s.feeNft.toBase58()===initial.feeNft,'Sealed launch identity changed between reads');
  check(s.pool.equals(a.pool),'Pool is not canonical');
  check(t.mode===0&&s.flags===0&&t.distributionProgram.equals(PublicKey.default),'Only undistributed Standard custody is qualified');
  check(s.parentClaimed.every(v=>v===0n)&&split.parentA===0n&&split.parentB===0n,'Standard parent custody differs');
  check(s.participantClaimed<=split.participants&&s.devClaimed<=split.dev,'Claims exceed their sealed reserves');
  // Accepted lamports that left for the pool: the settled total (version 0) or the sealed accepted target (version 2).
  let acceptedTotal=s.settledAccepted,collateralHeld=0n;
  if(!fundingFirst)check(s.settledCount===s.receiptCount&&s.settledAccepted>=t.soft&&s.settledAccepted<=t.hard&&s.settledAccepted<=s.total,'Settlement counters differ');
  else{
   const e=owned(11,program,256).data;
   check(e.subarray(0,8).toString()==='KIDSEXT2'&&new PublicKey(e.subarray(8,40)).equals(campaign)&&e.subarray(40,72).toString('hex')===s.termsHash&&new PublicKey(e.subarray(72,104)).equals(t.childMint)&&new PublicKey(e.subarray(104,136)).equals(a.feeNft)&&e[168]===2,'Extension identity differs');
   const sealed=e[169]!==0,receipts=BigInt(e.readUInt32LE(172)),total=e.readBigUInt64LE(176),target=e.readBigUInt64LE(184),returned=e.readBigUInt64LE(208);
   const expectedTarget=s.total<t.hard?s.total:t.hard;
   check(sealed&&total===s.total&&receipts===s.receiptCount&&target===expectedTarget&&target>=t.soft,'Sealed totals differ from the record');
   check(s.settledCount===0n&&s.settledAccepted===0n,'Version-2 record carries settlement counters');
   check(returned<=65535n,'Collateral returned above the collateral');
   acceptedTotal=target;collateralHeld=65535n-returned;
  }
  function token(index,mint,owner){
   const value=unpackAccount(addresses[index],owned(index,client.TOKEN_PROGRAM,165),client.TOKEN_PROGRAM);
   check(value.isInitialized&&!value.isFrozen&&value.mint.equals(mint)&&value.owner.equals(owner)&&value.delegate===null&&value.delegatedAmount===0n&&value.closeAuthority===null&&value.isNative===mint.equals(client.WSOL),'Unsafe token custody at '+index);
   return value;
  }
  const mint=unpackMint(addresses[1],owned(1,client.TOKEN_PROGRAM,82),client.TOKEN_PROGRAM);
  check(mint.isInitialized&&mint.mintAuthority===null&&mint.freezeAuthority===null,'Mint authorities are not revoked');
  check(mint.decimals===t.decimals&&mint.supply<=t.supply,'Mint supply or decimals exceed sealed terms');
  const custody=token(2,t.childMint,a.authority),v0=token(3,a.mint0,a.ammAuthority),v1=token(4,a.mint1,a.ammAuthority);
  const remaining=split.participants-s.participantClaimed+split.dev-s.devClaimed;
  check(remaining>=0n&&custody.amount>=remaining,'Claim custody is below remaining participant and dev liabilities');
  const childVault=a.mint0.equals(t.childMint)?v0:v1,solVault=a.mint0.equals(t.childMint)?v1:v0;
  check(mint.supply>=custody.amount+childVault.amount,'Observed token balances exceed remaining mint supply');
  const lockVault=token(5,a.lpMint,a.lockAuthority),d=owned(6,t.lockProgram,256).data;
  check(d.subarray(0,8).equals(disc('LockedCpLiquidityState')),'Lock discriminator differs');
  for(const [at,key]of [[64,a.pool],[96,a.feeNft],[128,a.authority],[160,a.lpMint]])check(new PublicKey(d.subarray(at,at+32)).equals(key),'Lock identity differs at '+at);
  const lockedLp=d.readBigUInt64LE(8);
  // This canonical vault is shared with other positions in the same pool.
  check(lockedLp>0n&&lockVault.amount>=lockedLp,'Locked position is not covered by its vault');
  const nft=token(7,a.feeNft,campaign),nftMint=unpackMint(a.feeNft,owned(8,client.TOKEN_PROGRAM,82),client.TOKEN_PROGRAM);
  check(nft.amount===1n&&nftMint.isInitialized&&nftMint.supply===1n&&nftMint.decimals===0&&nftMint.mintAuthority===null&&nftMint.freezeAuthority===null,'Fee rights NFT is not sealed in campaign custody');
  const p=owned(9,t.ammProgram,637).data;
  check(p.subarray(0,8).equals(disc('PoolState')),'Pool discriminator differs');
  for(const [i,key]of [t.ammConfig,a.authority,a.vault0,a.vault1,a.lpMint,a.mint0,a.mint1,client.TOKEN_PROGRAM,client.TOKEN_PROGRAM,a.observation].entries())check(new PublicKey(p.subarray(8+32*i,40+32*i)).equals(key),'Pool identity differs at '+i);
  check(p[329]===0&&p[390]===0,'Pool status or creator fee policy differs');
  const lpMint=unpackMint(a.lpMint,owned(10,client.TOKEN_PROGRAM,82),client.TOKEN_PROGRAM),lpSupply=p.readBigUInt64LE(333);
  check(lpMint.isInitialized&&lpMint.mintAuthority?.equals(a.ammAuthority)&&lpMint.freezeAuthority===null,'LP mint authority differs');
  check(lpMint.supply>=lockVault.amount&&lpSupply>=lpMint.supply+100n,'Locked LP or mint supply exceeds pool accounting');
  for(const [side,v]of [v0,v1].entries())check(v.amount>p.readBigUInt64LE(341+8*side)+p.readBigUInt64LE(357+8*side)+p.readBigUInt64LE(397+8*side),'Pool net reserve is empty');
  const rent=BigInt(await connection.getMinimumBalanceForRentExemption(client.CAMPAIGN_LEN,'finalized')),liability=s.total-acceptedTotal+collateralHeld-s.refunded;
  if(!Number.isSafeInteger(info[0].lamports))throw Error('Campaign lamports exceed exact RPC number range');
  const lamports=BigInt(info[0].lamports);
  check(liability>=0n&&lamports>=rent+liability,'Refund custody is below its remaining liability');
  return {ok:failures.length===0,failures,checks:{kind:'current-standard-custody-v3',slot:response.context.slot,custody:custody.amount,remainingClaims:remaining,coinVault:childVault.amount,solVault:solVault.amount,lockedLp,lockVault:lockVault.amount,lpSupply,remainingSupply:mint.supply,mintAuthority:mint.mintAuthority,freezeAuthority:mint.freezeAuthority,campaignLamports:lamports,rent,liability,pool:a.pool.toBase58(),feeNft:a.feeNft.toBase58(),launchTime:s.launchTime}};
 }};
}
