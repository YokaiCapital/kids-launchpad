// The funding-first handlers against an in-memory model of a version-2 record (the program's rules for tags 42 and 44-47 as
// funding_first.rs states them): table planned and built during funding, launch after the deadline with the display checked
// against the opening commitment and the custody co-signer passed through, close, refunds (failed round and excess),
// exact-once accounting, the collateral return, unknown outcomes reconciled, and the versioned dispatch.
import test from 'node:test';import assert from 'node:assert/strict';
import {launchTable,launchFundingFirst,closeFundingFirst,refundsFundingFirst,accountFundingFirst,collateralReturnFundingFirst,versioned} from './handlers-funding-first.mjs';
import {accepted,refundable,launchFailed,PHASE_FUNDING,PHASE_CLOSED,PHASE_LIVE,PHASE_REFUND_ONLY} from '../protocol-v2/policy.mjs';
import {displayHash,COLLATERAL_LAMPORTS_V2} from '../protocol-v3/client.mjs';
const id={genesisHash:'G'.repeat(32),programId:'P'.repeat(32),campaign:'C'.repeat(32)};
const display={name:'Funding First',symbol:'FF',uri:'https://gateway.pinata.cloud/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'};
/** A version-2 record and its extension as the program keeps them; sends confirm unless a knob says failed or unknown. */
function world({commitments=[20_000_000n],soft=6_553_500n,hard=10_000_000_000n,deadline=1000n,launchDeadline=1600n,clock=900n,accountingVersion=2}={}){
 const s={phase:PHASE_FUNDING,soft,hard,deadline,launchDeadline,clock,refunded:0n,launched:null,plan:null,sends:[],next:null,
  receipts:commitments.map((c,i)=>({address:'R'+String(i).padStart(3,'0'),owner:'O'+i,committed:c,refunded:0n,accounted:false,settled:false,accepted:0n})),
  ext:{sealed:false,sealedReceipts:0,sealedTotal:'0',acceptedTarget:'0',accountedCount:0,accountedAccepted:'0',collateralReturned:'0',displayHash:displayHash(display),feeNft:'N'.repeat(32),mint:'M'.repeat(32)}};
 const total=()=>s.receipts.reduce((a,r)=>a+r.committed,0n);
 const seal=()=>{if(!s.ext.sealed){const t=total();s.ext={...s.ext,sealed:true,sealedReceipts:s.receipts.length,sealedTotal:String(t),acceptedTarget:String(t<hard?t:hard)};}};
 const outcome=label=>{const k=s.next;s.next=null;s.sends.push(label);if(k==='failed')return {status:'failed',error:'custom program error: 0x6c'};if(k==='unknown')return {status:'unknown',signature:'sig-'+label,blockhash:'b',lastValidBlockHeight:9};return null;};
 const chain={
  async readCampaign(){return {accountingVersion,phase:s.phase,total:total(),soft,hard,deadline,launchDeadline,refunded:s.refunded,receiptCount:BigInt(s.receipts.length),settledCount:0n,settledAccepted:0n,pool:'POOL',feeNft:s.ext.feeNft,launchTime:s.launched?123n:0n,slot:7,terms:{metadataUri:display.uri,creator:'CREATOR'}};},
  async chainTime(){return s.clock;},
  async listReceipts(){return {receipts:s.receipts.map(r=>({...r})),complete:true,slot:7};},
  async readExtension(){return {...s.ext,slot:7};},
  async launchTable(_id,{plan}){const o=outcome('table');if(o)return o;return {status:'confirmed',table:plan.table,steps:2,signature:'table-sig'};},
  async launchFundingFirst(_id,{table,display:d,coSign}){const o=outcome('launch');if(o)return o;if(s.launched)return {status:'confirmed',signature:'launch-sig',feeNft:s.ext.feeNft,replayed:true};assert.equal(typeof coSign,'function');assert.equal(table,s.plan?.table);assert.deepEqual(d,display);if(s.clock<deadline||s.clock>=launchDeadline||total()<soft||![PHASE_FUNDING,PHASE_CLOSED].includes(s.phase))return {status:'failed',error:'not ready'};seal();s.phase=PHASE_LIVE;s.launched={table};return {status:'confirmed',signature:'launch-sig',feeNft:s.ext.feeNft};},
  async closeV2(){const o=outcome('close');if(o)return o;if(s.clock<deadline)return {status:'failed',error:'before deadline'};if(s.phase===PHASE_LIVE)return {status:'confirmed',signature:'close-noop'};if(launchFailed(s.phase,total(),soft,launchDeadline,s.clock))s.phase=PHASE_REFUND_ONLY;else{seal();s.phase=PHASE_CLOSED;}return {status:'confirmed',signature:'close-sig'};},
  async refundV2(_id,receipt){const o=outcome('refund:'+receipt.address);if(o)return o;const r=s.receipts.find(x=>x.address===receipt.address);const failed=launchFailed(s.phase,total(),soft,launchDeadline,s.clock);if(failed)s.phase=PHASE_REFUND_ONLY;else if(s.phase===PHASE_FUNDING){seal();s.phase=PHASE_CLOSED;}const entitled=refundable(r.committed,total(),hard,failed),amount=entitled-r.refunded;r.refunded=entitled;s.refunded+=amount;return {status:'confirmed',signature:'refund-'+r.address};},
  async accountV2(_id,receipt){const o=outcome('account:'+receipt.address);if(o)return o;const r=s.receipts.find(x=>x.address===receipt.address);if(!s.ext.sealed||![PHASE_CLOSED,PHASE_LIVE].includes(s.phase)||r.accounted)return {status:'failed',error:'custom program error: 0x6c'};const acceptedAmount=accepted(r.committed,BigInt(s.ext.sealedTotal),hard);s.ext={...s.ext,accountedCount:s.ext.accountedCount+1,accountedAccepted:String(BigInt(s.ext.accountedAccepted)+acceptedAmount)};r.accounted=true;return {status:'confirmed',signature:'account-'+r.address};},
  async returnCollateralV2(){const o=outcome('collateral');if(o)return o;if(BigInt(s.ext.collateralReturned)!==0n)return {status:'failed',error:'already returned'};let amount;if(s.phase===PHASE_REFUND_ONLY)amount=BigInt(COLLATERAL_LAMPORTS_V2);else if(s.phase===PHASE_LIVE&&s.ext.sealed&&s.ext.accountedCount===s.ext.sealedReceipts)amount=BigInt(COLLATERAL_LAMPORTS_V2)-(BigInt(s.ext.acceptedTarget)-BigInt(s.ext.accountedAccepted));else return {status:'failed',error:'not terminal'};s.ext={...s.ext,collateralReturned:String(amount)};return {status:'confirmed',signature:'collateral-sig'};},
  async verifyLaunch(){return {ok:true,checks:{liability:0n}};},
  async signatureStatus(signature){return {status:s.resolve??'confirmed',signature};},
 };
 const plans={read:async()=>s.plan?{...s.plan}:null,allocate:async()=>{s.plan={table:'TABLE',recentSlot:5,status:'planned'};return {...s.plan};},markComplete:async(_id,plan)=>{assert.equal(plan.table,s.plan.table);s.plan.status='complete';}};
 const enqueued=[];const ctx=(extra={})=>({campaign:id,now:()=>Date.now(),signal:null,holds:async()=>true,token:1,fenced:async(_l,fn)=>fn(),enqueue:async i=>{enqueued.push(i);},...extra});
 const job=(operationKey,jobClass='launch')=>({operationKey,jobClass,payload:{},genesisHash:id.genesisHash,programId:id.programId,campaign:id.campaign});
 return {s,chain,plans,ctx,job,enqueued,total,coSign:async tx=>tx,displayFor:async()=>display};
}
test('launch: a creator-flow campaign launches only when both metadata pins are confirmed; a sealed or attention receipt waits (uncounted), a verified URI that differs from the sealed terms never launches, an untracked campaign is unaffected',async()=>{
 const w=world();w.s.clock=1000n;await launchTable({chain:w.chain,plans:w.plans}).run(w.job('launch-table'),w.ctx());
 let pins={tracked:true,ready:false,image:'published',document:'sealed',uri:display.uri,attention:false,pending:['document']};
 const h=launchFundingFirst({chain:w.chain,plans:w.plans,coSign:w.coSign,displayFor:w.displayFor,publication:async()=>pins,publicationDelayMs:700});
 const waiting=await h.run(w.job('launch'),w.ctx());assert.equal(waiting.outcome,'yield');assert.equal(waiting.category,'publication-pending');assert.equal(waiting.delayMs,700);assert.deepEqual(waiting.publication,{image:'published',document:'sealed'});assert.equal(w.s.launched,null,'nothing was sent');
 pins={...pins,document:'attention',attention:true};const attention=await h.run(w.job('launch'),w.ctx());assert.equal(attention.outcome,'yield');assert.equal(attention.category,'publication-attention');assert.match(attention.reason,/operator/);assert.equal(w.s.launched,null);
 pins={tracked:true,ready:true,image:'published',document:'published',uri:'https://gateway.pinata.cloud/ipfs/Qm'+'z'.repeat(44),attention:false,pending:[]};
 const other=await h.run(w.job('launch'),w.ctx());assert.equal(other.outcome,'failed-permanent');assert.equal(other.category,'publication-mismatch');assert.equal(w.s.launched,null);
 pins={...pins,uri:display.uri};const launched=await h.run(w.job('launch'),w.ctx());assert.equal(launched.outcome,'done',JSON.stringify(launched));assert.equal(w.s.phase,PHASE_LIVE);
 const u=world();u.s.clock=1000n;await launchTable({chain:u.chain,plans:u.plans}).run(u.job('launch-table'),u.ctx());
 assert.equal((await launchFundingFirst({chain:u.chain,plans:u.plans,coSign:u.coSign,displayFor:u.displayFor,publication:async()=>({tracked:false,ready:true,image:null,document:null,uri:null,attention:false,pending:[]})}).run(u.job('launch'),u.ctx())).outcome,'done','no creator-flow record: nothing to wait for');
 assert.throws(()=>launchFundingFirst({chain:w.chain,plans:w.plans,coSign:w.coSign,displayFor:w.displayFor,publication:{}}),/publication readiness/);
});
test('launch-table: allocates the plan during funding, builds through the adapter, marks complete; a complete plan or a live campaign is done without sending; a replaced plan retries; an unknown packet is reconciled',async()=>{
 const w=world(),h=launchTable({chain:w.chain,plans:w.plans});
 const first=await h.run(w.job('launch-table'),w.ctx());assert.equal(first.outcome,'done');assert.equal(first.table,'TABLE');assert.equal(w.s.plan.status,'complete');assert.deepEqual(w.s.sends,['table']);
 const again=await h.run(w.job('launch-table'),w.ctx());assert.equal(again.outcome,'done');assert.equal(again.alreadyComplete,true);assert.equal(w.s.sends.length,1,'a complete plan sends nothing');
 const u=world();u.s.next='unknown';const hu=launchTable({chain:u.chain,plans:u.plans});
 const unknown=await hu.run(u.job('launch-table'),u.ctx());assert.equal(unknown.outcome,'unknown');assert.equal(unknown.reconcile.kind,'launch-table');assert.equal(unknown.reconcile.signature,'sig-table');
 assert.equal((await hu.reconcile({result:{reconcile:unknown.reconcile}},u.ctx())).status,'confirmed');
 assert.equal((await hu.run(u.job('launch-table'),u.ctx({reconciled:{status:'confirmed',signature:'sig-table'}}))).outcome,'done','resumes from the journaled packets');
 const r=world();r.chain.launchTable=async()=>{throw Object.assign(Error('lookup table plan replaced; allocate again'),{code:'LOOKUP_TABLE_PLAN_REPLACED'});};
 const replaced=await launchTable({chain:r.chain,plans:r.plans}).run(r.job('launch-table'),r.ctx());assert.equal(replaced.outcome,'retry');assert.equal(replaced.category,'plan-replaced');
 const live=world();live.s.phase=PHASE_LIVE;assert.equal((await launchTable({chain:live.chain,plans:live.plans}).run(live.job('launch-table'),live.ctx())).category,'already-live');
 const failed=world({commitments:[1_000_000n]});failed.s.clock=1000n;assert.equal((await launchTable({chain:failed.chain,plans:failed.plans}).run(failed.job('launch-table'),failed.ctx())).outcome,'failed-permanent');
 // A fresh round with nothing committed yet is the normal start of funding, never a failed round: the table is built.
 const fresh=world({commitments:[]});const built=await launchTable({chain:fresh.chain,plans:fresh.plans}).run(fresh.job('launch-table'),fresh.ctx());assert.equal(built.outcome,'done',JSON.stringify(built));assert.equal(fresh.s.plan.status,'complete');
 const underfundedOpen=world({commitments:[1_000_000n]});assert.equal((await launchTable({chain:underfundedOpen.chain,plans:underfundedOpen.plans}).run(underfundedOpen.job('launch-table'),underfundedOpen.ctx())).outcome,'done','under the soft cap while funding is open is not a failure');
 const v0=world({accountingVersion:0});assert.equal((await launchTable({chain:v0.chain,plans:v0.plans}).run(v0.job('launch-table'),v0.ctx())).category,'not-funding-first');
 assert.throws(()=>launchTable({chain:w.chain,plans:{}}),/table plans/);
});
test('launch: waits for the chain deadline, refuses a failed round, needs the complete table (enqueuing it), checks the display against the opening commitment, launches with the custody co-signer, verifies, and never launches twice',async()=>{
 const w=world(),h=launchFundingFirst({chain:w.chain,plans:w.plans,coSign:w.coSign,displayFor:w.displayFor});
 const open=await h.run(w.job('launch'),w.ctx());assert.equal(open.outcome,'yield');assert.equal(open.category,'funding-open');assert.equal(open.delayMs,60000);
 w.s.clock=1000n;
 const noTable=await h.run(w.job('launch'),w.ctx());assert.equal(noTable.outcome,'yield','waiting for the table never spends the retry budget');assert.equal(noTable.category,'table-not-ready');assert.deepEqual(w.enqueued.map(e=>e.operationKey),['launch-table']);
 await launchTable({chain:w.chain,plans:w.plans}).run(w.job('launch-table'),w.ctx());
 const wrong=launchFundingFirst({chain:w.chain,plans:w.plans,coSign:w.coSign,displayFor:async()=>({...display,name:'Other'})});
 const mismatch=await wrong.run(w.job('launch'),w.ctx());assert.equal(mismatch.outcome,'failed-permanent');assert.equal(mismatch.category,'display-mismatch');assert.equal(w.s.launched,null,'nothing was sent');
 const launched=await h.run(w.job('launch'),w.ctx());assert.equal(launched.outcome,'done');assert.equal(launched.signature,'launch-sig');assert.equal(launched.verified,true);assert.equal(w.s.phase,PHASE_LIVE);assert.equal(w.s.ext.sealed,true);
 const twice=await h.run(w.job('launch'),w.ctx());assert.equal(twice.outcome,'done');assert.equal(w.s.sends.filter(x=>x==='launch').length,1,'a live campaign is verified, never launched again');
 const late=world();late.s.clock=1600n;assert.equal((await launchFundingFirst({chain:late.chain,plans:late.plans,coSign:late.coSign,displayFor:late.displayFor}).run(late.job('launch'),late.ctx())).category,'campaign-failed');
 const under=world({commitments:[6_553_499n]});under.s.clock=1000n;assert.equal((await launchFundingFirst({chain:under.chain,plans:under.plans,coSign:under.coSign,displayFor:under.displayFor}).run(under.job('launch'),under.ctx())).category,'campaign-failed');
 const u=world();u.s.clock=1000n;await launchTable({chain:u.chain,plans:u.plans}).run(u.job('launch-table'),u.ctx());u.s.next='unknown';
 const hu=launchFundingFirst({chain:u.chain,plans:u.plans,coSign:u.coSign,displayFor:u.displayFor});
 const unknown=await hu.run(u.job('launch'),u.ctx());assert.equal(unknown.outcome,'unknown');assert.equal(unknown.reconcile.kind,'launch');assert.equal(unknown.reconcile.signature,'sig-launch');
 // The fate of the journaled packet is read from the chain first; once the record reads live the launch is verified, never sent again.
 u.s.phase=PHASE_LIVE;u.s.ext={...u.s.ext,sealed:true};u.s.launched={table:'TABLE'};
 const resumed=await hu.run(u.job('launch'),u.ctx({reconciled:{status:'confirmed',signature:'sig-launch'}}));assert.equal(resumed.outcome,'done',JSON.stringify(resumed));assert.equal(resumed.signature,'sig-launch');assert.equal(u.s.sends.filter(x=>x==='launch').length,1,'the unknown send is the only send');
 const bad=world();bad.s.clock=1000n;await launchTable({chain:bad.chain,plans:bad.plans}).run(bad.job('launch-table'),bad.ctx());bad.chain.verifyLaunch=async()=>({ok:false,failures:['custody short']});
 assert.equal((await launchFundingFirst({chain:bad.chain,plans:bad.plans,coSign:bad.coSign,displayFor:bad.displayFor}).run(bad.job('launch'),bad.ctx())).category,'launch-verify-failed');
});
test('close: waits for the deadline; seals a funded round (closed) or marks a failed one refund-only; a record past phase 0 is done',async()=>{
 const w=world(),h=closeFundingFirst({chain:w.chain});
 assert.equal((await h.run(w.job('close'),w.ctx())).category,'funding-open');
 w.s.clock=1000n;const closed=await h.run(w.job('close'),w.ctx());assert.equal(closed.outcome,'done');assert.equal(closed.phase,PHASE_CLOSED);assert.equal(w.s.ext.sealed,true);
 assert.equal((await h.run(w.job('close'),w.ctx())).category,'already-closed');
 const f=world({commitments:[1_000_000n]});f.s.clock=1000n;const failed=await closeFundingFirst({chain:f.chain}).run(f.job('close'),f.ctx());assert.equal(failed.phase,PHASE_REFUND_ONLY);
 // A funded round sealed as closed whose launch window passed without a launch turns refund-only (the program's transition).
 const missed=world();missed.s.clock=1000n;await closeFundingFirst({chain:missed.chain}).run(missed.job('close'),missed.ctx());assert.equal(missed.s.phase,PHASE_CLOSED);
 missed.s.clock=1600n;const expired=await closeFundingFirst({chain:missed.chain}).run(missed.job('close'),missed.ctx());assert.equal(expired.outcome,'done',JSON.stringify(expired));assert.equal(expired.phase,PHASE_REFUND_ONLY);assert.equal(missed.s.sends.filter(x=>x==='close').length,2);
 assert.equal((await closeFundingFirst({chain:missed.chain}).run(missed.job('close'),missed.ctx())).category,'already-closed');
 const refundsAfterMiss=await refundsFundingFirst({chain:missed.chain}).run(missed.job('refunds:failure','refunds'),missed.ctx());assert.equal(refundsAfterMiss.failedCampaign,true);assert.equal(refundsAfterMiss.refundedLamports,'20000000');
 const live=world();live.s.phase=PHASE_LIVE;live.s.clock=1600n;assert.equal((await closeFundingFirst({chain:live.chain}).run(live.job('close'),live.ctx())).category,'already-closed','a live campaign is left alone');
});
test('refunds: a failed round refunds every commitment; a funded round refunds the excess over the hard cap; owed and counter reconcile; unknown stops the pass',async()=>{
 const f=world({commitments:[1_000_000n,2_000_000n]}),hf=refundsFundingFirst({chain:f.chain});
 assert.equal((await hf.run(f.job('refunds:failure','refunds'),f.ctx())).category,'funding-open');
 f.s.clock=1000n;const done=await hf.run(f.job('refunds:failure','refunds'),f.ctx());
 assert.equal(done.outcome,'done');assert.equal(done.failedCampaign,true);assert.equal(done.refunded,2);assert.equal(done.refundedLamports,'3000000');assert.equal(f.s.phase,PHASE_REFUND_ONLY);
 assert.equal((await hf.run(f.job('refunds:failure','refunds'),f.ctx())).refunded,0,'idempotent');
 const e=world({commitments:[8_000_000_000n,4_000_000_000n],hard:10_000_000_000n}),he=refundsFundingFirst({chain:e.chain});e.s.clock=1000n;
 const excess=await he.run(e.job('refunds:excess','refunds'),e.ctx());assert.equal(excess.outcome,'done');assert.equal(excess.failedCampaign,false);
 const expected=e.s.receipts.reduce((a,r)=>a+(r.committed-accepted(r.committed,12_000_000_000n,10_000_000_000n)),0n);assert.equal(excess.refundedLamports,String(expected));assert.equal(e.s.phase,PHASE_CLOSED,'the first refund sealed the totals');
 const u=world({commitments:[1_000_000n,2_000_000n]});u.s.clock=1000n;u.s.next='unknown';const unknown=await refundsFundingFirst({chain:u.chain}).run(u.job('refunds:failure','refunds'),u.ctx());
 assert.equal(unknown.outcome,'unknown');assert.equal(unknown.reconcile.receipt,'R000');assert.equal(u.s.sends.length,1,'the pass stops at the unknown send');
 const s=world({commitments:[1n,2n,3n]});s.s.clock=1000n;const sliced=await refundsFundingFirst({chain:s.chain,maxReceipts:2}).run(s.job('refunds:failure','refunds'),s.ctx());assert.equal(sliced.outcome,'yield');assert.equal(sliced.checkpoint.processed,2);
});
test('accounting: waits for sealed totals, accounts every receipt exactly once, tolerates a failed send for a receipt already accounted, and is done when the counts match',async()=>{
 const w=world({commitments:[8_000_000_000n,4_000_000_000n,7n],hard:10_000_000_000n}),h=accountFundingFirst({chain:w.chain});
 assert.equal((await h.run(w.job('account','settlement'),w.ctx())).category,'not-sealed');
 w.s.clock=1000n;await closeFundingFirst({chain:w.chain}).run(w.job('close'),w.ctx());
 const done=await h.run(w.job('account','settlement'),w.ctx());assert.equal(done.outcome,'done',JSON.stringify(done));assert.equal(done.accounted,3);assert.equal(done.accountedCount,3);assert.equal(done.sealedReceipts,3);
 const target=BigInt(w.s.ext.acceptedTarget),sum=w.s.receipts.reduce((a,r)=>a+accepted(r.committed,BigInt(w.s.ext.sealedTotal),10_000_000_000n),0n);assert.equal(done.accountedAccepted,String(sum));assert.equal(done.dust,String(target-sum));assert.ok(target-sum<3n,'dust is below the receipt count');
 assert.equal((await h.run(w.job('account','settlement'),w.ctx())).accounted,0,'exact once');
 const c=world({commitments:[5_000_000n,6_000_000n]});c.s.clock=1000n;await closeFundingFirst({chain:c.chain}).run(c.job('close'),c.ctx());assert.equal(c.s.phase,PHASE_CLOSED);
 // A concurrent accounting landed between the enumeration and the send: the failed send is not an error once the chain shows it.
 const realAccount=c.chain.accountV2;c.chain.accountV2=async(id2,r)=>{if(r.address==='R000'){await realAccount(id2,r);return {status:'failed',error:'custom program error: 0x6c'};}return realAccount(id2,r);};
 const raced=await accountFundingFirst({chain:c.chain}).run(c.job('account','settlement'),c.ctx());assert.equal(raced.outcome,'done',JSON.stringify(raced));assert.equal(raced.accountedCount,2);
});
test('collateral: returns the whole collateral after a failed round, collateral minus dust after a live and fully accounted round, once; not before',async()=>{
 const f=world({commitments:[1_000_000n]}),hf=collateralReturnFundingFirst({chain:f.chain});
 assert.equal((await hf.run(f.job('collateral-return','settlement'),f.ctx())).category,'not-terminal');
 f.s.clock=1000n;await closeFundingFirst({chain:f.chain}).run(f.job('close'),f.ctx());
 const failed=await hf.run(f.job('collateral-return','settlement'),f.ctx());assert.equal(failed.outcome,'done');assert.equal(failed.returnedLamports,COLLATERAL_LAMPORTS_V2);
 assert.equal((await hf.run(f.job('collateral-return','settlement'),f.ctx())).outcome,'done');assert.equal(f.s.sends.filter(x=>x==='collateral').length,1,'once');
 const l=world({commitments:[8_000_000_000n,4_000_000_000n,7n],hard:10_000_000_000n}),hl=collateralReturnFundingFirst({chain:l.chain});l.s.clock=1000n;
 await launchTable({chain:l.chain,plans:l.plans}).run(l.job('launch-table'),l.ctx());await launchFundingFirst({chain:l.chain,plans:l.plans,coSign:l.coSign,displayFor:l.displayFor}).run(l.job('launch'),l.ctx());
 assert.equal((await hl.run(l.job('collateral-return','settlement'),l.ctx())).category,'not-accounted');
 await accountFundingFirst({chain:l.chain}).run(l.job('account','settlement'),l.ctx());
 const live=await hl.run(l.job('collateral-return','settlement'),l.ctx());assert.equal(live.outcome,'done');
 const dust=BigInt(l.s.ext.acceptedTarget)-BigInt(l.s.ext.accountedAccepted);assert.equal(live.returnedLamports,String(BigInt(COLLATERAL_LAMPORTS_V2)-dust));
 const u=world({commitments:[1_000_000n]});u.s.clock=1000n;await closeFundingFirst({chain:u.chain}).run(u.job('close'),u.ctx());u.s.next='unknown';
 const hu=collateralReturnFundingFirst({chain:u.chain});const unknown=await hu.run(u.job('collateral-return','settlement'),u.ctx());assert.equal(unknown.outcome,'unknown');
 assert.equal((await hu.run(u.job('collateral-return','settlement'),u.ctx({reconciled:{status:'confirmed',signature:'sig-collateral'}}))).outcome,'done','a reconciled confirmed send is done without another send');
});
test('versioned dispatch: the record\'s accounting version picks the handler for a shared job class, for run and reconcile',async()=>{
 const calls=[];const v0={run:async()=>{calls.push('v0');return {outcome:'done'};},reconcile:async()=>({status:'confirmed'})},v2={run:async()=>{calls.push('v2');return {outcome:'done'};}};
 const a=world({accountingVersion:0}),b=world();
 await versioned({chain:a.chain,v0,v2}).run(a.job('launch'),a.ctx());await versioned({chain:b.chain,v0,v2}).run(b.job('launch'),b.ctx());assert.deepEqual(calls,['v0','v2']);
 assert.equal((await versioned({chain:b.chain,v0,v2}).reconcile(b.job('launch'),b.ctx())).note,'handler cannot reconcile');
 assert.equal((await versioned({chain:a.chain,v0,v2}).reconcile(a.job('launch'),a.ctx())).status,'confirmed');
 assert.throws(()=>versioned({chain:a.chain,v0,v2:{}}),/both handlers/);
});
