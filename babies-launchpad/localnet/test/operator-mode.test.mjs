// Regression for the architecture audit (key isolation): the mainnet API must never boot with an operator key.
import test from 'node:test';import assert from 'node:assert/strict';import {resolveOperatorMode} from '../../deployment/mainnet/operator-mode.mjs';
test('mainnet boots only in signer mode and refuses any operator key in its environment',()=>{
 assert.equal(resolveOperatorMode({KIDS_NETWORK:'mainnet'}).mode,'invalid');
 assert.equal(resolveOperatorMode({KIDS_NETWORK:'mainnet',KIDS_OPERATOR_KEY_JSON:'[1]'}).mode,'invalid');
 assert.equal(resolveOperatorMode({KIDS_NETWORK:'mainnet',KIDS_ALLOW_LOCAL_OPERATOR_KEY:'1',KIDS_OPERATOR_KEY_JSON:'[1]'}).mode,'invalid');
 const ok=resolveOperatorMode({KIDS_NETWORK:'mainnet',KIDS_SIGNER_URL:'http://kids-signer.railway.internal:4176',KIDS_SIGNER_TOKEN:'t'.repeat(40),KIDS_SIGNER_PUBKEY:'AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE'});
 assert.equal(ok.mode,'signer');assert.equal(ok.wipeLocalKey,true);
 assert.match(resolveOperatorMode({KIDS_NETWORK:'mainnet',KIDS_SIGNER_URL:'http://x',KIDS_SIGNER_TOKEN:'t'.repeat(40),KIDS_SIGNER_PUBKEY:'A',KIDS_OPERATOR_KEY_JSON:'[1]'}).reason,/must be removed/);
 assert.equal(resolveOperatorMode({KIDS_NETWORK:'devnet',KIDS_ALLOW_LOCAL_OPERATOR_KEY:'1'}).mode,'local');
});
test('provisioning sends through the operator signer with extra local signers and a dry run that never broadcasts',async()=>{
 const {sendWithOperator}=await import('../provision-active-launch.mjs');const {createLocalSigner}=await import('../operator-signer.mjs');
 const {Keypair,Transaction,SystemProgram}=await import('@solana/web3.js');const op=Keypair.generate(),extra=Keypair.generate();
 let sent=0;const connection={async getLatestBlockhash(){return {blockhash:'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',lastValidBlockHeight:10};},async simulateTransaction(){return {value:{err:null,unitsConsumed:1}};},async sendRawTransaction(){sent++;return 'sig';},async confirmTransaction(){return {value:{err:null}};}};
 const tx=()=>new Transaction().add(SystemProgram.transfer({fromPubkey:op.publicKey,toPubkey:extra.publicKey,lamports:1}));
 await assert.rejects(sendWithOperator({connection,operator:createLocalSigner(op),tx:tx(),operationId:'p:1',dryRun:true}),/Dry run: next step simulates OK/);assert.equal(sent,0);
 const seen=[];const signer={publicKey:op.publicKey,async sign(t,o){seen.push(o.operationId);t.partialSign(op);return t;}};
 assert.equal(await sendWithOperator({connection,operator:signer,tx:tx(),extraSigners:[],operationId:'p:2'}),'sig');assert.deepEqual(seen,['p:2']);assert.equal(sent,1);
});

test('restore drill: mainnet boots without a signer, refuses keys, and every signing attempt is refused',async()=>{
 const {resolveOperatorMode}=await import('../../deployment/mainnet/operator-mode.mjs');const {operatorSigner}=await import('../operator-signer.mjs');
 const pk='AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE';
 assert.equal(resolveOperatorMode({KIDS_NETWORK:'mainnet',KIDS_DRILL:'1',KIDS_SIGNER_PUBKEY:pk}).mode,'drill');
 assert.equal(resolveOperatorMode({KIDS_NETWORK:'mainnet',KIDS_DRILL:'1'}).mode,'invalid');
 assert.equal(resolveOperatorMode({KIDS_NETWORK:'mainnet',KIDS_DRILL:'1',KIDS_SIGNER_PUBKEY:pk,KIDS_OPERATOR_KEY_JSON:'[1]'}).mode,'invalid');
 const signer=await operatorSigner({KIDS_DRILL:'1',KIDS_SIGNER_PUBKEY:pk});assert.equal(signer.publicKey.toBase58(),pk);await assert.rejects(signer.sign({}),/drill/);
});
