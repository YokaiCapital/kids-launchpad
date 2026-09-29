import test from 'node:test';import assert from 'node:assert/strict';
import {DEFAULT_SLIPPAGE_BPS,parseSlippagePercent,formatSlippage,loadSlippageBps,saveSlippageBps,minimumOut,validSlippageBps,STORAGE_KEY} from '../src/slippage.mjs';
const mem=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v))};};
test('default is 10 % only when no preference exists; a stored preference wins; bad storage falls back',()=>{
 assert.equal(DEFAULT_SLIPPAGE_BPS,1000);assert.equal(loadSlippageBps(mem()),1000);assert.equal(loadSlippageBps(null),1000);
 const s=mem();assert.equal(saveSlippageBps(s,250),true);assert.equal(loadSlippageBps(s),250);s.setItem(STORAGE_KEY,'nonsense');assert.equal(loadSlippageBps(s),1000);
 assert.equal(loadSlippageBps({getItem(){throw Error('blocked');}}),1000);assert.equal(saveSlippageBps(s,0),false);assert.equal(saveSlippageBps(s,6000),false);
});
test('percent text converts with strict validation',()=>{
 assert.equal(parseSlippagePercent('10'),1000);assert.equal(parseSlippagePercent('2.5'),250);assert.equal(parseSlippagePercent('0.05'),5);assert.equal(parseSlippagePercent('0,5'),50);
 for(const bad of ['','abc','-1','0','0.001','50.01','1e3','NaN','Infinity','100',null,undefined,5])assert.equal(parseSlippagePercent(bad),null,String(bad));
 assert.equal(formatSlippage(1000),'10%');assert.equal(formatSlippage(250),'2.5%');assert.equal(validSlippageBps(5000),true);assert.equal(validSlippageBps(5001),false);
});
test('minimum received uses integer maths at the chosen slippage',()=>{
 assert.equal(minimumOut('1000000',1000),900000n);assert.equal(minimumOut('999',100),989n);assert.equal(minimumOut('7',5000),3n);
});
