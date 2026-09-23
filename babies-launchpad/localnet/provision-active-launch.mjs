// Explicit operator provisioning only. Does not select the application's v1 API.
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {acceptedProgramHash} from './program-lineage.mjs';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Keypair,PublicKey,Transaction,SystemProgram} from '@solana/web3.js';
import {MINT_SIZE,NATIVE_MINT,TOKEN_PROGRAM_ID,getMint,getAccount,getAssociatedTokenAddressSync,createInitializeMint2Instruction,createAssociatedTokenAccountIdempotentInstruction,createMintToInstruction,createSetAuthorityInstruction,AuthorityType} from '@solana/spl-token';
import {atomicContext,campaignAddress,authorityAddress,initInstruction,readCampaign,PROFILE} from './atomic-launch.mjs';
import {configureParentsInstruction,parentsAddress} from './atomic-claims.mjs';
import {captureLocalParentSnapshot,publicSnapshot} from './parent-snapshot.mjs';
import {localKey,chainTime} from './dev-vesting.mjs';
import {operatorSigner} from './operator-signer.mjs';
import {buildCampaignSnapshot} from './import-parent-snapshot.mjs';
import {tokenBranding,pinTokenMetadata,createMetadataInstruction,metadataAddress,LOCALNET_TOKEN,TEST_TOKEN} from './token-metadata.mjs';
import {distributionProgramFor} from './distribution.mjs';import {manifestFeatures} from './program-builds.mjs';
const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const identitiesPath=fileURLToPath(new URL('../deployment/MAINNET-IDENTITIES.json',import.meta.url));
/** Campaign plan for devnet/mainnet: nonce fixed in advance so the parent snapshot can name the campaign before it exists. */
export function campaignPlanPath(network){return fileURLToPath(new URL('../deployment/'+network+'/campaign-plan.json',import.meta.url));}
export function snapshotDirectory(network){return process.env.KIDS_PARENT_SNAPSHOT_DIR||fileURLToPath(new URL('../deployment/'+network+'/snapshots/',import.meta.url));}
const DRY_RUN=process.env.KIDS_DRY_RUN==='1';
/** Signs with the operator signer (local keypair on localnet, remote service elsewhere) plus any extra local keypairs,
 * then sends and confirms. Dry run simulates the signed transaction and stops. */
export async function sendWithOperator({connection,operator,tx,extraSigners=[],operationId,dryRun=false}){
 tx.feePayer=operator.publicKey;const block=await connection.getLatestBlockhash('confirmed');tx.recentBlockhash=block.blockhash;
 if(extraSigners.length)tx.partialSign(...extraSigners);await operator.sign(tx,{operationId});
 if(dryRun){const sim=await connection.simulateTransaction(tx);if(sim.value.err)throw Error('Dry run: simulation failed '+JSON.stringify(sim.value.err)+' '+(sim.value.logs||[]).slice(-4).join(' | '));throw Error('Dry run: next step simulates OK ('+sim.value.unitsConsumed+' CU); nothing was sent');}
 const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
 const result=await connection.confirmTransaction({signature,...block},'confirmed');if(result.value.err)throw Error('Transaction failed: '+JSON.stringify(result.value.err));return signature;
}
import {activeManifestPath,saveActiveFile,validateActiveManifest,validateActiveTerms,readActive,validCampaignTerms,campaignWindow,ACTIVE_SUPPLY,LAUNCH_WINDOW_SECONDS} from './active-launch.mjs';
/** Campaign terms for a NEW campaign. Defaults are the production terms (100 SOL soft, 500 SOL hard, 24 h funding).
 * Private test services may set KIDS_ACTIVE_SOFT_CAP_SOL, KIDS_ACTIVE_HARD_CAP_SOL (whole or decimal SOL, up to 9 places)
 * and KIDS_ACTIVE_DEADLINE_SECONDS (60 s to 7 days). The launch window after funding closes stays 24 h. An existing
 * campaign keeps the terms it was created with. Invalid values refuse provisioning instead of falling back. */
export function activeCampaignTerms(env=process.env){
 const sol=(name,fallback)=>{const raw=env[name];if(raw===undefined||raw==='')return fallback;const m=/^(\d{1,4})(?:\.(\d{1,9}))?$/.exec(raw);if(!m)throw Error(name+' must be SOL with at most 9 decimals');return (BigInt(m[1])*1000000000n+BigInt((m[2]||'').padEnd(9,'0'))).toString();};
 const soft=sol('KIDS_ACTIVE_SOFT_CAP_SOL','100000000000'),hard=sol('KIDS_ACTIVE_HARD_CAP_SOL','500000000000');
 const rawDeadline=env.KIDS_ACTIVE_DEADLINE_SECONDS;const deadlineSeconds=rawDeadline===undefined||rawDeadline===''?86400:Number(rawDeadline);
 if(!Number.isSafeInteger(deadlineSeconds)||deadlineSeconds<60||deadlineSeconds>604800)throw Error('KIDS_ACTIVE_DEADLINE_SECONDS must be an integer from 60 to 604800');
 const terms={soft,hard,supply:ACTIVE_SUPPLY,deadlineSeconds};
 if(!validCampaignTerms({soft,hard,supply:ACTIVE_SUPPLY,deadline:0,launchDeadline:LAUNCH_WINDOW_SECONDS}))throw Error('Campaign terms out of bounds: soft cap must be positive, at most the hard cap, and the hard cap at most 500 SOL');
 return terms;
}
const runtime=fileURLToPath(new URL('./.runtime/',import.meta.url)),keysPath=runtime+'active-launch-setup-keys.json';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
let provisioning;
export function provisionActiveLaunch(){if(provisioning)return provisioning;provisioning=provision().finally(()=>{provisioning=null;});return provisioning;}
async function provision(){
 const ctx=await atomicContext(),c=ctx.connection,admin=await operatorSigner(),local=PROFILE.network==='localnet';mkdirSync(runtime,{recursive:true,mode:0o700});
 const send=(tx,extraSigners=[],stage='step')=>sendWithOperator({connection:c,operator:admin,tx,extraSigners,operationId:'provision:'+stage,dryRun:DRY_RUN});
 let m;
 if(existsSync(activeManifestPath)){m=validateActiveManifest(ctx,read(activeManifestPath));if(m.ready)return readActive();}
 else{
  let parentMints,dev,treasury,nonce,terms=activeCampaignTerms(process.env),now=await chainTime(c);
  if(local){
   const report=read(runtime+'atomic-launch-verification.json');
   if(report.network!=='localnet'||report.rpcUrl!=='http://127.0.0.1:19099'||report.genesisHash!==ctx.manifest.genesisHash||report.programId!==ctx.programId.toBase58()||!acceptedProgramHash(ctx.manifest,report.programSha256)||report.parentMints?.length!==2)throw Error('Verified parent fixture unavailable');
   parentMints=report.parentMints;dev=localKey('alice').publicKey.toBase58();treasury=admin.publicKey.toBase58();nonce=randomBytes(8).readBigUInt64LE();var token=tokenBranding(LOCALNET_TOKEN);
  }else{
   // Real networks: parents, dev and treasury from the recorded identities; nonce and terms from the campaign plan.
   const identities=read(identitiesPath),plan=read(campaignPlanPath(PROFILE.network));
   if(identities.network!=='mainnet'&&PROFILE.network==='mainnet')throw Error('Identities file is not for mainnet');
   if(plan.network!==PROFILE.network||plan.creator!==admin.publicKey.toBase58()||plan.programId!==ctx.programId.toBase58())throw Error('Campaign plan does not match this network, operator or program');
   parentMints=identities.parents.map(p=>p.mint);dev=identities.devWallet.address;treasury=identities.treasuryWallet.address;nonce=BigInt(plan.nonce);terms={...terms,...plan.terms};
   if(campaignAddress(ctx.programId,admin.publicKey,nonce).toBase58()!==plan.campaign)throw Error('Campaign plan address mismatch');
   // Branding comes from the plan (the public launch carries the real name and artwork); a plan without it is a test coin.
   var token=tokenBranding(plan.token||TEST_TOKEN);
  }
  // Persist identities before any transaction; retries cannot create another coin.
  const mint=Keypair.generate(),nft=Keypair.generate();
  saveActiveFile(keysPath,{mint:Array.from(mint.secretKey),nft:Array.from(nft.secretKey)});
  m={version:3,network:PROFILE.network,rpcUrl:PROFILE.rpcLabel,programId:ctx.programId.toBase58(),programSha256:ctx.manifest.sha256,genesisHash:ctx.manifest.genesisHash,creator:admin.publicKey.toBase58(),nonce:nonce.toString(),address:campaignAddress(ctx.programId,admin.publicKey,nonce).toBase58(),mint:mint.publicKey.toBase58(),feeNft:nft.publicKey.toBase58(),supply:'1000000000000000',soft:terms.soft,hard:terms.hard,deadlineSeconds:terms.deadlineSeconds,...campaignWindow(terms.deadlineSeconds,now),dev,treasury,parentMints,token,metadataUri:null,distributionProgram:distributionProgramFor(PROFILE.network)?.toBase58()||null,ready:false};
  saveActiveFile(activeManifestPath,m);
 }
 if(m.creator!==admin.publicKey.toBase58())throw Error('Provisioner creator mismatch');
 const keys=read(keysPath),mint=Keypair.fromSecretKey(Uint8Array.from(keys.mint));if(mint.publicKey.toBase58()!==m.mint)throw Error('Stored mint identity mismatch');
 const campaign=new PublicKey(m.address),authority=authorityAddress(ctx,campaign),child=getAssociatedTokenAddressSync(mint.publicKey,authority,true),wsol=getAssociatedTokenAddressSync(NATIVE_MINT,authority,true);
 if(!await c.getAccountInfo(mint.publicKey)){
  // Metadata first (pinned once, remembered in the manifest so a retry never pins twice), then one atomic transaction:
  // create + initialise the mint, mint the supply to custody, attach the immutable metadata, hand both authorities to the PDA.
  const token=tokenBranding(m.token||(local?LOCALNET_TOKEN:TEST_TOKEN));m.token=token;
  if(!m.metadataUri){
   const jwt=process.env.KIDS_PINATA_JWT;
   if(jwt){const imagePath=repoRoot+(token.image||TEST_TOKEN.image);const pinned=await pinTokenMetadata({jwt,token,imagePath});m.metadataUri=pinned.metadataUri;m.imageUri=pinned.imageUri;console.log(JSON.stringify({event:'token-metadata-pinned',symbol:token.symbol,metadataCid:pinned.metadataCid,imageCid:pinned.imageCid}));}
   else if(local)m.metadataUri='https://kids.fun/rehearsal/'+mint.publicKey.toBase58()+'.json';
   else throw Error('KIDS_PINATA_JWT is required to attach the coin metadata on '+PROFILE.network);
   saveActiveFile(activeManifestPath,m);
  }
  // Freeze authority: revoked at creation. Mint authority: revoked at creation once the live program accepts it (build 3
  // feature 'revoke-at-creation'); until then it stays on the launch authority and is revoked at launch.
  const revokeAtCreation=manifestFeatures(ctx.manifest).includes('revoke-at-creation');m.revokeAtCreation=revokeAtCreation;
  const rent=await c.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx=new Transaction().add(SystemProgram.createAccount({fromPubkey:admin.publicKey,newAccountPubkey:mint.publicKey,lamports:rent,space:MINT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeMint2Instruction(mint.publicKey,6,admin.publicKey,admin.publicKey),createAssociatedTokenAccountIdempotentInstruction(admin.publicKey,child,authority,mint.publicKey),createMintToInstruction(mint.publicKey,child,admin.publicKey,BigInt(m.supply)),createMetadataInstruction({mint:mint.publicKey,mintAuthority:admin.publicKey,payer:admin.publicKey,name:m.token.name,symbol:m.token.symbol,uri:m.metadataUri}),createSetAuthorityInstruction(mint.publicKey,admin.publicKey,AuthorityType.MintTokens,revokeAtCreation?null:authority),createSetAuthorityInstruction(mint.publicKey,admin.publicKey,AuthorityType.FreezeAccount,null));
  m.mintSignature=await send(tx,[mint],'mint:'+m.address);saveActiveFile(activeManifestPath,m);
 }
 if(!await c.getAccountInfo(metadataAddress(mint.publicKey)))throw Error('Coin metadata account missing after mint creation');
 const info=await getMint(c,mint.publicKey),holding=await getAccount(c,child);if(info.decimals!==6||info.supply!==BigInt(m.supply)||(m.revokeAtCreation?info.mintAuthority!==null:!info.mintAuthority?.equals(authority))||info.freezeAuthority!==null||holding.amount!==BigInt(m.supply)||!holding.owner.equals(authority))throw Error('Mint custody or fixed supply mismatch');
 await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey,wsol,authority,NATIVE_MINT)),[],'wsol:'+m.address);
 // Launch authority funding: a mainnet launch used 0.18 SOL (pool creation fee, lookup table, rent); 0.22 SOL leaves a margin. Override with KIDS_LAUNCH_AUTHORITY_TOPUP_LAMPORTS.
 const topUp=BigInt(process.env.KIDS_LAUNCH_AUTHORITY_TOPUP_LAMPORTS||'220000000');const balance=BigInt(await c.getBalance(authority));if(balance<topUp)await send(new Transaction().add(SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:authority,lamports:topUp-balance})),[],'topup:'+m.address);
 const snapshotPath=runtime+'parent-snapshot-'+m.address+'.json';let snapshot;
 if(existsSync(snapshotPath))snapshot=read(snapshotPath);
 else if(local){snapshot=publicSnapshot(await captureLocalParentSnapshot(ctx,campaign,m.parentMints));saveActiveFile(snapshotPath,snapshot);}
 else{
  // Real networks: the snapshot evidence must already exist for THIS campaign address (taken with snapshot-parents-mainnet.mjs).
  const identities=read(identitiesPath);
  snapshot=publicSnapshot(buildCampaignSnapshot({directory:snapshotDirectory(PROFILE.network),campaign:m.address,network:PROFILE.network,genesisHash:m.genesisHash,parents:identities.parents.map(p=>({mint:p.mint,tokenProgram:p.tokenProgram}))}));
  saveActiveFile(snapshotPath,snapshot);
 }
 if(snapshot.campaign!==m.address||snapshot.genesisHash!==m.genesisHash||snapshot.parents.some((p,i)=>p.mint!==m.parentMints[i]))throw Error('Parent snapshot identity mismatch');
 const campaignInfo=await c.getAccountInfo(campaign);
 if(!campaignInfo||campaignInfo.owner.equals(SystemProgram.programId)&&campaignInfo.data.length===0){
  const parents=m.parentMints.map(x=>new PublicKey(x));
  // A parent may be Token-2022: read its program from the mint account's owner.
  for(let i=0;i<2;i++){const info=await c.getAccountInfo(parents[i]);if(!info)throw Error('Parent mint missing');const supply=(await getMint(c,parents[i],'confirmed',info.owner)).supply.toString();if(supply!==snapshot.parents[i].supply){if(local)throw Error('Parent supply changed since snapshot');console.log(JSON.stringify({event:'parent-supply-moved-since-snapshot',mint:parents[i].toBase58(),atSnapshot:snapshot.parents[i].supply,now:supply}));}}
  // The window opens now, at creation: a manifest written earlier (a refused or failed first attempt) carries stale deadlines.
  const deadlineSeconds=m.deadlineSeconds??(local?activeCampaignTerms(process.env).deadlineSeconds:read(campaignPlanPath(PROFILE.network)).terms.deadlineSeconds);
  Object.assign(m,{deadlineSeconds},campaignWindow(deadlineSeconds,await chainTime(c)));saveActiveFile(activeManifestPath,m);
  const terms={...m,nonce:BigInt(m.nonce),mint:mint.publicKey};
  m.initSignature=await send(new Transaction().add(initInstruction(ctx,admin.publicKey,terms,m.distributionProgram?new PublicKey(m.distributionProgram):null),configureParentsInstruction(ctx,campaign,admin.publicKey,parents,snapshot.parents.map(p=>Buffer.from(p.root,'hex')),snapshot.slot,snapshot.parents.map(p=>BigInt(p.eligibleBalance)))),[],'init:'+m.address);saveActiveFile(activeManifestPath,m);
 }
 const state=await readCampaign(ctx,campaign);validateActiveTerms(state,m);
 const parents=await c.getAccountInfo(parentsAddress(ctx,campaign)),live=await c.getAccountInfo(campaign);
 if(live.data[98]!==1||!parents?.owner.equals(ctx.programId)||parents.data.length!==256||parents.data.subarray(0,8).toString()!=='KIDSPAR1'||!parents.data.subarray(8,40).equals(campaign.toBuffer())||snapshot.parents.some((p,i)=>!parents.data.subarray(104+i*32,136+i*32).equals(Buffer.from(p.root,'hex'))))throw Error('Parent configuration not verified');
 m.ready=true;saveActiveFile(activeManifestPath,m);return readActive();
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(await provisionActiveLaunch(),null,2));
