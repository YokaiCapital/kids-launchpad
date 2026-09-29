import test from 'node:test';import assert from 'node:assert/strict';
import {feeMode,feeSentence,collectedHelp,childBuybackBucket,feeRoutingFacts} from '../src/fee-view.mjs';
import {docsFor,DOCS} from '../src/docs-content.js';
const B5=['burn-child-fees','cpmm-config-allowlist','claim-vaults','revoke-at-creation','jupiter-route'],B6=[...B5.slice(0,4),'parent-claim-expiry','child-buyback'];
const fees={childPending:'0',totalSol:'16800000000',treasuryPaid:'9800000000',devPaid:'2000000000',parentAAllocated:'2500000000',parentBAllocated:'2500000000',parentASpent:'2300000000',parentBSpent:'100000000',parentABurned:'254555896',parentBBurned:'0',childBurned:'670345318218'};
test('fee mode follows the served feature list, never a date',()=>{
 assert.equal(feeMode(B6),'child');assert.equal(feeMode(B5),'parents');assert.equal(feeMode([]),'parents');assert.equal(feeMode(null),'parents');assert.equal(feeMode(undefined),'parents');
});
test('fee sentence and help keep the parent wording on build 5 and say Shartcoin buyback on build 6',()=>{
 assert.match(feeSentence(250,'parents'),/pool fee of 2\.5 %.*buybacks of both parents that are burned/);
 assert.match(feeSentence(250,'child'),/pool fee of 2\.5 %.*a Shartcoin buyback that is burned/);assert.doesNotMatch(feeSentence(250,'child'),/both parents/);
 assert.match(feeSentence(null),/Every trade pays the pool fee\. /);assert.match(collectedHelp('child'),/Shartcoin buyback/);assert.match(collectedHelp('parents'),/both parents/);
});
test('the coin-buyback bucket: SOL spent and coins burned from the served bucket, queued from the chain, earlier parent burns kept',()=>{
 const b=childBuybackBucket({...fees,childBuybackPending:'2600000000',childBuybackSpent:'1500000000',childBoughtAndBurned:'55221884386172'});
 assert.equal(b.spentText,'1.5');assert.equal(b.burned.text,'55.22M');assert.equal(b.burned.exact,'55,221,884.386172 $Shartcoin');assert.equal(b.pendingText,'2.6 SOL queued, not yet bought');
 assert.equal(b.earlierText,'Earlier parent buybacks: 254 Fartcoin burned');
 const unknown=childBuybackBucket({...fees,childBuybackPending:'0',childBuybackSpent:null,childBoughtAndBurned:null});
 assert.equal(unknown.spentText,'—');assert.equal(unknown.burned.text,'—');assert.equal(unknown.pendingText,null,'unknown is never shown as zero');
 assert.equal(childBuybackBucket(null),null);
});
test('token-details rows: parent buybacks on build 5, one Shartcoin buyback and burn row on build 6',()=>{
 assert.deepEqual(feeRoutingFacts(null),[['Fee routing','Not initialized for this pool']]);
 assert.deepEqual(feeRoutingFacts(fees,'parents'),[['Fee routing','9.8 SOL to KIDS · 2 SOL to dev'],['Parent buybacks','2.3 SOL / 0.1 SOL spent']]);
 const [routing,bucket]=feeRoutingFacts({...fees,childBuybackPending:'2600000000',childBuybackSpent:'1500000000',childBoughtAndBurned:'55221884386172'},'child');
 assert.deepEqual(routing,['Fee routing','9.8 SOL to KIDS · 2 SOL to dev']);assert.deepEqual(bucket,['Shartcoin buyback and burn','1.5 SOL spent · 55,221,884 $Shartcoin burned · 2.6 SOL queued, not yet bought']);
 assert.equal(feeRoutingFacts({...fees,childBuybackPending:'0',childBuybackSpent:null,childBoughtAndBurned:null},'child')[1][1],'SOL spent not served · burned amount not served');
});
test('docs follow the live features: build 5 keeps today\'s copy, build 6 says the fee buys and burns Shartcoin and parent claims are closed',()=>{
 assert.equal(docsFor(null),DOCS);assert.equal(docsFor([]),DOCS);assert.equal(docsFor(B5),DOCS);
 const docs=docsFor(B6),text=id=>JSON.stringify(docs.find(d=>d.id===id));
 assert.match(text('fees'),/A share of every trade buys and burns Shartcoin/);assert.match(text('fees'),/98 : 20 : 50/);assert.doesNotMatch(text('fees'),/parent A buyback budget/);
 assert.match(text('parents'),/Parent claims are closed/);assert.match(text('parents'),/What was not claimed is burned/);assert.doesNotMatch(text('parents'),/do not expire/);
 assert.match(text('claims'),/Closed. Unclaimed parent rewards are burned/);assert.match(text('why'),/buys and burns the kid coin itself/);
 assert.doesNotMatch(JSON.stringify(docs),/2026-10-24|24 Oct/,'no date is hard-coded');
 const onlyExpiry=docsFor(['parent-claim-expiry']);assert.match(JSON.stringify(onlyExpiry.find(d=>d.id==='parents')),/Parent claims are closed/);assert.equal(onlyExpiry.find(d=>d.id==='fees'),DOCS.find(d=>d.id==='fees'));
 assert.deepEqual(docs.map(d=>d.id),DOCS.map(d=>d.id),'same topics, same order');
});
