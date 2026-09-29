import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createServer} from 'node:net';import {PublicKey} from '@solana/web3.js';
import {AMM_CONFIG_TIERS,RAYDIUM_CPMM} from '../protocol-v2/client.mjs';
import {validateScaleConfigDump,requireUnusedScalePort} from '../start-scale-rehearsal.mjs';
function fixture(){const tier=AMM_CONFIG_TIERS[1],[,bump]=PublicKey.findProgramAddressSync([Buffer.from('amm_config'),Buffer.from([0,tier.index])],RAYDIUM_CPMM),data=Buffer.alloc(236);createHash('sha256').update('account:AmmConfig').digest().copy(data,0,0,8);data[8]=bump;data.writeUInt16LE(tier.index,10);data.writeBigUInt64LE(25000n,12);data.writeBigUInt64LE(120000n,20);data.writeBigUInt64LE(40000n,28);return {pubkey:String(tier.address),account:{owner:String(RAYDIUM_CPMM),executable:false,data:[data.toString('base64'),'base64']}};}
test('capacity bootstrap pins the new AMM fee tier, owner, PDA, discriminator and enabled creation',()=>{
 const good=fixture();assert.match(validateScaleConfigDump(good),/^[a-f0-9]{64}$/);
 for(const mutate of [x=>x.pubkey='11111111111111111111111111111111',x=>x.account.owner=x.pubkey,x=>x.account.executable=true,x=>x.account.data[1]='base58',...[[0,1],[8,0],[9,1],[10,2],[12,0],[20,0],[28,0]].map(([offset,value])=>x=>{const b=Buffer.from(x.account.data[0],'base64');b[offset]=value;x.account.data[0]=b.toString('base64');})]){const bad=structuredClone(good);mutate(bad);assert.throws(()=>validateScaleConfigDump(bad));}
});
test('capacity bootstrap never adopts an existing listening RPC',async()=>{
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;try{await assert.rejects(requireUnusedScalePort(port),/occupied/);}finally{await new Promise(r=>server.close(r));}await requireUnusedScalePort(port);
});
