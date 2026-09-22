import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {parentTree,parentLeaf} from '../atomic-claims.mjs';
const campaign=Keypair.generate().publicKey,owners=Array.from({length:4},()=>Keypair.generate().publicKey);
const hash=b=>createHash('sha256').update(b).digest();
const verify=(leaf,proof)=>proof.reduce((h,s)=>hash(Buffer.concat(Buffer.compare(h,s)<=0?[h,s]:[s,h])),leaf);
test('parent snapshot applies exact0.05% threshold and retains allocation dust',()=>{
 const t=parentTree(campaign,0,1000000n,[{owner:owners[0],balance:499n},{owner:owners[1],balance:500n},{owner:owners[2],balance:1000n},{owner:owners[3],balance:501n}]);
 assert.equal(t.entries.length,3);assert.equal(t.eligibleBalance,2001n);assert.equal(t.threshold,500n);
 assert.ok(t.entries.reduce((a,h)=>a+h.allocation,0n)<=50000000000000n);
 for(const h of t.entries){assert.deepEqual(verify(parentLeaf(campaign,0,h.owner,h.balance,h.allocation),h.proof),t.root);assert.notDeepEqual(verify(parentLeaf(campaign,1,h.owner,h.balance,h.allocation),h.proof),t.root);assert.notDeepEqual(verify(parentLeaf(campaign,0,h.owner,h.balance,h.allocation+1n),h.proof),t.root);}
});
test('snapshot rejects duplicated owners, supply inflation and no eligible holders',()=>{
 assert.throws(()=>parentTree(campaign,0,1000n,[{owner:owners[0],balance:500n},{owner:owners[0],balance:500n}]));
 assert.throws(()=>parentTree(campaign,0,1000n,[{owner:owners[0],balance:1001n}]));
 assert.throws(()=>parentTree(campaign,0,1000000n,[{owner:owners[0],balance:499n}]));
});
