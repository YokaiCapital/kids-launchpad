import test from 'node:test';import assert from 'node:assert/strict';
import {exactDecimal,compactDecimal,solAmount,tokenAmount,percentOfBps,percentOf,shortAddress,formatLocal,freshness} from '../src/public/campaign-adapter.mjs';

test('exactDecimal never rounds and trims trailing zeros',()=>{
 assert.equal(exactDecimal('143200000000',9),'143.2');
 assert.equal(exactDecimal('1',9),'0.000000001');
 assert.equal(exactDecimal('0',9),'0');
 assert.equal(exactDecimal('1234567890123456',6),'1,234,567,890.123456');
 assert.equal(exactDecimal('-2500000000',9),'-2.5');
 assert.throws(()=>exactDecimal('1.5',9),/integer decimal string/);
});
test('compactDecimal: K/M/B/T with one decimal, thousands separators below, bounded tiny values',()=>{
 assert.equal(compactDecimal('12345678.9'),'12.3M');
 assert.equal(compactDecimal('763900'),'763.9K');
 assert.equal(compactDecimal('1234.56'),'1,234.56');
 assert.equal(compactDecimal('1000000000000'),'1T');
 assert.equal(compactDecimal('0.00004'),'<0.0001');
 assert.equal(compactDecimal('0.0225'),'0.0225');
 assert.equal(compactDecimal('0'),'0');
 assert.equal(compactDecimal('0.000'),'0');
});
test('solAmount keeps four decimals under 1 SOL and two above; exact is always available',()=>{
 assert.deepEqual(solAmount('143200000000'),{compact:'143.2',exact:'143.2',unit:'SOL',lamports:'143200000000'});
 assert.equal(solAmount('22500000').compact,'0.0225');
 assert.equal(solAmount('3490123456').compact,'3.49');
 assert.equal(solAmount('3490123456').exact,'3.490123456');
});
test('tokenAmount uses the mint decimals and the coin symbol',()=>{
 const t=tokenAmount('12300000000000',6,'EX');assert.equal(t.compact,'12.3M');assert.equal(t.exact,'12,300,000');assert.equal(t.unit,'EX');
});
test('percent helpers',()=>{
 assert.equal(percentOfBps(4850),'48.5%');assert.equal(percentOfBps(300),'3%');assert.equal(percentOfBps(250),'2.5%');assert.equal(percentOfBps(null),'—');
 assert.equal(percentOf('143200000000','100000000000'),143.2);assert.equal(percentOf('5','0'),0);
});
test('shortAddress and local time label',()=>{
 assert.equal(shortAddress('FixtureCampaignPebble1111111111111111111111'),'Fixtu…1111');assert.equal(shortAddress('abc'),'abc');assert.equal(shortAddress(null),'');
 assert.match(formatLocal(1790000000),/\d{1,2} \w{3} \d{4}, \d{2}:\d{2} local/);assert.equal(formatLocal(NaN),'');
});
test('freshness: quiet age label, clear stale label past the threshold, unknown when never fetched',()=>{
 assert.deepEqual(freshness({fetchedAtUnix:1000,nowUnix:1008}),{ageSeconds:8,stale:false,unknown:false,label:'Updated 8s ago'});
 assert.equal(freshness({fetchedAtUnix:1000,nowUnix:1200,staleAfterSeconds:60}).label,'Stale · updated 3 min ago');
 assert.equal(freshness({fetchedAtUnix:1000,nowUnix:1200,staleAfterSeconds:60}).stale,true);
 assert.equal(freshness({fetchedAtUnix:null,nowUnix:5}).label,'Not updated yet');
 assert.equal(freshness({fetchedAtUnix:0,nowUnix:90000}).label,'Stale · updated 1 d ago');
});
