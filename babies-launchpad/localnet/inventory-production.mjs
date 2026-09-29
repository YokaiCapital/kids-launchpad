// P0 of the public-launches plan: a machine-readable inventory of what is deployed and what is owed, no secrets.
//   node localnet/inventory-production.mjs [--rpc <url>] > deployment/inventory/PRODUCTION-INVENTORY-<date>.json
// Reads: the identities record, the chain (program data, campaign, pool, custody), the API's public reads (through the
// gateway with the owner's local access file when present), the Railway deployment list (CLI) and the archived plans.
import {readFileSync,existsSync,readdirSync} from 'node:fs';import {execSync} from 'node:child_process';import {createHash} from 'node:crypto';import os from 'node:os';
import {Connection,PublicKey} from '@solana/web3.js';
import {fileURLToPath} from 'node:url';const root=fileURLToPath(new URL('../',import.meta.url));const read=p=>JSON.parse(readFileSync(root+p,'utf8'));
const args=process.argv.slice(2),opt=n=>{const i=args.indexOf(n);return i>=0?args[i+1]:undefined;};
const rpc=opt('--rpc')||process.env.KIDS_HELIUS_RPC_URL||'https://api.mainnet-beta.solana.com';const c=new Connection(rpc,'confirmed');
const ids=read('deployment/MAINNET-IDENTITIES.json');const programId=new PublicKey(ids.program.programId);
const out={generatedAt:new Date().toISOString(),network:'mainnet',genesisHash:ids.genesisHash,rpcLabel:rpc.replace(/api-key=[^&]+/,'api-key=<redacted>').replace(/https:\/\/[^/]*helius[^/]*\/?.*/,'helius (server-side url)'),program:{},services:{},site:{},campaigns:[],liabilities:{},poolConfigs:{},signerPolicy:{},notes:[]};
// Program: bytes on chain vs recorded builds
const [programData]=PublicKey.findProgramAddressSync([programId.toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'));
const pd=await c.getAccountInfo(programData);const body=pd.data.subarray(45);const slot=Number(pd.data.readBigUInt64LE(4));const authority=pd.data[12]?new PublicKey(pd.data.subarray(13,45)).toBase58():null;
const builds=[{sha256:ids.program.binarySha256,binarySize:ids.program.binarySize,version:'primary'},...(ids.program.builds||[])];
const live=builds.find(b=>b.binarySize<=body.length&&createHash('sha256').update(body.subarray(0,b.binarySize)).digest('hex')===b.sha256&&body.subarray(b.binarySize).every(x=>x===0));
out.program={programId:programId.toBase58(),programData:programData.toBase58(),upgradeAuthority:authority,lastDeploySlot:slot,programDataBytes:pd.data.length,liveBuild:live?{version:live.version,sha256:live.sha256,binarySize:live.binarySize,features:live.features||[],note:live.note||null}:null,recordedBuilds:builds.map(b=>({version:b.version,sha256:b.sha256,binarySize:b.binarySize,features:b.features||[]})),distributionProgram:ids.distribution?.programId||null,distributionBuildSha256:ids.distribution?.binarySha256||null};
if(!live)out.notes.push('program bytes on chain match none of the recorded builds');
// Source revisions of the policy files in the publication clone (content hashes, no secrets)
const clone='/tmp/kids-fresh-repo';const gitHash=p=>{try{return execSync('git -C '+clone+' hash-object babies-launchpad/'+p,{encoding:'utf8'}).trim();}catch{return null;}};
const headCommit=(()=>{try{return execSync('git -C '+clone+' rev-parse HEAD',{encoding:'utf8'}).trim();}catch{return null;}})();
out.signerPolicy={sourceCommit:headCommit,signerPolicyBlob:gitHash('localnet/signer-policy.mjs'),signerServiceBlob:gitHash('localnet/signer-service.mjs'),feeKeeperBlob:gitHash('localnet/active-fee-keeper.mjs'),activeLaunchBlob:gitHash('localnet/active-launch.mjs')};
// Pool configurations the code accepts
try{const al=await import('./atomic-launch.mjs');out.poolConfigs={cpmmProgram:String(al.CPMM),tiers:(al.AMM_TIERS||[]).map(t=>({key:String(t.key),bps:t.bps??t.tradeBps??null,index:t.index??null})),newPoolConfig:String(al.AMM_CONFIG),parentPoolConfig:String(al.PARENT_AMM_CONFIG),lockProgram:String(al.LOCK)};}catch(e){out.notes.push('pool configs unreadable: '+e.message.slice(0,80));}
// Railway services (deployment commits and status only)
try{const q='query { api: deployments(first: 1, input: { projectId: "'+ids.hosting.projectId+'", environmentId: "'+ids.hosting.environmentId+'", serviceId: "'+ids.hosting.serviceId+'" }) { edges { node { id status createdAt meta } } } signer: deployments(first: 1, input: { projectId: "'+ids.hosting.projectId+'", environmentId: "'+ids.hosting.environmentId+'", serviceId: "'+ids.hosting.signer.serviceId+'" }) { edges { node { id status createdAt meta } } } }';
 const tmp=os.tmpdir()+'/kids-inv-'+process.pid+'.graphql';(await import('node:fs')).writeFileSync(tmp,q);const raw=execSync('/opt/homebrew/Cellar/railway/5.49.6/bin/railway api -f '+tmp,{encoding:'utf8'});const d=JSON.parse(raw.slice(raw.indexOf('{')));
 for(const k of ['api','signer']){const n=d.data[k].edges[0]?.node;out.services[k]={deploymentId:n?.id||null,status:n?.status||null,createdAt:n?.createdAt||null,commit:n?.meta?.commitHash||null,branch:n?.meta?.branch||null};}
}catch(e){out.notes.push('railway deployments unavailable: '+e.message.slice(0,80));}
out.services.believersWorker={serviceId:'3e51321e-aba2-43f4-85c4-6bbf8a55bf25',note:'cron */30, publishes supporters; holds no KIDS keys'};
out.site={vercelProject:'kids-fun',domain:'https://kids.fun',gate:'password until the owner sets KIDS_ACCESS_OPENS_AT (set 23 Sep 2026 ~23:20 UTC)'};
// API public reads (owner's local access file; never printed)
let api=null;try{const a=JSON.parse(readFileSync(os.homedir()+'/.config/kids/mainnet-access.json','utf8'));const H={origin:'https://kids.fun',authorization:'Bearer '+a.KIDS_BACKEND_TOKEN};const base=a.domain.replace(/\/$/,'');
 const get=async p=>{const r=await fetch(base+p,{headers:H,signal:AbortSignal.timeout(20000)});return r.ok?r.json():null;};api={pre:await get('/api/account/prelaunch'),post:await get('/api/account/postlaunch'),vesting:await get('/api/account/dev-vesting')};}catch(e){out.notes.push('api reads unavailable: '+e.message.slice(0,80));}
// Active campaign: chain + api
const active=api?.pre?.escrowAddress?api.pre:null;
if(active){const camp=new PublicKey(active.escrowAddress);const info=await c.getAccountInfo(camp);const receipts=await c.getProgramAccounts(programId,{dataSlice:{offset:0,length:0},filters:[{dataSize:112},{memcmp:{offset:8,bytes:active.escrowAddress}}]});
 const p=api.post||{};const f=p.fees||{};
 out.campaigns.push({role:'active',identity:{genesisHash:ids.genesisHash,programId:programId.toBase58(),campaign:active.escrowAddress},mode:'family',mint:active.mint,pool:p.pool||null,phase:active.phase,launchSignature:p.launchSignature||null,launchedAt:p.launchedAt||null,terms:{soft:active.softCapLamports,hard:active.hardCapLamports,deadlineUnix:active.deadlineUnix,launchDeadlineUnix:active.launchDeadlineUnix},chain:{campaignLamports:String(info?.lamports||0),phaseByte:info?.data[96]??null,receiptAccounts:receipts.length},totals:{committed:active.totalLamports,accepted:active.settledAcceptedLamports,refunded:active.refundedLamports,receipts:active.receiptCount,settled:active.settledReceiptCount},parents:(p.parentStats?.parents||[]).map(x=>({mint:x.mint,eligible:x.eligibleOwners,allocationRaw:x.allocationRaw,claimedRaw:x.claimedRaw,claimedCount:x.claimedCount,rootVerified:x.rootVerified})),fees:f,vesting:api.vesting||null,liquidityLocked:p.liquidityLocked??null,mintAuthorityRevoked:p.mintAuthorityRevoked??null,freezeAuthorityRevoked:p.freezeAuthorityRevoked??null});
 const parentReserve=(p.parentStats?.parents||[]).reduce((s,x)=>s+BigInt(x.allocationRaw||0)-BigInt(x.claimedRaw||0),0n);
 out.liabilities={activeCampaign:active.escrowAddress,solStillRefundable:String(BigInt(active.totalLamports)-BigInt(active.settledAcceptedLamports)-BigInt(active.refundedLamports)),participantTokensUnclaimedNote:'43.5 % of supply less claims; per-receipt claim flags on chain (claims tab)',parentReserveUnclaimedRaw:String(parentReserve),parentBuybackBudgetLamports:{a:String(BigInt(f.parentAAllocated||0)-BigInt(f.parentASpent||0)),b:String(BigInt(f.parentBAllocated||0)-BigInt(f.parentBSpent||0))},childFeesPendingBurnRaw:f.childPending||'0'};}
// Archived campaigns (plans in the repository)
const archive=root+'deployment/mainnet/archive/';if(existsSync(archive))for(const f of readdirSync(archive).filter(x=>x.startsWith('campaign-plan-')&&x.endsWith('.json'))){const plan=read('deployment/mainnet/archive/'+f);out.campaigns.push({role:'archived',identity:{genesisHash:ids.genesisHash,programId:plan.programId,campaign:plan.campaign},mode:'family',terms:plan.terms,plannedAt:plan.plannedAt,token:plan.token?.symbol||null,note:'test campaign; runtime files archived on the API volume under localnet/.runtime/archive/<campaign>/'});}
if(ids.firstCampaign)out.campaigns.push({role:'historical',identity:{genesisHash:ids.genesisHash,programId:programId.toBase58(),campaign:ids.firstCampaign.campaign},mode:'family',mint:ids.firstCampaign.coinMint,pool:ids.firstCampaign.pool,launchedAt:ids.firstCampaign.launchedAt,note:ids.firstCampaign.note||'first mainnet test launch'});
out.notes.push('claims and refunds of archived and historical campaigns are reachable on chain but not through the site until the multi-campaign registry (P1) exists');
console.log(JSON.stringify(out,null,2));
