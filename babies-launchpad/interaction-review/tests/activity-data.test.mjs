import test from 'node:test';import assert from 'node:assert/strict';
import {ACTIVITY_STEP,ACTIVITY_VISIBLE,ALL_KINDS,FILTERS,activityChip,applyFilter,countsLine,deriveActivityState,describeAssets,fetchActivity,filterCount,formatAssetAmount,hiddenMaintenance,isMaintenance,kindsParam,labelFor,mergeEvents,normaliseEvent,symbolFor,tagsFor} from '../src/activity-data.mjs';

const COIN='M1ntAddr1111111111111111111111111111111111111',FART='FartMint111111111111111111111111111111111111',BUTT='ButtMint111111111111111111111111111111111111';
const names={coin:COIN,parentMints:[FART,BUTT],parents:['Fartcoin','Buttcoin']};
const ev=(over={})=>({signature:'Sig'+'1'.repeat(70),path:'0',slot:100,time:1000,program:'launch',kind:'commit',actor:'Actor111111111111111111111111111111111111111',assets:[],status:'finalized',nested:false,detail:null,...over});

test('every served kind gets a plain-word label; unknown kinds keep their raw name instead of vanishing',()=>{
 for(const kind of ALL_KINDS){const label=labelFor(ev({kind}),names);assert.ok(label&&label!==kind,kind+' → '+label);}
 assert.equal(labelFor(ev({kind:'commit'})),'Commitment');
 assert.equal(labelFor(ev({kind:'refund'})),'Refund');
 assert.equal(labelFor(ev({kind:'settle'})),'Settled');
 assert.equal(labelFor(ev({kind:'launch'})),'Launched: pool funded and LP locked');
 assert.equal(labelFor(ev({kind:'fees-collect'})),'Fee harvest');
 assert.equal(labelFor(ev({kind:'fees-distribute'})),'Fees distributed: treasury / dev');
 assert.equal(labelFor(ev({kind:'buy-burn',detail:'parent-0'}),names),'Buyback and burn: Fartcoin');
 assert.equal(labelFor(ev({kind:'buy-burn-routed',detail:'parent-1'}),names),'Buyback and burn: Buttcoin');
 assert.equal(labelFor(ev({kind:'buy-burn',detail:null}),names),'Buyback and burn');
 assert.equal(labelFor(ev({kind:'burn-child'})),'Coin-side fees burned');
 assert.equal(labelFor(ev({kind:'claim-participant'})),'Claim: participant');
 assert.equal(labelFor(ev({kind:'claim-parent',detail:'parent-1'}),names),'Claim: Buttcoin holder');
 assert.equal(labelFor(ev({kind:'vault-claim-parent',detail:'parent-0'}),names),'Claim: Fartcoin holder');
 assert.equal(labelFor(ev({kind:'vault-burn-expired',detail:'parent-0'}),names),'Expired Fartcoin claims burned');
 assert.equal(labelFor(ev({kind:'authority-revoked',detail:'mintTokens'})),'Mint authority revoked');
 assert.equal(labelFor(ev({kind:'authority-revoked',detail:'freezeAccount'})),'Freeze authority revoked');
 assert.equal(labelFor(ev({kind:'something-new'})),'Something new');
});
test('vault kinds fold under the same labels with a vault tag; status tags only when not final',()=>{
 assert.deepEqual(tagsFor(ev({kind:'vault-claim-dev'})).map(t=>t.text),['vault']);
 assert.equal(labelFor(ev({kind:'vault-claim-dev'})),labelFor(ev({kind:'claim-dev'})));
 assert.deepEqual(tagsFor(ev({kind:'buy-burn-routed',nested:true,status:'confirmed'})).map(t=>t.text),['routed','nested','confirming']);
 assert.deepEqual(tagsFor(ev({kind:'claim-participant',status:'failed'})).map(t=>t.text),['failed']);
 assert.deepEqual(tagsFor(ev({kind:'commit'})),[]);
});
test('asset amounts use adaptive precision, never round a real amount to zero and never invent one',()=>{
 assert.deepEqual(formatAssetAmount('1500000000',9,'SOL'),{text:'1.5 SOL',exact:'1.5 SOL'});
 assert.deepEqual(formatAssetAmount('123456789',9,'SOL'),{text:'0.1234 SOL',exact:'0.123456789 SOL'});
 assert.deepEqual(formatAssetAmount('50000',9,'SOL'),{text:'<0.0001 SOL',exact:'0.00005 SOL'});
 assert.deepEqual(formatAssetAmount('0',9,'SOL'),{text:'0 SOL',exact:'0 SOL'});
 assert.deepEqual(formatAssetAmount('12400123456',6,'Fartcoin'),{text:'12,400.12 Fartcoin',exact:'12,400.123456 Fartcoin'});
 assert.deepEqual(formatAssetAmount('434999123456789',6,'$Shartcoin'),{text:'435M $Shartcoin',exact:'434,999,123.456789 $Shartcoin'});
 assert.deepEqual(formatAssetAmount('123',6,'Buttcoin'),{text:'0.000123 Buttcoin',exact:'0.000123 Buttcoin'});
 assert.deepEqual(formatAssetAmount(null,6,'x'),{text:'—',exact:null});assert.deepEqual(formatAssetAmount('abc',6,'x'),{text:'—',exact:null});
 assert.equal(symbolFor('SOL',names),'SOL');assert.equal(symbolFor(COIN,names),'$Shartcoin');assert.equal(symbolFor(BUTT,names),'Buttcoin');assert.equal(symbolFor('Unknown11111111111111111111111111111111111',names),'Unkn…1111');
});
test('movements are worded from custody: in, to a role, out, and burns are "burned", never sent',()=>{
 const launch=ev({kind:'launch',assets:[{mint:'SOL',amountRaw:'500000000000',decimals:9,direction:'out',role:'pool'},{mint:COIN,amountRaw:'435000000000000',decimals:6,direction:'out',role:'pool'},{mint:'LpMint111111111111111111111111111111111111',amountRaw:'1000000',decimals:6,direction:'out',role:'lock'}]});
 assert.deepEqual(describeAssets(launch,names).map(a=>a.text),['500 SOL to the pool','435M $Shartcoin to the pool','1 LpMi…1111 to the LP lock']);
 const burn=ev({kind:'buy-burn',detail:'parent-0',assets:[{mint:'SOL',amountRaw:'420000000',decimals:9,direction:'out',role:null},{mint:'OtherParentMint1111111111111111111111111111',amountRaw:'12400000000',decimals:6,direction:'burn',role:null}]});
 const lines=describeAssets(burn,names);
 assert.deepEqual(lines.map(a=>[a.text,a.tone]),[['0.42 SOL out','out'],['12,400 Fartcoin burned','burn']]);
 assert.ok(!lines.some(a=>/sent/.test(a.text)));
 const dist=ev({kind:'fees-distribute',assets:[{mint:'SOL',amountRaw:'200000000',decimals:9,direction:'out',role:'treasury'},{mint:'SOL',amountRaw:'40000000',decimals:9,direction:'out',role:'dev'}]});
 assert.deepEqual(describeAssets(dist,names).map(a=>a.text),['0.2 SOL to KIDS treasury','0.04 SOL to dev']);
 assert.deepEqual(describeAssets(ev({kind:'commit',assets:[{mint:'SOL',amountRaw:'1000000000',decimals:9,direction:'in'}]})).map(a=>a.text),['1 SOL in']);
 assert.deepEqual(describeAssets(ev({kind:'burn-child',assets:[{mint:COIN,amountRaw:'763999619760',decimals:6,direction:'burn'}]}),names).map(a=>a.exact),['763,999.61976 $Shartcoin burned']);
});
test('served events are validated, accept both field spellings, and merge newest first one per instruction',()=>{
 assert.equal(normaliseEvent({signature:'x'}),null);
 assert.equal(normaliseEvent({signature:'S',kind:'commit',assets:[{mint:'SOL',amountRaw:'x',decimals:9,direction:'in'}]}),null);
 const legacy=normaliseEvent({signature:'S1',instructionPath:'2.1',slot:'10',blockTimeUnix:'900',kind:'init',status:'confirmed',assets:[{mint:'SOL',amountRaw:'5',direction:'in'}]});
 assert.equal(legacy.kind,'campaign-init');assert.equal(legacy.path,'2.1');assert.equal(legacy.slot,10);assert.equal(legacy.time,900);assert.equal(legacy.assets[0].decimals,9);assert.equal(legacy.status,'confirmed');
 const first=mergeEvents([],[ev({signature:'A',slot:10,path:'0',status:'confirmed'}),ev({signature:'B',slot:12,path:'1'}),ev({signature:'B',slot:12,path:'1.0',nested:true})]);
 assert.deepEqual(first.map(e=>[e.signature,e.path]),[['B','1.0'],['B','1'],['A','0']]);
 const again=mergeEvents(first,[ev({signature:'A',slot:10,path:'0',status:'finalized'}),ev({signature:'C',slot:9,path:'0',time:null})]);
 assert.deepEqual(again.map(e=>[e.signature,e.path,e.status]),[['B','1.0','finalized'],['B','1','finalized'],['A','0','finalized'],['C','0','finalized']]);
 assert.equal(again.length,4);
});
test('chips map to server kinds; the Failed chip is picked out client-side and counts come from the served totals',()=>{
 assert.equal(FILTERS.length,9);assert.equal(kindsParam('all'),null);assert.equal(kindsParam('failed'),null);
 assert.equal(kindsParam('burns'),'buy-burn,buy-burn-routed,burn-child,vault-burn-expired,vault-sweep');
 assert.ok(kindsParam('claims').includes('vault-claim-parent'));assert.ok(kindsParam('vaults').includes('vault-claim-parent'));
 const rows=[ev({kind:'commit'}),ev({signature:'F',kind:'claim-participant',status:'failed'}),ev({signature:'V',kind:'vault-activate'})];
 assert.deepEqual(applyFilter(rows,'failed').map(e=>e.signature),['F']);
 assert.deepEqual(applyFilter(rows,'vaults').map(e=>e.signature),['V']);
 assert.equal(applyFilter(rows,'all').length,3);
 const counts={total:41,failed:2,byKind:{commit:12,'buy-burn':5,'burn-child':3,'vault-activate':1}};
 assert.equal(filterCount(counts,'all'),41);assert.equal(filterCount(counts,'failed'),2);assert.equal(filterCount(counts,'burns'),8);assert.equal(filterCount(counts,'vaults'),1);assert.equal(filterCount(null,'all'),null);
 assert.equal(countsLine(counts),'41 events · 2 failed');assert.equal(countsLine({total:1,failed:0}),'1 event');assert.equal(countsLine(null),'');
});
test('list state and chip come from the last read, keeping the last valid page through failures',()=>{
 assert.equal(deriveActivityState({events:[],result:null,loading:true}),'loading');
 assert.equal(deriveActivityState({events:[],result:{ok:false,reason:'off'},loading:false}),'off');
 assert.equal(deriveActivityState({events:[],result:{ok:false,reason:'unavailable',status:503},loading:false}),'unavailable');
 assert.equal(deriveActivityState({events:[ev()],result:{ok:false,reason:'unavailable',status:503},loading:false}),'ready');
 assert.equal(deriveActivityState({events:[],result:{ok:true,data:{}},loading:false}),'empty');
 assert.equal(deriveActivityState({events:[ev()],result:null,loading:true,enabled:false}),'off');
 const now=2000;
 assert.deepEqual(activityChip({status:'live',result:{ok:true},lastReadUnix:1990,nowUnix:now}),{text:'Updated 10 s ago',tone:'live'});
 assert.deepEqual(activityChip({status:'stale',result:{ok:true},lastReadUnix:1990,nowUnix:now}),{text:'Stale · feed behind the chain',tone:'stale'});
 assert.deepEqual(activityChip({status:'backfilling',result:{ok:true},lastReadUnix:1990,nowUnix:now}),{text:'Backfilling history',tone:'wait'});
 assert.deepEqual(activityChip({status:'live',result:{ok:false,reason:'unavailable'},lastReadUnix:1700,nowUnix:now}),{text:'Feed unavailable · last read 5 min ago',tone:'off'});
 assert.deepEqual(activityChip({status:null,result:{ok:false,reason:'off'},lastReadUnix:null,nowUnix:now}),{text:'Feed not connected',tone:'off'});
 assert.deepEqual(activityChip({status:null,result:null,lastReadUnix:null,nowUnix:now}),{text:'Loading…',tone:'wait'});
});
test('fetchActivity sends the cursor and kinds and refuses an answer without an events array',async()=>{
 const calls=[];const fetchImpl=async(url)=>{calls.push(url);return {ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>url.includes('cursor=c2')?{events:[],nextCursor:null}:{nope:true}};};
 const bad=await fetchActivity({campaign:'C',kinds:'commit,refund'},{fetchImpl});
 assert.deepEqual(bad,{ok:false,reason:'malformed',status:200});
 assert.equal(calls[0],'/api/market/activity?campaign=C&limit=30&kinds=commit%2Crefund');
 const good=await fetchActivity({campaign:'C',cursor:'c2',limit:10},{fetchImpl});
 assert.equal(good.ok,true);assert.equal(calls[1],'/api/market/activity?campaign=C&cursor=c2&limit=10');
 const down=await fetchActivity({campaign:'C'},{fetchImpl:async()=>({ok:false,status:503,headers:{get:()=>'application/json'},json:async()=>({error:'x'})})});
 assert.deepEqual(down,{ok:false,reason:'unavailable',status:503});
});
test('an empty finalised fee harvest is maintenance: out of the default feed, under its own chip, signature kept',()=>{
 const empty=ev({signature:'E1',kind:'fees-collect'}),moved=ev({signature:'M1',kind:'fees-collect',assets:[{mint:'SOL',amountRaw:'5',decimals:9,direction:'in',role:null}]});
 const failed=ev({signature:'F1',kind:'fees-collect',status:'failed'}),confirming=ev({signature:'C1',kind:'fees-collect',status:'confirmed'}),commit=ev({signature:'K1',kind:'commit'});
 assert.equal(isMaintenance(empty),true);assert.equal(isMaintenance(moved),false);assert.equal(isMaintenance(failed),false);assert.equal(isMaintenance(confirming),false);assert.equal(isMaintenance(commit),false);
 const rows=[empty,moved,failed,confirming,commit];
 assert.deepEqual(applyFilter(rows,'all').map(e=>e.signature),['M1','F1','C1','K1']);// confirming and failed harvests stay visible
 assert.deepEqual(applyFilter(rows,'fees').map(e=>e.signature),['M1','F1','C1']);
 assert.deepEqual(applyFilter(rows,'maintenance').map(e=>e.signature),['E1']);
 assert.deepEqual(applyFilter(rows,'failed').map(e=>e.signature),['F1']);
 assert.equal(hiddenMaintenance(rows,'all'),1);assert.equal(hiddenMaintenance(rows,'fees'),1);assert.equal(hiddenMaintenance(rows,'launch'),0);assert.equal(hiddenMaintenance(rows,'maintenance'),0);
 assert.equal(kindsParam('maintenance'),'fees-collect');assert.equal(filterCount({total:9,failed:1,byKind:{'fees-collect':4}},'maintenance'),null);
 assert.equal(ACTIVITY_VISIBLE,5);assert.ok(ACTIVITY_STEP>=ACTIVITY_VISIBLE);
});
