import test from 'node:test';import assert from 'node:assert/strict';
import {remainingRaw,claimedAll,lifecycleLabel,coinDestination,parentState,devSchedule,claimableItems,networkFact,custodyFacts} from '../src/claim-view.mjs';
const EXPIRY=Date.UTC(2026,9,23,5,12)/1000;
test('remaining is total minus claimed, never negative, unknown stays null',()=>{
 assert.equal(remainingRaw('14500000000000','4500000000000'),'10000000000000');
 assert.equal(remainingRaw('5','9'),'0');assert.equal(remainingRaw(null,'0'),null);assert.equal(remainingRaw('x','0'),null);
 assert.equal(claimedAll('5','5'),true);assert.equal(claimedAll('5','0'),false);assert.equal(claimedAll(null,'1'),false);
});
test('lifecycle label follows the served phase; not read yet is not "Prelaunch"',()=>{
 assert.equal(lifecycleLabel('launched'),'Live');assert.equal(lifecycleLabel('failed'),'Not launched');assert.equal(lifecycleLabel('awaiting-launch'),'Launching');
 assert.equal(lifecycleLabel('open'),'Prelaunch');assert.equal(lifecycleLabel(null),'Checking status');assert.equal(lifecycleLabel(undefined),'Checking status');
 assert.equal(coinDestination('launched'),'PostLaunch');assert.equal(coinDestination('open'),'Shart');assert.equal(coinDestination(null),'Shart');
});
test('parent rows: unknown, below threshold, open with deadline, claimed, expired',()=>{
 assert.equal(parentState({eligible:null}).state,'unknown');assert.match(parentState({eligible:null}).note,/not served/);assert.equal(parentState(null).button,'Unavailable');
 const below=parentState({eligible:false,allocationRaw:'0',claimedRaw:'0'});assert.equal(below.state,'ineligible');assert.match(below.note,/0\.05 %/);assert.doesNotMatch(below.note,/held no/);
 const open=parentState({eligible:true,allocationRaw:'2000000000000',claimedRaw:'0'},{parentExpiryUnix:EXPIRY,parentWindowOpen:true,parentExpired:false});
 assert.equal(open.state,'open');assert.equal(open.remainingText,'2,000,000');assert.equal(open.deadlineText,'23 Oct 2026, 05:12 UTC');assert.match(open.note,/claim by 23 Oct 2026, 05:12 UTC/);
 const legacy=parentState({eligible:true,allocationRaw:'10','claimedRaw':'4'});assert.equal(legacy.state,'open');assert.equal(legacy.deadlineText,'');assert.doesNotMatch(legacy.note,/claim by/);
 assert.equal(parentState({eligible:true,allocationRaw:'10',claimedRaw:'10'}).state,'claimed');
 const expired=parentState({eligible:true,allocationRaw:'10',claimedRaw:'0',expired:true,windowOpen:false,expiresAtUnix:EXPIRY});assert.equal(expired.state,'expired');assert.match(expired.note,/burned/);assert.equal(expired.button,'Closed');
 assert.equal(parentState({eligible:true,allocationRaw:'10',claimedRaw:'0'},{parentExpiryUnix:EXPIRY,parentWindowOpen:false,parentExpired:true}).state,'expired');
});
test('dev schedule: public counters from the distribution account, otherwise dev-only',()=>{
 const dist={allocationRaw:['1','2','3','30'],claimedRaw:['0','0','0','12'],remainingRaw:['1','2','3','18'],devStartUnix:100,devEndUnix:200};
 const pub=devSchedule({owner:'W',dev:{isDev:false,totalRaw:'30',claimableRaw:'0',claimedRaw:'0',endUnix:250}},{distribution:dist,launchedAt:90});
 assert.deepEqual([pub.startUnix,pub.endUnix,pub.totalRaw,pub.claimedRaw,pub.remainingRaw,pub.claimableRaw,pub.publicCounters,pub.beneficiary],[100,200,'30','12','18',null,true,null]);
 const legacyOther=devSchedule({owner:'W',dev:{isDev:false,totalRaw:'30',claimableRaw:'0',claimedRaw:'0',endUnix:250}},{launchedAt:90});
 assert.equal(legacyOther.claimedRaw,null);assert.equal(legacyOther.remainingRaw,null);assert.equal(legacyOther.endUnix,250);
 const legacyDev=devSchedule({owner:'DEV',dev:{isDev:true,totalRaw:'30',claimableRaw:'5',claimedRaw:'12',endUnix:250}},{launchedAt:90});
 assert.deepEqual([legacyDev.claimedRaw,legacyDev.remainingRaw,legacyDev.claimableRaw,legacyDev.beneficiary],['12','18','5','DEV']);
 assert.equal(devSchedule(null,null).totalRaw,null);
});
test('claimable items list only what is left and open',()=>{
 const claims={participant:{allocatedRaw:'14500000000000',claimedRaw:'4500000000000'},refund:{claimableLamports:'500000000',refundedLamports:'0'},parents:[{name:'Fartcoin',eligible:true,allocationRaw:'2000000000000',claimedRaw:'0'},{name:'Buttcoin',eligible:false,allocationRaw:'0',claimedRaw:'0'}],dev:{isDev:false,claimableRaw:'0'},vault:{parentExpiryUnix:EXPIRY,parentWindowOpen:true,parentExpired:false}};
 assert.deepEqual(claimableItems(claims).map(i=>i.text),['10,000,000 $Shartcoin','0.5 SOL refund','2,000,000 from Fartcoin']);
 assert.deepEqual(claimableItems({...claims,participant:{allocatedRaw:'5',claimedRaw:'5'},refund:{claimableLamports:'0'},parents:[],dev:{isDev:true,claimableRaw:'7000000'}}).map(i=>i.key),['dev']);
 assert.deepEqual(claimableItems(null),[]);
});
test('network and custody rows are facts, not reassurances',()=>{
 assert.equal(networkFact('localnet'),'Localnet · private test ledger');assert.equal(networkFact('mainnet'),'Solana mainnet');assert.equal(networkFact('mainnet',true),'Solana mainnet · rehearsal pool');assert.equal(networkFact(undefined),'Not served');
 const facts=Object.fromEntries(custodyFacts({mintAuthorityRevoked:true,freezeAuthorityRevoked:false,liquidityLocked:null,liquidityLockQualified:true}));
 assert.equal(facts['Mint authority'],'Revoked');assert.equal(facts['Freeze authority'],'Still active');assert.match(facts.Liquidity,/verified at launch/);assert.equal(facts['Program upgrades'],'Not served');
 assert.equal(Object.fromEntries(custodyFacts({upgradeAuthority:null}))['Program upgrades'],'Upgrade authority removed');
 assert.match(Object.fromEntries(custodyFacts({upgradeAuthority:'3mejq3CpgFWnrc1UGfh1iYz6R1SfF4LdnPpbxnNGxErw'}))['Program upgrades'],/Upgradeable by 3mejq…GxErw/);
 assert.equal(Object.fromEntries(custodyFacts(null))['Mint authority'],'Not served');
});
