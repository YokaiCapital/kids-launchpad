import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,Transaction,SystemProgram} from '@solana/web3.js';
import {createOperatorSender} from '../operator-journal.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
function fixture(){
 const signer=Keypair.generate(),journal={attempts:{}},calls={built:0,sent:[],saved:0};let status=null,failPersist=false,loseResponse=false;
 const connection={getSignatureStatuses:async()=>({value:[status]}),getBlockHeight:async()=>1,getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}),sendRawTransaction:async bytes=>{calls.sent.push(Buffer.from(bytes));if(loseResponse)throw Error('lost response');return encodeBase58(Transaction.from(bytes).signature);},confirmTransaction:async()=>({value:{err:null}})};
 const persist=()=>{calls.saved++;if(failPersist)throw Error('disk full');};
 const build=block=>{calls.built++;const tx=new Transaction({feePayer:signer.publicKey,...block}).add(SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:signer.publicKey,lamports:1}));tx.sign(signer);return tx;};
 return {journal,calls,connection,persist,build,send:createOperatorSender({connection,journal,persist}),failDisk:v=>failPersist=v,lose:v=>loseResponse=v,status:v=>status=v};
}
test('failed durable write never sends and retry persists in-memory intent first',async()=>{const f=fixture();f.failDisk(true);await assert.rejects(f.send('launch',f.build),/disk full/);await assert.rejects(f.send('launch',f.build),/disk full/);assert.equal(f.calls.sent.length,0);f.failDisk(false);await f.send('launch',f.build);assert.equal(f.calls.built,1);assert.equal(f.calls.sent.length,1);});
test('ambiguous response replays identical bytes after process restore',async()=>{const f=fixture();f.lose(true);await assert.rejects(f.send('launch',f.build),/lost response/);f.lose(false);const restored=JSON.parse(JSON.stringify(f.journal));const send=createOperatorSender({connection:f.connection,journal:restored,persist:f.persist});await send('launch',()=>assert.fail('must not rebuild'));assert.deepEqual(f.calls.sent[0],f.calls.sent[1]);});
test('confirmed chain receipt reconciles without rebroadcast',async()=>{const f=fixture();await f.send('launch',f.build);f.status({err:null,confirmationStatus:'finalized'});await f.send('launch',()=>assert.fail('rebuild'));assert.equal(f.calls.sent.length,1);});
test('overlapping same operation shares one submission',async()=>{const f=fixture();const a=f.send('launch',f.build),b=f.send('launch',f.build);assert.equal(a,b);await Promise.all([a,b]);assert.equal(f.calls.sent.length,1);});
test('processed failure does not allow replacement of ambiguous transaction',async()=>{const f=fixture();f.lose(true);await assert.rejects(f.send('launch',f.build));f.status({err:{InstructionError:[0,'Custom']},confirmationStatus:'processed'});f.lose(false);await f.send('launch',f.build);assert.equal(f.calls.built,1);assert.deepEqual(f.calls.sent[0],f.calls.sent[1]);});
test('finalized expiry archives an absent attempt before rebuilding',async()=>{const f=fixture();f.lose(true);await assert.rejects(f.send('launch',f.build));const original=f.journal.attempts.launch.signature;f.connection.getBlockHeight=async()=>101;f.lose(false);await f.send('launch',f.build);assert.equal(f.calls.built,2);assert.notEqual(f.journal.attempts.launch.signature,original);assert.ok(Object.values(f.journal.attempts).some(a=>a.signature===original&&a.closedReason==='expired'));});
test('finalized execution failure can renew but retains failure evidence',async()=>{const f=fixture();f.lose(true);await assert.rejects(f.send('launch',f.build));f.status({err:{InstructionError:[0,'Custom']},confirmationStatus:'finalized'});f.lose(false);await f.send('launch',f.build);assert.equal(f.calls.built,2);assert.ok(Object.values(f.journal.attempts).some(a=>a.closedReason==='failed'));});
test('RPC acceptance without inclusion rebroadcasts same durable wire until confirmed',async()=>{const f=fixture();let finish;f.connection.confirmTransaction=()=>new Promise(r=>finish=r);const original=f.connection.sendRawTransaction;f.connection.sendRawTransaction=async bytes=>{const signature=await original(bytes);if(f.calls.sent.length===2)finish({value:{err:null}});return signature;};const send=createOperatorSender({connection:f.connection,journal:f.journal,persist:f.persist,resendIntervalMs:5});await send('launch',f.build);assert.equal(f.calls.built,1);assert.equal(f.calls.sent.length,2);assert.deepEqual(f.calls.sent[0],f.calls.sent[1]);assert.ok(f.calls.saved>=3);});
test('unresolved confirmation has a deadline and retains original intent',async()=>{const f=fixture();f.connection.confirmTransaction=()=>new Promise(()=>{});const send=createOperatorSender({connection:f.connection,journal:f.journal,persist:f.persist,resendIntervalMs:5,confirmationTimeoutMs:20});await assert.rejects(send('launch',f.build),/unresolved/);assert.equal(f.calls.built,1);assert.ok(f.journal.attempts.launch.wire);});
test('confirmation deadline cancels underlying subscription before retry',async()=>{const f=fixture();let signal;f.connection.confirmTransaction=strategy=>{signal=strategy.abortSignal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));};const send=createOperatorSender({connection:f.connection,journal:f.journal,persist:f.persist,resendIntervalMs:5,confirmationTimeoutMs:20});await assert.rejects(send('launch',f.build),/unresolved/);assert.equal(signal.aborted,true);});

test('the signer operation id is the journal id when it fits and its hash when an extend step lists twenty addresses',async()=>{
 const {signerOperationId}=await import('../operator-journal.mjs');
 assert.equal(signerOperationId('launch'),'launch');
 const long='extend:'+'A'.repeat(44)+':'+Array.from({length:20},()=>'B'.repeat(44)).join(',');
 const id=signerOperationId(long);assert.ok(long.length>120);assert.ok(id.length<=120);assert.match(id,/^sha256:[0-9a-f]{64}$/);assert.equal(signerOperationId(long),id);
});

test('a rebuilt attempt is a new signer operation: the id carries the blockhash, so an expired attempt never collides with the registry',async()=>{
 const {createOperatorSender}=await import('../operator-journal.mjs');const ids=[];let height=0;const statuses={};
 const c={async getLatestBlockhash(){return {blockhash:'H'+(++height),lastValidBlockHeight:height};},async getSignatureStatuses(){return {value:[null]};},async getBlockHeight(){return 1000;},async sendRawTransaction(){return 'sig'+height;},async confirmTransaction(){return {value:{err:null}};}};
 const journal={attempts:{}};const send=createOperatorSender({connection:c,journal,persist(){}});
 const build=async(block,operationId)=>{ids.push(operationId);const {Transaction,Keypair,SystemProgram}=await import('@solana/web3.js');const k=Keypair.generate();const tx=new Transaction({feePayer:k.publicKey,...block}).add(SystemProgram.transfer({fromPubkey:k.publicKey,toPubkey:k.publicKey,lamports:1}));tx.sign(k);return tx;};
 await send('settle:x',build).catch(()=>{});journal.attempts={};await send('settle:x',build).catch(()=>{});
 assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);assert.ok(ids[0].startsWith('settle:x:H'));
});
