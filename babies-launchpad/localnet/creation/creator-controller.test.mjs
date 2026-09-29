import test from 'node:test';
import assert from 'node:assert/strict';
import {createCreatorController} from '../../interaction-review/src/public/creator-controller.mjs';
import {provisionFixture} from '../test/helpers/provision-fixture.mjs';
import {buildMintPacket,createMintIntent} from './mint-packet.mjs';
import {reviewedProvisionPolicy} from './provision-packet.mjs';
import {CREATE_V3_URI_PREFIX} from '../protocol-v3/client.mjs';
import {buildProvisionPacket} from './provision-packet.mjs';
import {buildOperatingFundingPacket} from './operating-proofs.mjs';
import {Keypair} from '@solana/web3.js';
function fixture(stage='mint'){
 const {creator,intent,quote,block}=provisionFixture(),m=intent.mint,owner=m.creator;
 const payer=Keypair.generate().publicKey.toBase58(),fund={genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,payer,policy:'creator-funded-v1',creator:owner,lamports:quote.terms.operating.reserveLamports};
 const request={id:m.requestId,owner,draftId:'draft',state:'accepted',body:{draft:{name:m.metadata.name,symbol:m.metadata.symbol,start:'after-creation'},quote:{...quote,genesisHash:m.genesisHash,programId:m.programId,fundingEnabled:false,operatingPayer:payer,costs:{lines:[{item:'mint account rent',lamports:m.rentLamports}]},authorityFunding:{amountLamports:intent.authorityBudgetLamports}}}};
 const snapshot={requestId:request.id,draftId:'draft',network:'localnet',fundingEnabled:false,workerActivation:false,stage,action:'prepare',state:'awaiting-approval',mint:m.mint,campaign:m.campaign,review:{network:'localnet',...intent.policy,genesisHash:m.genesisHash,programId:m.programId,treasury:intent.treasury,operatingPayer:payer,operatingReserveLamports:fund.lamports,name:m.metadata.name,symbol:m.metadata.symbol,mintRentLamports:m.rentLamports,authorityBudgetLamports:intent.authorityBudgetLamports,start:'after-creation',startUtc:null}};
 const packet=stage==='mint'?buildMintPacket(m,block):stage==='operating-reserve'?buildOperatingFundingPacket(fund,block):buildProvisionPacket(intent,stage,block);
 const offer={requestId:request.id,stage,offerId:'offer',transactionBase64:Buffer.from(packet.serialize()).toString('base64'),verification:stage==='mint'?m:stage==='operating-reserve'?fund:intent,review:{creator:owner,opensAt:intent.opensAt}};
 let current=owner,signs=0,lose=false,reject=false,submitCount=0;const calls=[],changes=[];
 const api=async(path,body)=>{calls.push({path,body});if(path==='state')return {owner:current,csrf:'session'};if(path.endsWith('/status'))return structuredClone(snapshot);if(path.endsWith('/prepare'))return {...structuredClone(snapshot),result:structuredClone(offer)};if(path.endsWith('/submit')){submitCount++;if(lose)throw Error('HTTP timeout');snapshot.action='resume';return structuredClone(snapshot);}if(path.endsWith('/resume')){snapshot.action='none';snapshot.stage='complete';return structuredClone(snapshot);}throw Error('Unexpected request '+path);};
 const wallet=async()=>({publicKey:creator.publicKey,signTransaction:async tx=>{signs++;if(reject)throw Error('Wallet declined');tx.sign([creator]);return tx;}});
 const open=extra=>createCreatorController({owner,request,api,wallet,currentOwner:()=>current,onChange:s=>changes.push(s),...extra});
 return {open,owner,request,snapshot,offer,calls,changes,get signs(){return signs;},get submits(){return submitCount;},lose(v){lose=v;},reject(v){reject=v;},switch(){current='other';}};
}
test('each creator stage requires an explicit wallet approval and uses the reviewed exact offer',async()=>{
 for(const stage of ['mint','native-custody','create-campaign']){const f=fixture(stage),c=f.open();await c.refresh();assert.equal(f.signs,0);await c.advance();assert.equal(f.signs,0);assert.equal(c.getState().offer.stage,stage);await c.approve();assert.equal(f.signs,1);assert.equal(f.submits,1);assert.equal(c.getState().snapshot.action,'resume');assert.equal(f.calls.some(x=>x.path.endsWith('/resume')),false);await c.advance();assert.equal(c.getState().snapshot.stage,'complete');}
});
test('uncertain submission retains the same signed bytes and never asks for a second signature',async()=>{
 const f=fixture(),c=f.open();await c.advance();f.lose(true);await assert.rejects(c.approve(),/timeout/);assert.equal(c.getState().uncertain,true);assert.equal(c.hasHeldApproval(),true);await assert.rejects(c.advance(),/previous approval/);await c.refresh();assert.equal(c.hasHeldApproval(),true);f.lose(false);await c.resubmit();const submits=f.calls.filter(x=>x.path.endsWith('/submit'));assert.equal(submits.length,2);assert.deepEqual(submits[0].body,submits[1].body);assert.equal(f.signs,1);assert.equal(c.hasHeldApproval(),false);
});
test('owner changes and disposal while wallet approval is pending prevent submission',async()=>{
 for(const dispose of [false,true]){const f=fixture();let release;const wallet=async()=>({publicKey:{toString:()=>f.owner},signTransaction:()=>new Promise(r=>release=r)});const c=f.open({wallet});await c.advance();const p=c.approve();while(!release)await new Promise(r=>setTimeout(r,1));if(dispose)c.dispose();else f.switch();release({});await assert.rejects(p,/Wallet changed/);assert.equal(f.submits,0);}
});
test('wrong policy, mint request, stage and scheduled opening are refused before any prompt',async()=>{
 for(const mutate of [f=>f.snapshot.review.hardCapLamports='999',f=>f.offer.verification.mint.requestId='foreign',f=>f.offer.stage='commit',f=>{f.request.body.draft.start='scheduled';f.request.body.draft.startUtc='2040-01-01T00:00';f.snapshot.review.start='scheduled';f.snapshot.review.startUtc='2040-01-01T00:00';}]){const f=fixture('create-campaign');mutate(f);const c=f.open();await assert.rejects(c.advance());assert.equal(f.signs,0);assert.equal(f.submits,0);}
});
test('wallet refusal keeps the review and a concurrent double click cannot open two prompts',async()=>{
 const f=fixture(),c=f.open();await c.advance();f.reject(true);await assert.rejects(c.approve(),/declined/);assert.ok(c.getState().offer);assert.equal(f.submits,0);const p=c.approve();await assert.rejects(c.approve(),/in progress/);await assert.rejects(p,/declined/);
});
test('the operating reserve is one more explicit approval: the exact reviewed transfer, one signature, one submission',async()=>{
 const f=fixture('operating-reserve'),c=f.open();await c.refresh();assert.equal(f.signs,0);await c.advance();assert.equal(c.getState().offer.stage,'operating-reserve');assert.equal(f.signs,0);await c.approve();assert.equal(f.signs,1);assert.equal(f.submits,1);
 const g=fixture('operating-reserve');g.offer.verification.payer=g.owner;const d=g.open();await assert.rejects(d.advance(),/another campaign/);assert.equal(g.signs,0);
 const h=fixture('operating-reserve');h.snapshot.review.operatingReserveLamports='1';await assert.rejects(h.open().refresh(),/operatingReserveLamports/);
});

// One creation transaction: the 'launch' stage is the only wallet approval.
function oneFixture(network='localnet'){
 const {creator,intent,quote,block}=provisionFixture(),m=intent.mint,owner=m.creator,payer=Keypair.generate().publicKey.toBase58(),reserveLamports=quote.terms.operating.reserveLamports;
 const one=createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:m.requestId,leaseId:m.leaseId,genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,authority:m.authority,nonce:m.nonce,mint:m.mint},creator:owner,rentLamports:m.rentLamports,metadata:{...m.metadata,uri:CREATE_V3_URI_PREFIX+'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'},
  launch:{policy:reviewedProvisionPolicy(quote),treasury:intent.treasury,opensAt:'0',authorityBudgetLamports:intent.authorityBudgetLamports,reserve:{payer,lamports:reserveLamports},priorityFeeLamports:'10000'}});
 const request={id:m.requestId,owner,draftId:'draft',state:'accepted',body:{draft:{name:m.metadata.name,symbol:m.metadata.symbol,start:'after-creation'},quote:{...quote,genesisHash:m.genesisHash,programId:m.programId,fundingEnabled:false,operatingPayer:payer,costs:{lines:[{item:'mint account rent',lamports:m.rentLamports}]},authorityFunding:{amountLamports:intent.authorityBudgetLamports}}}};
 const snapshot={requestId:request.id,draftId:'draft',network:'localnet',fundingEnabled:false,workerActivation:false,stage:'launch',action:'prepare',state:'awaiting-approval',mint:m.mint,campaign:m.campaign,review:{network:'localnet',...intent.policy,genesisHash:m.genesisHash,programId:m.programId,treasury:intent.treasury,operatingPayer:payer,operatingReserveLamports:reserveLamports,name:m.metadata.name,symbol:m.metadata.symbol,mintRentLamports:m.rentLamports,authorityBudgetLamports:intent.authorityBudgetLamports,start:'after-creation',startUtc:null}};
 const offer={requestId:request.id,stage:'launch',offerId:'offer',transactionBase64:Buffer.from(buildMintPacket(one,block).serialize()).toString('base64'),verification:one,review:{creator:owner,opensAt:'0'}};
 let signs=0,submits=0;const calls=[];
 const api=async(path,body)=>{calls.push({path,body});if(path==='state')return {owner,csrf:'session'};if(path.endsWith('/status'))return structuredClone(snapshot);if(path.endsWith('/prepare'))return {...structuredClone(snapshot),result:structuredClone(offer)};if(path.endsWith('/submit')){submits++;snapshot.action='resume';return structuredClone(snapshot);}throw Error('Unexpected '+path);};
 const wallet=async()=>({publicKey:creator.publicKey,signTransaction:async tx=>{signs++;tx.sign([creator]);return tx;}});
 snapshot.network=network;snapshot.review.network=network;
 return {open:()=>createCreatorController({owner,request,api,wallet,currentOwner:()=>owner,network}),owner,request,snapshot,offer,calls,get signs(){return signs;},get submits(){return submits;}};
}
test('one creation transaction: the launch stage is one explicit approval of the exact reviewed packet',async()=>{
 const f=oneFixture(),c=f.open();await c.refresh();assert.equal(f.signs,0);await c.advance();assert.equal(f.signs,0);assert.equal(c.getState().offer.stage,'launch');assert.equal(c.getState().offer.scope.opensAt,'0');
 await c.approve();assert.equal(f.signs,1);assert.equal(f.submits,1);assert.equal(c.getState().snapshot.action,'resume');assert.equal(c.getState().offer,null);
 const submitted=f.calls.find(x=>x.path.endsWith('/submit')).body;assert.equal(submitted.stage,'launch');assert.equal(submitted.offerId,'offer');assert.notEqual(submitted.transactionBase64,f.offer.transactionBase64,'the submission carries the signature');
});
test('one creation transaction: a launch that differs from the review, or from the accepted opening, is refused before any prompt',async()=>{
 const g=oneFixture();g.offer.verification.launch.reserve.payer=Keypair.generate().publicKey.toBase58();await assert.rejects(g.open().advance(),/differs from the reviewed launch/);assert.equal(g.signs,0);
 const h=oneFixture();h.offer.verification.launch.authorityBudgetLamports='1';await assert.rejects(h.open().advance(),/differs from the reviewed launch/);assert.equal(h.signs,0);
 const i=oneFixture();i.offer.review.opensAt='1800000000';i.offer.verification.launch.opensAt='1800000000';await assert.rejects(i.open().advance(),/Opening time differs/);assert.equal(i.signs,0);
 const j=oneFixture();j.request.body.draft.start='scheduled';j.request.body.draft.startUtc='2040-01-01T00:00';j.snapshot.review.start='scheduled';j.snapshot.review.startUtc='2040-01-01T00:00';await assert.rejects(j.open().advance(),/Scheduled opening changed/);assert.equal(j.signs,0);
 const k=oneFixture();k.snapshot.review.operatingReserveLamports='1';await assert.rejects(k.open().refresh(),/operatingReserveLamports/);
 const l=oneFixture();l.offer.stage='mint';await assert.rejects(l.open().advance(),/differs/);assert.equal(l.signs,0);
});

test('hosted creation preserves the configured network through the final wallet check',async()=>{
 for(const network of ['mainnet','devnet']){
  const f=oneFixture(network),c=f.open();await c.advance();
  assert.equal(f.signs,0);await c.approve();
  assert.equal(f.signs,1);assert.equal(f.submits,1);
 }
});

test('background status polling preserves a stopped flow until explicit retry',async()=>{
 const f=fixture(),c=f.open();await c.advance();f.lose(true);
 await assert.rejects(c.approve(),/timeout/);await new Promise(r=>setImmediate(r));
 const before=c.getState(),calls=f.calls.length;
 await c.refresh({background:true});
 assert.deepEqual(c.getState(),before);assert.equal(f.calls.length,calls);
 assert.equal(c.hasHeldApproval(),true);assert.equal(f.signs,1);
 f.lose(false);await c.resubmit();assert.equal(f.signs,1);assert.equal(f.submits,2);
});
test('one-transaction recovery sends the previous signature to the mint recovery service',async()=>{
 const f=oneFixture(),c=f.open();f.snapshot.action='recover';f.snapshot.state='expired';f.snapshot.signature='previous-signature';
 await c.refresh();await assert.rejects(c.recover(),/Unexpected/);
 const sent=f.calls.find(x=>x.path.endsWith('/recover')).body;
 assert.equal(sent.expectedSignature,'previous-signature');assert.equal(sent.stage,'launch');
 assert.equal(Object.hasOwn(sent,'expectedIntentHash'),false);assert.equal(f.signs,0);
});

test('background polling does not erase a wallet refusal, but explicit retry can continue',async()=>{
 const f=fixture(),c=f.open();await c.refresh({background:true});assert.ok(c.getState().snapshot);
 await c.advance();f.reject(true);await assert.rejects(c.approve(),/declined/);
 await new Promise(r=>setImmediate(r));const before=c.getState();
 await c.refresh({background:true});assert.deepEqual(c.getState(),before);
 assert.equal(f.signs,1);assert.equal(f.submits,0);
 f.reject(false);await c.refresh();await c.advance();await c.approve();
 assert.equal(f.signs,2);assert.equal(f.submits,1);
});

test('reload restores the exact approved packet after a lost response without a second signature',async()=>{
 const f=fixture();let saved=null;
 const approvalStore={load:async()=>structuredClone(saved),save:async v=>{saved=structuredClone(v);},clear:async()=>{saved=null;}};
 const a=f.open({approvalStore});await a.advance();f.lose(true);await assert.rejects(a.approve(),/timeout/);assert.ok(saved);a.dispose();
 const b=f.open({approvalStore});await b.refresh();assert.equal(b.hasHeldApproval(),true);assert.equal(b.getState().uncertain,true);
 f.lose(false);await b.resubmit();assert.equal(f.signs,1);assert.equal(saved,null);
 const inputs=f.calls.filter(x=>x.path.endsWith('/submit')).map(x=>x.body.transactionBase64);assert.equal(inputs[0],inputs[1]);
});
test('approval in another tab and a changed stored packet never open the wallet',async()=>{
 const f=fixture(),a=f.open({approvalLock:async()=>{throw Error('another tab');}});await a.advance();await assert.rejects(a.approve(),/another tab/);assert.equal(f.signs,0);
 const b=f.open({approvalStore:{load:async()=>({snapshot:{...f.snapshot,requestId:'other'},offer:f.offer,input:{}})}});
 await assert.rejects(b.refresh(),/different launch/);assert.equal(f.signs,0);
});

test('retry wakes a paused server continuation even when the transaction is already complete',async()=>{
 const f=fixture(),c=f.open();Object.assign(f.snapshot,{stage:'complete',state:'funded',action:'none',serverManaged:true,serverWork:'paused',activationReady:false});await c.refresh();await c.advance();assert.ok(f.calls.some(x=>x.path.endsWith('/resume')));assert.equal(f.signs,0);
});
// Funding-first accounting (29 September 2026): the opening packet (version 3) is the one wallet approval; the status review
// carries the sealed fee NFT and the offer must bind exactly it.
import {VersionedTransaction} from '@solana/web3.js';
function fundingFixture(network='localnet'){
 const {creator,intent,quote,block}=provisionFixture(),m=intent.mint,owner=m.creator,payer=Keypair.generate().publicKey.toBase58(),reserveLamports=quote.terms.operating.reserveLamports,feeNft=Keypair.generate().publicKey.toBase58();
 const one=createMintIntent({preparation:{programVersion:3,state:'reserved',fundingEnabled:false,requestId:m.requestId,leaseId:m.leaseId,genesisHash:m.genesisHash,programId:m.programId,campaign:m.campaign,authority:m.authority,nonce:m.nonce,mint:m.mint},creator:owner,rentLamports:m.rentLamports,metadata:{...m.metadata,uri:CREATE_V3_URI_PREFIX+'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'},
  launch:{policy:reviewedProvisionPolicy(quote),treasury:intent.treasury,opensAt:'0',authorityBudgetLamports:intent.authorityBudgetLamports,reserve:{payer,lamports:reserveLamports},priorityFeeLamports:'10000'},fundingFirst:{feeNft}});
 const request={id:m.requestId,owner,draftId:'draft',state:'accepted',body:{draft:{name:m.metadata.name,symbol:m.metadata.symbol,start:'after-creation'},quote:{...quote,genesisHash:m.genesisHash,programId:m.programId,fundingEnabled:false,operatingPayer:payer,costs:{lines:[{item:'mint account rent',lamports:m.rentLamports}]},authorityFunding:{amountLamports:intent.authorityBudgetLamports}}}};
 const snapshot={requestId:request.id,draftId:'draft',network,fundingEnabled:false,workerActivation:false,stage:'launch',action:'prepare',state:'awaiting-approval',creationMode:'single',fundingFirst:true,mint:m.mint,campaign:m.campaign,review:{network,...intent.policy,genesisHash:m.genesisHash,programId:m.programId,treasury:intent.treasury,operatingPayer:payer,operatingReserveLamports:reserveLamports,name:m.metadata.name,symbol:m.metadata.symbol,mintRentLamports:m.rentLamports,authorityBudgetLamports:intent.authorityBudgetLamports,start:'after-creation',startUtc:null,accounting:'funding-first',feeNft,tokenCreatedAtOpening:false}};
 const offer={requestId:request.id,stage:'launch',offerId:'offer',transactionBase64:Buffer.from(buildMintPacket(one,block).serialize()).toString('base64'),verification:one,review:{creator:owner,opensAt:'0',accounting:'funding-first',feeNft,tokenCreatedAtOpening:false}};
 let signs=0,submits=0,lose=false;const calls=[];
 const api=async(path,body)=>{calls.push({path,body});if(path==='state')return {owner,csrf:'session'};if(path.endsWith('/status'))return structuredClone(snapshot);if(path.endsWith('/prepare'))return {...structuredClone(snapshot),result:structuredClone(offer)};if(path.endsWith('/submit')){submits++;if(lose)throw Error('HTTP timeout');snapshot.action='resume';return structuredClone(snapshot);}throw Error('Unexpected '+path);};
 const wallet=async()=>({publicKey:creator.publicKey,signTransaction:async tx=>{signs++;tx.sign([creator]);return tx;}});
 return {open:(extra={})=>createCreatorController({owner,request,api,wallet,currentOwner:()=>owner,network,...extra}),owner,request,snapshot,offer,calls,feeNft,one,block,get signs(){return signs;},get submits(){return submits;},lose(v){lose=v;}};
}
test('funding-first opening: the launch stage is one explicit approval of the exact reviewed opening (three signature slots, one wallet signature, custody slots left empty)',async()=>{
 const f=fundingFixture(),c=f.open();await c.refresh();await c.advance();assert.equal(f.signs,0);
 const o=c.getState().offer;assert.equal(o.stage,'launch');assert.equal(o.scope.feeNft,f.feeNft);assert.equal(o.scope.accounting,'funding-first');assert.equal(o.scope.opensAt,'0');
 await c.approve();assert.equal(f.signs,1);assert.equal(f.submits,1);assert.equal(c.getState().snapshot.action,'resume');assert.equal(c.getState().offer,null);
 const submitted=f.calls.find(x=>x.path.endsWith('/submit')).body;assert.equal(submitted.stage,'launch');assert.equal(submitted.offerId,'offer');
 const tx=VersionedTransaction.deserialize(Buffer.from(submitted.transactionBase64,'base64'));assert.equal(tx.signatures.length,3);assert.ok(tx.signatures[0].some(b=>b!==0));assert.ok(tx.signatures[1].every(b=>b===0)&&tx.signatures[2].every(b=>b===0),'the reserved mint and fee NFT sign on the server, never in the browser');
});
test('funding-first opening: an offer whose fee NFT, accounting, reserve or packet differs from the review is refused before any prompt; a version-2 packet for a funding-first review too',async()=>{
 const g=fundingFixture();g.offer.verification.fundingFirst.feeNft=Keypair.generate().publicKey.toBase58();await assert.rejects(g.open().advance(),/differs from the reviewed launch/);assert.equal(g.signs,0);
 const h=fundingFixture();delete h.snapshot.review.feeNft;delete h.snapshot.review.accounting;await assert.rejects(h.open().advance(),/differs from the reviewed launch/);assert.equal(h.signs,0);
 const i=fundingFixture();i.snapshot.review.feeNft=Keypair.generate().publicKey.toBase58();await assert.rejects(i.open().advance(),/differs/);assert.equal(i.signs,0);
 const j=fundingFixture(),v2=structuredClone(j.one);delete v2.fundingFirst;v2.version=2;j.offer.verification=v2;j.offer.transactionBase64=Buffer.from(buildMintPacket(v2,j.block).serialize()).toString('base64');await assert.rejects(j.open().advance(),/differs from the reviewed launch/,'a version-2 creation of the same mint is not the reviewed opening');assert.equal(j.signs,0);
 const k=fundingFixture();k.offer.verification.launch.reserve.lamports='1';await assert.rejects(k.open().advance(),/differs from the reviewed launch/);assert.equal(k.signs,0);
 const l=fundingFixture();l.snapshot.review.operatingReserveLamports='1';await assert.rejects(l.open().refresh(),/operatingReserveLamports/);
 const n=fundingFixture();n.snapshot.review.accounting='per-receipt';await assert.rejects(n.open().advance(),/differs from the reviewed launch/);assert.equal(n.signs,0);
});
test('funding-first opening: reload restores the exact approved opening after a lost response without a second signature; recovery sends the previous signature',async()=>{
 const f=fundingFixture();let saved=null;const approvalStore={load:async()=>structuredClone(saved),save:async v=>{saved=structuredClone(v);},clear:async()=>{saved=null;}};
 const a=f.open({approvalStore});await a.advance();f.lose(true);await assert.rejects(a.approve(),/timeout/);assert.ok(saved);a.dispose();
 const b=f.open({approvalStore});await b.refresh();assert.equal(b.hasHeldApproval(),true);assert.equal(b.getState().uncertain,true);
 f.lose(false);await b.resubmit();assert.equal(f.signs,1);assert.equal(saved,null);
 const inputs=f.calls.filter(x=>x.path.endsWith('/submit')).map(x=>x.body.transactionBase64);assert.equal(inputs[0],inputs[1]);
 const r=fundingFixture(),c=r.open();r.snapshot.action='recover';r.snapshot.state='expired';r.snapshot.signature='previous-signature';await c.refresh();await assert.rejects(c.recover(),/Unexpected/);
 const sent=r.calls.find(x=>x.path.endsWith('/recover')).body;assert.equal(sent.expectedSignature,'previous-signature');assert.equal(sent.stage,'launch');assert.equal(r.signs,0);
});
