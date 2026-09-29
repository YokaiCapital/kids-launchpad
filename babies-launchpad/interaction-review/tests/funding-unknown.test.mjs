import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptedForOpeningEstimate} from '../src/public/campaign-adapter.mjs';
test('opening estimates preserve unavailable funding and settled amounts, and cap only provisional totals',()=>{
 assert.equal(acceptedForOpeningEstimate({acceptedLamports:null,committedLamports:null},'5000000000'),null);
 assert.equal(acceptedForOpeningEstimate({acceptedLamports:'0',committedLamports:null},'5000000000'),'0');
 assert.equal(acceptedForOpeningEstimate({acceptedLamports:'3000000000',committedLamports:'6000000000'},'5000000000'),'3000000000');
 assert.equal(acceptedForOpeningEstimate({acceptedLamports:null,committedLamports:'6000000000'},'5000000000'),'5000000000');
 assert.equal(acceptedForOpeningEstimate({acceptedLamports:null,committedLamports:'1000000000'},'5000000000'),'1000000000');
});
