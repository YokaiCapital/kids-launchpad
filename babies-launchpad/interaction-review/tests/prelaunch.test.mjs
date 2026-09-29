import test from 'node:test';
import assert from 'node:assert/strict';
import {allocation,parseSol,sol} from '../src/prelaunch.js';
import {DemoStore} from '../server/demo-store.mjs';
test('SOL decimal parsing is exact and malformed amounts cannot be committed',()=>{
 assert.equal(parseSol('0.000000001'),1n);assert.equal(sol(500000000000n),'500');assert.equal(sol(1n),'0.000000001');
 for(const amount of ['-1','0','Infinity','1e3','1.0000000001','1001',''])assert.throws(()=>parseSol(amount));
});
test('oversubscription gives proportional retained SOL and exact excess refunds',()=>{
 const r=allocation(250000000000n);assert.equal(r.total,1000000000000n);assert.equal(r.retained,125000000000n);assert.equal(r.refund,125000000000n);
 for(const amount of [1n,123456789n,99999999999n]){const a=allocation(amount);assert.equal(a.retained+a.refund,amount);assert(a.retained<=amount);}
 const below=allocation(100n,50n,200n);assert.equal(below.retained,100n);assert.equal(below.refund,0n);assert.equal(below.filled,false);
});
test('commit, settle and refund persist as separate idempotent demo phases',()=>{
 const s=new DemoStore();let revision=0;
 const act=(action,payload={})=>{const r=s.apply({requestId:'test-request-'+revision,revision,action,payload});revision=r.revision;return r;};
 try{act('prelaunch-commit',{amount:'10'});act('prelaunch-commit',{amount:'5'});const closed=act('prelaunch-settle').prelaunch;
 assert.equal(closed.committed,'15000000000');assert.equal(BigInt(closed.accepted)+BigInt(closed.refund),15000000000n);
 assert.throws(()=>act('prelaunch-commit',{amount:'1'}),/closed/);assert.equal(act('prelaunch-refund').prelaunch.refundClaimed,true);assert.throws(()=>act('prelaunch-refund'),/No demo refund/);
 }finally{s.close();}
});
test('owner demo posts reject executable URLs and preserve text as data',()=>{
 const s=new DemoStore();try{
 assert.throws(()=>s.apply({requestId:'post-unsafe',revision:0,action:'coin-post',payload:{text:'hello',url:'javascript:alert(1)'}}),/HTTPS/);
 const r=s.apply({requestId:'post-safe',revision:0,action:'coin-post',payload:{text:'<script>text only</script>',url:'https://x.com/example/status/1'}});assert.equal(r.coinPosts[0].text,'<script>text only</script>');assert.equal(r.coinPosts.length,1);
 assert.throws(()=>s.apply({requestId:'profile-bad',revision:1,action:'coin-profile',payload:{description:'test',banner:'https://unknown/image.svg',logo:''}}),/PNG/);
 }finally{s.close();}
});
test('optional featured video persists, can be removed, and rejects unsafe media',()=>{
 const s=new DemoStore();let revision=0;const save=video=>{const r=s.apply({requestId:'featured-video-'+revision,revision,action:'coin-profile',payload:{description:'coin',banner:'',logo:'',video}});revision=r.revision;return r;};
 try{for(const video of ['javascript:alert(1)','https://example.com/page','data:text/html;base64,AAAA','https://user:pass@example.com/v.mp4'])assert.throws(()=>save(video));
 assert.equal(save('https://example.com/intro.mp4').coinProfile.video,'https://example.com/intro.mp4');assert.equal(s.read().coinProfile.video,'https://example.com/intro.mp4');
 assert.equal(save('data:video/webm;base64,AAAA').coinProfile.video,'data:video/webm;base64,AAAA');assert.equal(save('').coinProfile.video,'');
 }finally{s.close();}
});
