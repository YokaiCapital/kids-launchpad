import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountStore} from '../server/account-store.mjs';
import {generateKeypair,signWithSeed} from '../../shared/solana.mjs';
const sign=(wallet,challenge)=>({id:challenge.id,signature:signWithSeed(wallet.seed,Buffer.from(challenge.message)).toString('base64')});
test('wallet signature authentication rejects wrong signer, expired challenge and nonce replay',()=>{
 let now=1000000;const a=generateKeypair(),b=generateKeypair(),store=new AccountStore({origin:'http://localhost:4175',clock:()=>now});
 try{const challenge=store.challenge(a.address);assert.throws(()=>store.verify(sign(b,challenge)),/did not match/);const session=store.verify(sign(a,challenge));assert.equal(store.session(session.token).owner,a.address);assert.throws(()=>store.verify(sign(a,challenge)),/already used/);store.logout(session.token);assert.equal(store.session(session.token),null);const expired=store.challenge(a.address);now+=300001;assert.throws(()=>store.verify(sign(a,expired)),/expired/);}finally{store.close();}
});
test('wallet-owned proposal history isolates writers, retries and admin moderation',()=>{
 const a=generateKeypair(),b=generateKeypair(),mintA=generateKeypair().address,mintB=generateKeypair().address;
 const store=new AccountStore({origin:'http://localhost:4175',admins:[a.address]});
 const info=mint=>({mint,supply:'1000000000',decimals:6,slot:10,checkedAt:new Date().toISOString(),program:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',supported:true});
 const draft={a:mintA,b:mintB,parentData:{a:info(mintA),b:info(mintB)},name:'Local Kid',ticker:'LOCAL',description:'A local proposal.',art:'/assets/sprout.png',rights:true};
 try{const input={requestId:'submit-owned-001',revision:0,action:'submit',payload:{draft}};const result=store.apply(a.address,input);assert.deepEqual(store.apply(a.address,input),result);assert.equal(store.state(b.address).history.length,0);assert.throws(()=>store.apply(b.address,{...input,payload:{draft:{...draft,proposalId:result.proposal.id}}}),/does not belong/);assert.throws(()=>store.moderate(b.address,{owner:a.address,id:result.proposal.id,version:1,status:'Approved for next round'}),/Moderator/);store.moderate(a.address,{owner:a.address,id:result.proposal.id,version:1,status:'Approved for next round'});assert.equal(store.publicProposals().length,1);assert.throws(()=>store.moderate(a.address,{owner:a.address,id:result.proposal.id,version:1,status:'Changes requested'}),/not awaiting/);}finally{store.close();}
});
