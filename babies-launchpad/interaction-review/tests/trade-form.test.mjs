import test from 'node:test';import assert from 'node:assert/strict';import {parseTradeAmount} from '../src/public/trade-form.mjs';
test('trade input preserves exact smallest units and rejects rounding, negatives, scientific notation and u64 overflow',()=>{
 assert.equal(parseTradeAmount('0.000000001',9),'1');assert.equal(parseTradeAmount('.000001',6),'1');assert.equal(parseTradeAmount('10',2),'1000');assert.equal(parseTradeAmount('18446744073.709551615',9),'18446744073709551615');
 for(const value of ['0','-1','1e3','1,000','0.0000000001','18446744073.709551616','','.','Infinity','0x20'])assert.equal(parseTradeAmount(value,9),null,value);
 assert.equal(parseTradeAmount('0.0000001',6),null);assert.equal(parseTradeAmount('1',null),null);assert.equal(parseTradeAmount('1',18),null);
});
