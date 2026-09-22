import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const base='http://localhost:4175',runId=Date.now();
async function client(){
 let cookie='',csrf='';
 async function request(path,body,extra={}){
  const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:base,...(body?{'Content-Type':'application/json','X-Kids-CSRF':csrf}:{}),...(cookie?{Cookie:cookie}:{}),...extra},body:body?JSON.stringify(body):undefined});
  const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const result=await r.json();if(!r.ok)throw Error(result.error||result.detail);return result;
 }
 const session=await request('/api/account/state');csrf=session.csrf;
 return {request};
}
const admin=await client(),a=await client(),b=await client();
const state=await admin.request('/api/admin/state'),adminHeaders={'X-Kids-CSRF':state.csrf};
const health=await admin.request('/api/admin/health');assert.equal(health.mints.length,4);
for(const [client,identity,name,art] of [[a,'alice','Local Shart','sprout'],[b,'bob','Local Toot','miso']]){
 const login=await client.request('/api/account/local',{identity});
 assert.equal(login.owner,state.config.wallets[identity]);
 const own=await client.request('/api/account/state');
 
 const input={requestId:randomUUID(),revision:own.account.revision,action:'submit',payload:{draft:{a:'Fartcoin',b:'Buttcoin',name:name+' '+runId,ticker:identity==='alice'?'LSHART':'LTOOT',description:'Localnet launch-flow verification coin.',art:'/assets/'+art+'.png',rights:true}}};
 const result=await client.request('/api/account/action',input);
 const retry=await client.request('/api/account/action',input);assert.equal(retry.proposal.id,result.proposal.id);
 await admin.request('/api/admin/moderate',{owner:login.owner,id:result.proposal.id,version:result.proposal.version,status:'Approved for next round'},adminHeaders);
}
const roundId='verify-'+Date.now();
const round=await admin.request('/api/admin/round/open',{id:roundId,durationMinutes:1},adminHeaders);assert.equal(round.snapshot.source,'solana-localnet-rpc');assert.equal(round.candidates.length,2);
await new Promise(resolve=>setTimeout(resolve,1200));
let count=0;
for(const client of [a,b]){
 const challenge=await client.request('/api/account/vote/challenge',{round:roundId,proposalHash:round.candidates[0].hash});
 const receipt=await client.request('/api/account/vote/accept',{id:challenge.id,local:true});assert.equal(receipt.outcome.proposalHash,round.candidates[0].hash);count++;
}
const publicRounds=await a.request('/api/account/rounds');const tally=publicRounds.find(r=>r.id===roundId).tally;assert.equal(tally.quorum,true);assert.equal(tally.turnoutRaw,'2000000000000');
console.log(JSON.stringify({network:'localnet',verifiedMints:health.mints.length,round:roundId,approvedCandidates:round.candidates.length,signedVotes:count,turnoutRaw:tally.turnoutRaw,quorum:tally.quorum,closesAt:round.closesAt},null,2));
