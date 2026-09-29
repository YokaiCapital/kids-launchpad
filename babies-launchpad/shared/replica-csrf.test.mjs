import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createReplicaCsrf} from './replica-csrf.mjs';
test('CSRF tokens work across replicas with the same secret, expire, and reject different origins or keys',()=>{
 let now=1790000000000;const secret=randomBytes(32).toString('hex');
 const a=createReplicaCsrf({secret,clock:()=>now}),b=createReplicaCsrf({secret,clock:()=>now}),other=createReplicaCsrf({secret:randomBytes(32).toString('hex'),clock:()=>now});
 const token=a.issue('https://kids.test');assert.equal(b.verify(token,'https://kids.test'),true);
 assert.equal(b.verify(token,'https://evil.test'),false);assert.equal(other.verify(token,'https://kids.test'),false);
 assert.equal(b.verify('0.'+token.split('.')[1],'https://kids.test'),false);
 assert.equal(b.verify(token+'a','https://kids.test'),false);
 now+=7200001;assert.equal(b.verify(token,'https://kids.test'),false);
 assert.throws(()=>createReplicaCsrf({secret:'short'}),/KIDS_CSRF_SECRET/);
});
