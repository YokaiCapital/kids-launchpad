// Budget gates with fixed inputs: an itemised quote with the committer paying receipt rent, margin rounding up, and a
// ledger that binds reserve, spend and return to one campaign and payer with an explicit insufficient outcome.
import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {quoteCampaignCosts,createBudgetLedger,ACCOUNT_BYTES} from './budgets.mjs';
import {rentLamports,ATA_RENT_LAMPORTS} from './signer-policy.mjs';
import {openRegistry} from './registry/registry.mjs';
const addr=n=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const A={genesisHash:addr(1),programId:addr(2),campaign:addr(3)},B={genesisHash:addr(1),programId:addr(2),campaign:addr(4)},PAYER=addr(5),OTHER=addr(6);
test('quote: fixed inputs give fixed lines; receipts are the committer\'s; the margin rounds up',()=>{
 const q=quoteCampaignCosts({live:{ammCreationFeeLamports:150_000_000n,priorityFeeLamports:10_000n,baseFeeLamports:5_000n},counts:{ataCreates:4,transactions:5,lockedPositions:1},marginBps:1000});
 const by=item=>q.lines.find(l=>l.item.startsWith(item));
 assert.equal(by('campaign account').lamports,rentLamports(1024));assert.equal(by('receipt').lamports,0n);assert.equal(by('receipt').payer,'committer');assert.equal(by('receipt').perReceiptLamports,rentLamports(128));
 assert.equal(by('pool creation').lamports,150_000_000n);assert.equal(by('associated').lamports,ATA_RENT_LAMPORTS*4n);assert.equal(by('transaction fees').lamports,75_000n);
 assert.equal(by('lock').lamports,rentLamports(82)+rentLamports(679)+rentLamports(256));
 const expected=rentLamports(1024)+rentLamports(82)+rentLamports(679)+150_000_000n+rentLamports(637)+rentLamports(9016)+rentLamports(82)+rentLamports(82)+rentLamports(679)+rentLamports(256)+ATA_RENT_LAMPORTS*4n+75_000n;
 assert.equal(q.subtotalLamports,expected);assert.equal(q.marginLamports,(expected*1000n+9999n)/10000n);assert.equal(q.totalLamports,expected+q.marginLamports);
 assert.ok(q.lines.every(l=>typeof l.lamports==='bigint'));assert.equal(ACCOUNT_BYTES.receipt,128);
 assert.throws(()=>quoteCampaignCosts({live:{}}),/creation fee/);assert.throws(()=>quoteCampaignCosts({live:{ammCreationFeeLamports:1n},marginBps:20000}),/marginBps/);
 assert.throws(()=>quoteCampaignCosts({live:{ammCreationFeeLamports:-1n}}),/non-negative/);
 assert.throws(()=>quoteCampaignCosts({live:{ammCreationFeeLamports:1n},counts:{transactions:-2}}),/non-negative/);
 assert.throws(()=>quoteCampaignCosts({live:{ammCreationFeeLamports:1n},counts:{ataCreates:1.5}}),/safe integer/);
});
test('ledger: idempotent accounting, bounded spend and no cross-campaign or payer subsidy',async()=>{
 const r=openRegistry();r.migrate();for(const c of [A,B])r.campaigns.upsert({...c,mode:'standard',campaignVersion:2,registryStatus:'planned'});
 try{
 const ledger=createBudgetLedger({registry:r});const base={identity:A,payer:PAYER};
 assert.equal(await ledger.get(base),null);
 const credit={...base,lamports:1000n,operationKey:'verified-credit-1'};
 const first=await ledger.reserve(credit);assert.equal(first.outcome,'reserved');assert.deepEqual(await ledger.reserve(credit),first);
 await assert.rejects(ledger.reserve({...credit,lamports:999n}),{code:'IDEMPOTENCY_CONFLICT'});
 assert.equal((await ledger.reserve({...base,lamports:500n,operationKey:'verified-credit-2'})).budget.reservedLamports,'1500');
 const debit={...base,lamports:1200n,operationKey:'tx-budget-1'};
 const spent=await ledger.spend(debit);assert.equal(spent.outcome,'spent');assert.deepEqual(await ledger.spend(debit),spent);
 const short=await ledger.spend({...base,lamports:400n,operationKey:'too-much'});assert.equal(short.outcome,'insufficient');assert.equal(short.availableLamports,'300');assert.equal(short.shortfallLamports,'100');
 assert.equal((await ledger.spend({identity:B,payer:PAYER,lamports:1n,operationKey:'wrong-campaign'})).outcome,'insufficient');
 assert.equal((await ledger.spend({...base,payer:OTHER,lamports:1n,operationKey:'wrong-payer'})).outcome,'insufficient');
 assert.equal((await ledger.return({...base,lamports:301n,operationKey:'too-large-return'})).outcome,'insufficient');
 const back={...base,lamports:300n,operationKey:'verified-return-1'};
 const returned=await ledger.return(back);assert.equal(returned.outcome,'returned');assert.equal(returned.budget.availableLamports,'0');assert.deepEqual(await ledger.return(back),returned);
 assert.equal((await ledger.reserve({...base,lamports:1n,policy:'platform-subsidy-v1',operationKey:'policy-change'})).outcome,'refused');
 assert.deepEqual(await ledger.get(base),{reservedLamports:'1500',spentLamports:'1200',returnedLamports:'300',availableLamports:'0',policy:'creator-funded-v1'});
 await assert.rejects(ledger.spend({...base,lamports:-1n,operationKey:'negative'}),/negative/);
 await assert.rejects(ledger.spend({...base,lamports:1n}),/operationKey/);
 assert.throws(()=>r.budgets.put({...A,payer:PAYER,reservedLamports:'1',spentLamports:'2',returnedLamports:'0',policy:'creator-funded-v1'}),/exceed/);
 }finally{r.close();}
});
