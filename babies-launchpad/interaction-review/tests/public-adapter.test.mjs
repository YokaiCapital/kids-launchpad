import {campaignViewModel} from '../server/public-campaign-contract.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeCampaign,normalizeManifest,fundingState,meter,openingEstimate,settleReceipt,participantTokens,estimatePosition,settledPosition,supplySplit,termsRows,exploreRow,filterRows,sortRows,defaultSortFor,claimGroups,transactionCopy,ELIGIBILITY_COPY,ADAPTER_VERSION} from '../src/public/campaign-adapter.mjs';
import {safeMediaUrl,mediaCspDirectives,MEDIA_HOSTS,SITE_HOSTS} from '../src/public/media-hosts.mjs';

const SUPPLY={totalBaseUnits:'1000000000000000',decimals:6,participantsBps:4850,liquidityBps:4850,parentsBps:0,devBps:300};
const record=(over={})=>({identity:{genesisHash:'fixture-localnet',programId:'FixtureProgram11111111111111111111111111111',campaign:'FixtureCampaignA1111111111111111111111111111'},
 mode:'standard',name:'Pebble',symbol:'PEBL',phase:'open',
 terms:{version:'presets-v1-proposed',hash:'h1',presetId:'community',softLamports:'50000000000',hardLamports:'100000000000',opensAtUnix:1000,deadlineUnix:8200,launchDeadlineUnix:15400,supply:SUPPLY,vesting:{immediateBps:100,vestedBps:200,months:3},fee:{totalBps:250,creatorFeeEnabled:false,tokenSide:'burn',solRouting:{standard:{treasury:148,dev:20,of:168}}},lock:{program:'LockProg',model:'Liquidity principal locked at launch'},upgradeAuthority:'Upg'},
 totals:{committedLamports:'67000000000'},createdAtUnix:900,source:{slot:'1',commitment:'confirmed',fetchedAtUnix:2000},...over});
const vm=(over)=>normalizeCampaign(record(over));

test('normalizeCampaign keeps amounts as decimal strings, derives the composite id and refuses unknown phases',()=>{
 const v=vm();assert.equal(v.adapterVersion,ADAPTER_VERSION);assert.equal(v.id,'fixture-localnet:FixtureProgram11111111111111111111111111111:FixtureCampaignA1111111111111111111111111111');
 assert.equal(v.totals.committedLamports,'67000000000');assert.equal(v.totals.acceptedLamports,null);assert.equal(v.mode,'standard');assert.deepEqual(v.parents,[]);
 assert.equal(vm({phase:'bogus'}).phase,'unavailable');
 assert.equal(vm({links:{x:'javascript:alert(1)',website:'https://pebble.example'}}).links.x,null);
 assert.equal(vm({links:{x:'javascript:alert(1)',website:'https://pebble.example'}}).links.website,'https://pebble.example/');
 assert.throws(()=>normalizeCampaign({identity:{}}),/identity\.campaign/);
 assert.throws(()=>normalizeCampaign(record({totals:{committedLamports:1.5}})),/integer decimal string/);
});

test('creator media URLs pass one rule: same origin, https on an allowed host, data: images only; anything else is the placeholder',()=>{
 const svg="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E";
 assert.equal(safeMediaUrl('/assets/pebble.png'),'/assets/pebble.png');assert.equal(safeMediaUrl('/assets/a.png?v=2'),'/assets/a.png?v=2');assert.equal(safeMediaUrl(svg),svg);
 assert.equal(safeMediaUrl('https://kids.fun/assets/pebble.png'),'https://kids.fun/assets/pebble.png');assert.equal(safeMediaUrl('https://KIDS.fun/a.png'),'https://kids.fun/a.png');
 assert.equal(safeMediaUrl('/assets/clip.mp4',{kind:'video'}),'/assets/clip.mp4');assert.equal(safeMediaUrl('https://kids.fun/clip.mp4',{kind:'video'}),'https://kids.fun/clip.mp4');
 for(const bad of ['http://tracker.example/p.gif?c=1','https://tracker.example/p.gif','https://kids.fun.evil.example/p.gif','https://user:pw@kids.fun/p.gif','//tracker.example/p.gif','javascript:alert(1)','data:text/html,<script>1</script>','data:application/octet-stream;base64,AAAA','/assets/x.png) , url(https://tracker.example/p.gif','/assets/a b.png','\\\\tracker.example\\p.gif','',null,undefined,'ftp://kids.fun/a.png','https://'+'a'.repeat(2100)+'.kids.fun/x.png'])assert.equal(safeMediaUrl(bad),null,String(bad));
 assert.equal(safeMediaUrl(svg,{kind:'video'}),null,'no data: video');assert.equal(safeMediaUrl('data:image/png;base64,'+'A'.repeat(300000)),null,'bounded data: size');
 assert.equal(safeMediaUrl('https://tracker.example/clip.mp4',{kind:'video'}),null);
 const v=vm({media:{pfp:'https://tracker.example/p.gif',banner:'/assets/banner.png',video:'http://tracker.example/big.mp4',poster:'https://kids.fun/poster.jpg),url(https://tracker.example/x',videoCaption:'hi'},parents:[{mint:'ParentMint1111111111111111111111111111111111',name:'Butt',symbol:'BUTT',logo:'https://tracker.example/logo.png'}],mode:'family'});
 assert.equal(v.media.pfp,null);assert.equal(v.media.banner,'/assets/banner.png');assert.equal(v.media.video,null);assert.equal(v.media.poster,'https://kids.fun/poster.jpg),url(https://tracker.example/x','an allowed host keeps its path; the value is rendered as an img src, never inside CSS');assert.equal(safeMediaUrl('https://kids.fun/poster.jpg) center/cover'),null,'whitespace is refused');assert.equal(v.media.videoCaption,'hi');
 assert.equal(v.parents[0].logo,null);assert.equal(vm({parents:[{mint:'ParentMint1111111111111111111111111111111111',name:'Butt',logo:'/assets/parent-buttcoin.png'}],mode:'family'}).parents[0].logo,'/assets/parent-buttcoin.png');
 const m=normalizeManifest({version:'presets-v1-proposed',parents:[{mint:'m1',name:'A',logo:'https://tracker.example/a.png'},{mint:'m2',name:'B',logo:'/assets/parent-fartcoin.webp'},null]});
 assert.deepEqual(m.parents.map(p=>p&&p.logo),[null,'/assets/parent-fartcoin.webp',null]);assert.equal(m.version,'presets-v1-proposed');assert.equal(normalizeManifest(null),null);
 assert.deepEqual([...MEDIA_HOSTS],[...SITE_HOSTS,'gateway.pinata.cloud'],'only the approved media gateway is added');assert.ok(SITE_HOSTS.includes('kids.fun'));
 assert.equal(mediaCspDirectives(),"img-src 'self' data: blob: https://kids.fun https://www.kids.fun https://kids-fun-flax.vercel.app https://gateway.pinata.cloud; media-src 'self' blob: https://kids.fun https://www.kids.fun https://kids-fun-flax.vercel.app https://gateway.pinata.cloud");
});

test('funding state table (spec §6): lifecycle first, then caps',()=>{
 assert.equal(fundingState(vm({phase:'scheduled'}),500).headline,'Opens in 08:20');
 assert.equal(fundingState(vm({phase:'scheduled'}),500).action,'disabled-commit');
 assert.equal(fundingState(vm({phase:'scheduled',terms:{...record().terms,opensAtUnix:null}}),500).headline,'Opening date to be announced');
 const below=fundingState(vm({totals:{committedLamports:'10000000000'}}),2000);assert.equal(below.state,'open-below-soft');assert.equal(below.headline,'Open for commitments');assert.match(below.sub,/needs 50 SOL/);assert.equal(below.countdown.label,'Closes in');assert.equal(below.countdown.seconds,6200);
 const soft=fundingState(vm(),2000);assert.equal(soft.state,'open-soft');assert.equal(soft.headline,'Soft cap reached. Still open.');
 const hard=fundingState(vm({totals:{committedLamports:'143200000000'}}),2000);assert.equal(hard.state,'open-hard');assert.equal(hard.headline,'Hard cap reached. You can still commit.');assert.match(hard.sub,/proportional allocation/);assert.match(hard.sub,/excess SOL back/);
 assert.equal(fundingState(vm({totals:{committedLamports:'100000000000'}}),2000).state,'open-hard');
 const past=fundingState(vm(),8200);assert.equal(past.state,'closed-unresolved');assert.equal(past.headline,'Funding closed. Checking final totals.');assert.equal(past.action,'check-status');
 assert.equal(fundingState(vm({phase:'closed'}),9000).headline,'Funding closed. Checking final totals.');
 const settling=fundingState(vm({phase:'settling',totals:{committedLamports:'143200000000',receiptCount:'412',settledReceiptCount:'118'}}),9000);assert.equal(settling.headline,'Finalizing allocations');assert.equal(settling.sub,'118 of 412 commitments settled.');
 assert.equal(fundingState(vm({phase:'launching'}),9000).headline,'Preparing the launch');
 const live=fundingState(vm({phase:'live'}),9000);assert.equal(live.headline,'Pebble is live');assert.equal(live.action,'trade');
 const refund=fundingState(vm({phase:'refund',totals:{committedLamports:'12000000000'}}),9000);assert.equal(refund.headline,'Refund available');assert.match(refund.sub,/Only 12 of the 50 SOL minimum/);
 assert.match(fundingState(vm({phase:'refund',totals:{committedLamports:'80000000000'}}),9000).sub,/did not complete inside its window/);
 const gone=fundingState(vm({phase:'unavailable'}),9000);assert.equal(gone.headline,'Status temporarily unavailable');assert.equal(gone.action,'retry');
 assert.equal(fundingState(null,0).state,'unavailable');
});

test('meter: committed/hard base, fill clamped at 100, real percentage kept, soft tick at soft/hard, excess separate',()=>{
 const m=meter({committedLamports:'143200000000',softLamports:'50000000000',hardLamports:'100000000000'});
 assert.equal(m.fillPct,100);assert.equal(m.committedPct,143.2);assert.equal(m.softPct,50);assert.equal(m.excessLamports,'43200000000');assert.equal(m.overHard,true);assert.equal(m.reachedHard,true);
 const u=meter({committedLamports:'67000000000',softLamports:'50000000000',hardLamports:'100000000000'});assert.equal(u.fillPct,67);assert.equal(u.excessLamports,'0');assert.equal(u.reachedSoft,true);assert.equal(u.reachedHard,false);
 const z=meter({committedLamports:'0',softLamports:'0',hardLamports:'0'});assert.equal(z.fillPct,0);assert.equal(z.softPct,0);assert.equal(z.reachedSoft,false);
});

test('opening estimate follows plan §3: FDV = A / L, nominal pool = 2A; soft cap gate is explicit',()=>{
 const terms=record().terms;
 const e=openingEstimate({acceptedLamports:'50000000000',terms});
 assert.equal(e.fdvLamports,'103092783505');assert.equal(e.nominalPoolLamports,'100000000000');assert.equal(e.liquidityTokens,'485000000000000');assert.equal(e.requiresSoft,false);assert.equal(e.provisional,true);
 assert.equal(openingEstimate({acceptedLamports:'100000000000',terms}).fdvLamports,'206185567010');
 assert.equal(openingEstimate({acceptedLamports:'10000000000',terms}).requiresSoft,true);
 assert.equal(openingEstimate({acceptedLamports:'0',terms}).fdvLamports,null);
 assert.equal(e.spotSolPerToken,'0.000000103092783505154');
});

test('settlement maths matches plan §5 integer formulas, zero totals without division',()=>{
 assert.deepEqual(settleReceipt({commitLamports:'5000000000',totalCommittedLamports:'143200000000',hardLamports:'100000000000'}),{acceptedLamports:'3491620111',excessLamports:'1508379889'});
 assert.deepEqual(settleReceipt({commitLamports:'5000000000',totalCommittedLamports:'67000000000',hardLamports:'100000000000'}),{acceptedLamports:'5000000000',excessLamports:'0'});
 assert.deepEqual(settleReceipt({commitLamports:'5',totalCommittedLamports:'0',hardLamports:'100'}),{acceptedLamports:'0',excessLamports:'5'});
 assert.equal(participantTokens({acceptedLamports:'3491620111',totalAcceptedLamports:'100000000000',participantReserveBaseUnits:'485000000000000'}),'16934357538350');
 assert.equal(participantTokens({acceptedLamports:'1',totalAcceptedLamports:'0',participantReserveBaseUnits:'5'}),'0');
});

test('estimatePosition counts the new amount in both totals and stays provisional; settledPosition uses chain figures',()=>{
 const terms=record().terms;
 const p=estimatePosition({existingLamports:'2000000000',addLamports:'3000000000',totalCommittedLamports:'140200000000',terms});
 assert.equal(p.campaignTotalLamports,'143200000000');assert.equal(p.commitLamports,'5000000000');assert.equal(p.acceptedLamports,'3491620111');assert.equal(p.excessLamports,'1508379889');assert.equal(p.estimatedAcceptedTotalLamports,'100000000000');assert.equal(p.tokensBaseUnits,'16934357538350');assert.equal(p.provisional,true);
 const under=estimatePosition({addLamports:'1000000000',totalCommittedLamports:'10000000000',terms});assert.equal(under.acceptedLamports,'1000000000');assert.equal(under.excessLamports,'0');assert.equal(under.estimatedAcceptedTotalLamports,'11000000000');
 const s=settledPosition({commitLamports:'5000000000',acceptedLamports:'3491620111',refundedLamports:'0',claimedTokensBaseUnits:'1000000000000',totalAcceptedLamports:'99999999990',terms});
 assert.equal(s.refundRemainingLamports,'1508379889');assert.equal(s.tokensRemainingBaseUnits,String(BigInt(s.tokensBaseUnits)-1000000000000n));assert.equal(s.provisional,false);
});

test('supply strip uses percentages of total supply and reports whether the split sums to 100%',()=>{
 const s=supplySplit(record().terms);assert.deepEqual(s.segments.map(x=>x.percent),['48.5%','48.5%','3%']);assert.equal(s.sumsToWhole,true);assert.equal(s.devLine,'Dev: 1% at launch · 2% linear over 3 calendar months');
 const f=supplySplit({...record().terms,supply:{...SUPPLY,participantsBps:4350,liquidityBps:4350,parentsBps:1000}});assert.deepEqual(f.segments.map(x=>x.key),['participants','liquidity','parents','dev']);
 assert.equal(supplySplit({...record().terms,supply:{...SUPPLY,devBps:200}}).sumsToWhole,false);
});

test('terms rows carry the exact fee label and keep long addresses in detail',()=>{
 const rows=termsRows(vm({devBeneficiary:'DevWallet1111111111111111111111111111111111'}));
 assert.equal(rows.find(r=>r.key==='fee').value,'Trading fee: 2.5% total · network fees extra');
 assert.equal(rows.find(r=>r.key==='dev').value,'DevWa…1111');assert.equal(rows.find(r=>r.key==='dev').detail,'DevWallet1111111111111111111111111111111111');
 assert.match(rows.find(r=>r.key==='collected').detail,/treasury 148\/168 · dev 20\/168/);
 assert.equal(termsRows(vm({terms:{...record().terms,fee:{}}})).find(r=>r.key==='fee').value,'Not published');
});

test('explore rows: bucket, meter or countdown or market, still-open flag, action label',()=>{
 const open=exploreRow(vm({totals:{committedLamports:'143200000000'}}),2000);assert.equal(open.bucket,'open');assert.equal(open.funding.kind,'meter');assert.equal(open.funding.stillOpen,true);assert.equal(open.funding.meter.fillPct,100);assert.equal(open.action,'Commit');
 const up=exploreRow(vm({phase:'scheduled'}),500);assert.equal(up.bucket,'upcoming');assert.equal(up.funding.kind,'countdown');assert.equal(up.funding.seconds,500);assert.equal(up.action,'View');
 const live=exploreRow(vm({phase:'live',market:{fdvLamports:'1',liquidityLamports:'2',volume24hLamports:'3',asOfUnix:1900}}),2000);assert.equal(live.bucket,'live');assert.equal(live.funding.kind,'market');assert.equal(live.funding.market.fdvLamports,'1');assert.equal(live.action,'Trade');
 const ended=exploreRow(vm({phase:'refund',totals:{committedLamports:'12000000000'}}),9000);assert.equal(ended.bucket,'ended');assert.equal(ended.statusLabel,'Refunds');assert.equal(ended.action,'Refund');assert.equal(ended.funding.reachedSoft,false);
 assert.equal(exploreRow(vm({phase:'settling'}),9000).bucket,'launching');
});

test('filter and sort: search on name, ticker or address prefix; deterministic tie-break on id',()=>{
 const a=exploreRow(vm(),2000),b=exploreRow(vm({name:'Zed',symbol:'ZED',identity:{...record().identity,campaign:'FixtureCampaignB1111111111111111111111111111'}}),2000),c=exploreRow(vm({phase:'scheduled',name:'Alpha',symbol:'AL',identity:{...record().identity,campaign:'FixtureCampaignC1111111111111111111111111111'},terms:{...record().terms,deadlineUnix:null}}),2000);
 assert.deepEqual(filterRows([a,b,c],{query:'peb'}).map(r=>r.name),['Pebble']);
 assert.deepEqual(filterRows([a,b,c],{query:'FixtureCampaignB'}).map(r=>r.name),['Zed']);
 assert.deepEqual(filterRows([a,b,c],{status:'upcoming'}).map(r=>r.name),['Alpha']);
 assert.deepEqual(filterRows([a,b,c],{mode:'family'}),[]);
 assert.deepEqual(sortRows([b,a,c],'closing').map(r=>r.name),['Pebble','Zed','Alpha']);
 assert.deepEqual(sortRows([c,b,a],'closing').map(r=>r.name),['Pebble','Zed','Alpha']);
 assert.deepEqual(sortRows([a,b,c],'name').map(r=>r.name),['Alpha','Pebble','Zed']);
 assert.equal(defaultSortFor('open'),'closing');assert.equal(defaultSortFor('live'),'newest');
});

test('claim groups: participant, refund, parents with explicit reasons, unknown eligibility is not "not eligible"',()=>{
 const live=vm({phase:'live',mode:'family',parents:[{mint:'PA',name:'Parent A',verified:true},{mint:'PB',name:'Parent B',verified:true}],totals:{committedLamports:'143200000000',acceptedLamports:'100000000000'}});
 const g=claimGroups(live,{commitLamports:'5000000000',acceptedLamports:'3491620111',refundedLamports:'0',tokensBaseUnits:'16934357538350',claimedTokensBaseUnits:'0',parents:[{mint:'PA',eligibility:'eligible',amountBaseUnits:'1000000'},{mint:'PB',eligibility:'below-threshold'}]});
 assert.deepEqual(g.map(x=>x.key),['allocation','refund','parent:PA','parent:PB']);
 assert.equal(g[0].action,'Claim');assert.equal(g[0].rows[0].amount.compact,'16.9M');
 assert.equal(g[1].rows[0].amount.compact,'1.51');assert.equal(g[1].action,'Claim refund');
 assert.equal(g[2].action,'Claim');assert.equal(g[3].reason,ELIGIBILITY_COPY['below-threshold']);
 const none=claimGroups(live,{commitLamports:'0',parents:[]});assert.equal(none[0].reason,'Not a participant');assert.equal(none[1].reason,'Could not verify eligibility');
 assert.equal(claimGroups(live,{eligibility:'unknown'})[0].reason,'Could not verify eligibility');
 const refund=claimGroups(vm({phase:'refund'}),{commitLamports:'5000000000',acceptedLamports:'0',refundedLamports:'0',tokensBaseUnits:'0'});
 assert.equal(refund.find(x=>x.key==='refund').rows[0].label,'Full refund');assert.equal(refund.find(x=>x.key==='refund').action,'Claim refund');assert.equal(refund[0].reason,'No launch, so no allocation');
 assert.deepEqual(claimGroups(live,null),[]);
});

test('transaction copy table (spec §12)',()=>{
 assert.equal(transactionCopy('wallet').title,'Confirm in your wallet');assert.equal(transactionCopy('wallet').secondary,'Cancel');
 assert.equal(transactionCopy('prepared').busy,false);assert.match(transactionCopy('prepared').note,/No signed transaction has been received/);
 assert.equal(transactionCopy('submitting').title,'Submitting transaction');
 assert.equal(transactionCopy('submitted').secondary,'View on explorer');
 assert.equal(transactionCopy('unknown').title,'Submission status unknown. Checking this transaction.');
 assert.equal(transactionCopy('delayed').primary,'Check status');
 assert.equal(transactionCopy('confirmed',{action:'Commitment'}).title,'Commitment confirmed');
 assert.equal(transactionCopy('rejected').title,'Cancelled in wallet');
 assert.equal(transactionCopy('failed',{reason:'Insufficient SOL for fees'}).title,'Insufficient SOL for fees');assert.match(transactionCopy('failed').note,/Network fees may still apply/);
 assert.equal(transactionCopy('nonsense').title,'');
});

test('setup return is a separate v3 creator entitlement, never participant money',()=>{
 const current=vm({phase:'refund',terms:{...record().terms,version:'3'}});
 const group=setup=>claimGroups(current,{commitLamports:'0',setup}).find(g=>g.key==='setup');
 assert.equal(group({eligibility:'unknown'}).action,null);
 assert.equal(group({eligibility:'verified',terminal:false,availableLamports:'0'}).action,null);
 assert.equal(group({eligibility:'verified',terminal:true,availableLamports:'0'}).reason,'No unused setup SOL');
 const claim=group({eligibility:'verified',terminal:true,availableLamports:'107843280'});assert.equal(claim.action,'Return SOL');assert.match(claim.reason,/Spent rent and fees are not refundable/);
 assert.equal(claimGroups(vm({phase:'refund'}),{setup:{eligibility:'verified',terminal:true,availableLamports:'107843280'}}).some(g=>g.key==='setup'),false);
});

test('shared directory observations retain source time; stale projections remain explicitly unavailable',()=>{
 const row={genesisHash:'g',programId:'p',campaign:'c',mode:'standard',campaignVersion:3};
 const v=campaignViewModel(row,{live:{available:true,phase:'open',source:{slot:20,commitment:'finalized',chainTimeUnix:1000},readAt:new Date(1010000).toISOString()},now:()=>1020000});assert.equal(v.source.fetchedAtUnix,1010);assert.equal(v.source.commitment,'finalized');
 const stale=campaignViewModel(row,{live:{available:false,reason:'Launch data is stale. Refreshing chain status.'}});assert.equal(stale.phase,'unavailable');assert.match(stale.availability.reason,/stale/);assert.equal(stale.totals.committedLamports,null);
});

test('only approved Pinata media paths load; credentials and redirects are rejected',()=>{
 const url='https://gateway.pinata.cloud/ipfs/Qm'+'a'.repeat(44);assert.equal(safeMediaUrl(url),url);assert.equal(safeMediaUrl(url,{kind:'video'}),url);
 for(const bad of [url+'?redirect=https://evil.test',url+'#fragment','https://gateway.pinata.cloud/other','https://user:pass@gateway.pinata.cloud/ipfs/Qm'+'a'.repeat(44),'https://gateway.pinata.cloud.evil.test/ipfs/Qm'+'a'.repeat(44)])assert.equal(safeMediaUrl(bad),null);
 assert.ok(mediaCspDirectives().includes('https://gateway.pinata.cloud'));assert.ok(mediaCspDirectives().split('media-src')[1].includes('pinata'));
});
