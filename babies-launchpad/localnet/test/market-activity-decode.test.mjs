// Activity decoder gates: the real mainnet history of the first test campaign (fixtures/market/activity/README.md)
// decodes to exact executed amounts; cases that never happened on mainnet (refund, dev and parent claims, Jupiter
// buy-burn, the distribution program, failed attempts, foreign campaigns, forged programs) are built from those files.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeActivity,KINDS,LAUNCH_KINDS,DISTRIBUTION_KINDS,ACTIVITY_DECODER_VERSION} from '../market/activity-decode.mjs';
import {encodeBase58} from '../../shared/solana.mjs';
const fixture=name=>JSON.parse(readFileSync(new URL('./fixtures/market/activity/'+name+'.json',import.meta.url),'utf8'));
const ID=fixture('identity');
const CAMPAIGN=ID.campaign,MINT=ID.mint,PROGRAM=ID.launchProgram,SOL='So11111111111111111111111111111111111111112';
const FARTCOIN='9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',SYSTEM='11111111111111111111111111111111';
const data=bytes=>encodeBase58(Buffer.from(bytes));
const programIx=tx=>tx.transaction.message.instructions.find(i=>i.programId===PROGRAM);
const only=(r,n=1)=>{assert.equal(r.failed,false);assert.deepEqual(r.skipped,[]);assert.equal(r.events.length,n);return r.events;};
const common=(e,kind,path,actor)=>{assert.equal(e.campaign,CAMPAIGN);assert.equal(e.kind,kind);assert.equal(e.instructionPath,path);assert.equal(e.actor,actor);assert.equal(e.failed,false);assert.equal(e.decoderVersion,ACTIVITY_DECODER_VERSION);assert.equal(e.program,kind.startsWith('vault-')?'distribution':kind==='authority-revoked'?'token':'launch');};
const KEEPER='AAuwkFNvXRimHyvdQfh7Zik9baw8W2ufSbc5cyBqsdoE',PARTICIPANT='JBjY3ETQWkJa79G1URqFsgzqxKqxWeNfNycccQLkGVgn';

test('kind tables cover every launch tag (0..11, 20..27) and distribution tag (0..5) with fixed names',()=>{
 assert.deepEqual(Object.keys(LAUNCH_KINDS).map(Number),[0,1,2,3,4,5,6,7,8,9,10,11,20,21,22,23,24,25,26,27]);
 assert.equal(LAUNCH_KINDS[11],'burn-parents-expired');assert.equal(LAUNCH_KINDS[27],'buy-burn-child');
 assert.deepEqual(Object.keys(DISTRIBUTION_KINDS).map(Number),[0,1,2,3,4,5]);
 assert.equal(new Set(KINDS).size,KINDS.length);assert.ok(KINDS.includes('authority-revoked'));
 assert.throws(()=>decodeActivity(fixture('commit'),{...ID,campaign:'short'}),/identity is incomplete: campaign/);
});
test('fixture: campaign creation and parent configuration in one legacy transaction are two events without assets',()=>{
 const [init,configure]=only(decodeActivity(fixture('campaign-init-configure'),ID),2);
 common(init,'campaign-init','0',KEEPER);assert.deepEqual(init.assets,[]);assert.equal(init.nested,false);assert.equal(init.slot,449560710);assert.equal(init.blockTimeUnix,1790128703);
 common(configure,'configure-parents','1',KEEPER);assert.deepEqual(configure.assets,[]);
 assert.equal(configure.detail,FARTCOIN+',Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump','the two parent mints, in the instruction order');
});
test('fixture: a commit records the SOL that entered the campaign, never the receipt rent or the instruction body',()=>{
 const [e]=only(decodeActivity(fixture('commit'),ID));
 common(e,'commit','0',PARTICIPANT);
 assert.deepEqual(e.assets,[{mint:'SOL',amountRaw:'1000000000',decimals:9,direction:'in',role:null,account:CAMPAIGN}]);
 const tx=fixture('commit'),i=tx.transaction.message.accountKeys.findIndex(k=>k.pubkey===CAMPAIGN);
 assert.equal(tx.meta.postBalances[i]-tx.meta.preBalances[i],1000000000,'matches the campaign balance change');
});
test('fixture: finalize (tag 2) and settle (tag 4) are recorded as state events with the fee payer as actor',()=>{
 const [f]=only(decodeActivity(fixture('finalize'),ID));common(f,'finalize','0',KEEPER);assert.deepEqual(f.assets,[]);
 const [s]=only(decodeActivity(fixture('settle'),ID));common(s,'settle','0',KEEPER);assert.deepEqual(s.assets,[]);
});
test('fixture: the launch (v0) is one event: settled SOL and the liquidity share into the pool, LP into the lock, plus two authority revocations on the child mint',()=>{
 const events=only(decodeActivity(fixture('launch'),ID),3);
 const [launch,mintAuth,freezeAuth]=events;
 common(launch,'launch','1',KEEPER);assert.equal(launch.nested,false);
 assert.deepEqual(launch.assets,[
  {mint:'SOL',amountRaw:'2000000000',decimals:9,direction:'out',role:'pool',account:'8PCBD5FXw9Za77poHpXP31uZAjnoAfF7UDHn8QgWBiee'},
  {mint:MINT,amountRaw:'435000000000000',decimals:6,direction:'out',role:'pool',account:'D2ewJqiiric6qAqEGMzx2AZ3vEQqrJpB4SiJkUPsysyK'},
  {mint:'HVLh6sAs7E7hfanDWLxFW3uheVHRmiifrBhUL1ExpJ5r',amountRaw:'932737905208',decimals:9,direction:'out',role:'lock',account:'HxaptXgkhKq3gGmXVDbzGwXJ5CmaygHpULdtuu3f4U2n'},
 ]);
 common(mintAuth,'authority-revoked','1.39',KEEPER);assert.equal(mintAuth.detail,'mintTokens');assert.equal(mintAuth.nested,true);assert.deepEqual(mintAuth.assets,[]);
 common(freezeAuth,'authority-revoked','1.40',KEEPER);assert.equal(freezeAuth.detail,'freezeAccount');
 // the fee NFT's own setAuthority (path 1.38, another mint) is not ours
 assert.equal(events.filter(e=>e.kind==='authority-revoked').length,2);
});
test('fixture: fee state creation has no assets; fee collection records the coin and SOL that entered custody (the LP burn inside Raydium is not ours)',()=>{
 const [init]=only(decodeActivity(fixture('fees-init'),ID));common(init,'fees-init','1',KEEPER);assert.deepEqual(init.assets,[]);
 const [c]=only(decodeActivity(fixture('fees-collect'),ID));common(c,'fees-collect','1',KEEPER);
 assert.equal(c.signature,'3sTyKZB1emztHhED8GqjAevnsFyWjRjqKYzXXPeWEntjfUFqhn39GoVfEG4ZbgFYRkGCjRCWYYGPJhMbPzVJsTWp');
 assert.deepEqual(c.assets,[
  {mint:MINT,amountRaw:'37682365',decimals:6,direction:'in',role:null,account:'D2ewJqiiric6qAqEGMzx2AZ3vEQqrJpB4SiJkUPsysyK'},
  {mint:'SOL',amountRaw:'46',decimals:9,direction:'in',role:null,account:'8PCBD5FXw9Za77poHpXP31uZAjnoAfF7UDHn8QgWBiee'},
 ]);
});
test('fixture: the retired sell (tag 22) shows coin out and SOL in; distribute shows SOL to the treasury and dev with roles',()=>{
 const [s]=only(decodeActivity(fixture('fees-sell'),ID));common(s,'fees-sell','1',KEEPER);
 assert.deepEqual(s.assets,[
  {mint:MINT,amountRaw:'680679622633',decimals:6,direction:'out',role:null,account:'D2ewJqiiric6qAqEGMzx2AZ3vEQqrJpB4SiJkUPsysyK'},
  {mint:'SOL',amountRaw:'3452881',decimals:9,direction:'in',role:null,account:'8PCBD5FXw9Za77poHpXP31uZAjnoAfF7UDHn8QgWBiee'},
 ]);
 const [d]=only(decodeActivity(fixture('fees-distribute'),ID));common(d,'fees-distribute','1',KEEPER);
 assert.deepEqual(d.assets,[
  {mint:'SOL',amountRaw:'3996882',decimals:9,direction:'out',role:'treasury',account:'Biuk5FtF7cCz418nQXF192tVJuetJyQWGyEP2b619ahd'},
  {mint:'SOL',amountRaw:'815690',decimals:9,direction:'out',role:'dev',account:'5aTjWkGay2H5sx7NjAktWUsLzrZ7kqdFzxjVRQviEpEL'},
 ]);
 const tx=fixture('fees-distribute'),post=i=>tx.meta.postTokenBalances.find(b=>b.accountIndex===i).uiTokenAmount.amount;
 assert.equal(post(4),'3996882','treasury account balance after');assert.equal(post(3),'815690','dev account balance after');
});
test('fixture: a buy-burn records the SOL that left the fee custody and the parent tokens burned (the purchase leg is the same amount and is not double counted)',()=>{
 const [b]=only(decodeActivity(fixture('buy-burn'),ID));common(b,'buy-burn','1',KEEPER);assert.equal(b.detail,'parent-0');
 assert.deepEqual(b.assets,[
  {mint:'SOL',amountRaw:'1019612',decimals:9,direction:'out',role:null,account:'5K4TcWpvNfUsJc9QeFpdm1wqsnZoyTbmTP6yi8Fh2XnL'},
  {mint:FARTCOIN,amountRaw:'6928',decimals:6,direction:'burn',role:null,account:'FFJpQ579vJC3GJkivy98YLFNfTvhgGZqfSduRV2w5HQp'},
 ]);
 const tx=fixture('buy-burn'),bal=(i,side)=>tx.meta[side+'TokenBalances'].find(b=>b.accountIndex===i).uiTokenAmount.amount;
 assert.equal(BigInt(bal(2,'pre'))-BigInt(bal(2,'post')),1019612n,'fee WSOL custody paid exactly the SOL');
 assert.equal(bal(8,'post'),'0','parent custody ends empty: everything bought was burned');
});
test('fixture: a participant claim is coin out of launch custody to the holder; the ATA creation in the same transaction is ignored',()=>{
 const [c]=only(decodeActivity(fixture('claim-participant'),ID));common(c,'claim-participant','1',PARTICIPANT);
 assert.deepEqual(c.assets,[{mint:MINT,amountRaw:'435000000000000',decimals:6,direction:'out',role:null,account:'4zDGh6twaxJfJCPFNXKaQhJNDNXw335o5sNZcQqXzXkG'}]);
});
test('fixture: burning the coin-side fees (tag 26) is a burn of the exact amount',()=>{
 const [b]=only(decodeActivity(fixture('burn-child'),ID));common(b,'burn-child','1',KEEPER);
 assert.equal(b.signature,'3iFTQBFjvkxGGFq397HG4NkbSGo1eRMGKkzccvSQwgsiypFyXJXHwJga3r6XL3vVimLz3D7wvrzAuzD3w4mA1YNQ');
 assert.deepEqual(b.assets,[{mint:MINT,amountRaw:'670345318218',decimals:6,direction:'burn',role:null,account:'3J8bPRku3cTzVkD8fwHfrEusamJaERYfbEtsaWFPfanb'}]);
});
// ---- synthetic cases built from the real files ----
function refundTx(delta,{twice=false}={}){
 const tx=structuredClone(fixture('commit'));const m=tx.transaction.message;
 const keys=m.accountKeys;// 0 participant (signer), 1 campaign, 2 receipt, 3 system, 4 program
 const ix={programId:PROGRAM,accounts:[CAMPAIGN,keys[2].pubkey,PARTICIPANT],data:data([3])};
 m.instructions=twice?[ix,ix]:[ix];tx.meta.innerInstructions=[];
 tx.meta.preBalances=[5000000000,2000000000,1219200,1,1];tx.meta.postBalances=[5000000000-5000+delta,2000000000-delta,1219200,1,1];
 return tx;
}
test('synthetic refund: lamports leave the campaign without a CPI, so the campaign balance delta is the amount; a zero delta is an executed no-op; two refunds in one transaction stay unpriced',()=>{
 const [r]=only(decodeActivity(refundTx(700000000),ID));common(r,'refund','0',PARTICIPANT);
 assert.deepEqual(r.assets,[{mint:'SOL',amountRaw:'700000000',decimals:9,direction:'out',role:null,account:PARTICIPANT}]);
 const [noop]=only(decodeActivity(refundTx(0),ID));assert.deepEqual(noop.assets,[]);
 const twice=decodeActivity(refundTx(700000000,{twice:true}),ID);assert.equal(twice.events.length,2);assert.deepEqual(twice.events.map(e=>e.assets),[[],[]]);assert.equal(twice.skipped.length,2);assert.match(twice.skipped[0].reason,/several refunds/);
});
test('synthetic ready check (tag 5) is a state event',()=>{
 const tx=structuredClone(fixture('finalize'));programIx(tx).data=data([5]);
 const [e]=only(decodeActivity(tx,ID));common(e,'ready','0',KEEPER);assert.deepEqual(e.assets,[]);
});
test('synthetic dev claim (tag 8): coin out of custody to the dev; a no-op claim (nothing vested) has no assets',()=>{
 const tx=structuredClone(fixture('claim-participant'));const ix=programIx(tx);const A=ix.accounts;
 ix.accounts=[A[0],A[2],A[3],A[4],A[5],A[6]];ix.data=data([8]);
 const [e]=only(decodeActivity(tx,ID));common(e,'claim-dev','1',PARTICIPANT);
 assert.deepEqual(e.assets,[{mint:MINT,amountRaw:'435000000000000',decimals:6,direction:'out',role:null,account:'4zDGh6twaxJfJCPFNXKaQhJNDNXw335o5sNZcQqXzXkG'}]);
 tx.meta.innerInstructions=tx.meta.innerInstructions.filter(i=>i.index!==1);
 const [noop]=only(decodeActivity(tx,ID));assert.deepEqual(noop.assets,[]);
});
test('synthetic parent claim (tag 10): the allocation paid out, with the parent index from the instruction',()=>{
 const tx=structuredClone(fixture('claim-participant'));const ix=programIx(tx);const A=ix.accounts;
 const parents='2XKTBBY6o7HEfZbo4goagusqNBmMJJKZJrthCmQPhTLz',claim='GxuuZhKLW3UUichLic6DiKosUG3FsZTGauqzeciDMkqB';
 ix.accounts=[PARTICIPANT,A[0],parents,claim,PARTICIPANT,A[2],A[3],A[4],A[5],A[6],SYSTEM];
 const body=Buffer.alloc(18);body[0]=1;body.writeBigUInt64LE(123n,1);body.writeBigUInt64LE(50000000000000n,9);body[17]=0;
 ix.data=data([10,...body]);
 tx.meta.innerInstructions.find(i=>i.index===1).instructions[0].parsed.info.amount='50000000000000';
 const [e]=only(decodeActivity(tx,ID));common(e,'claim-parent','1',PARTICIPANT);assert.equal(e.detail,'parent-1');
 assert.equal(e.assets[0].amountRaw,'50000000000000','the executed transfer, not the body allocation field');assert.equal(e.assets[0].direction,'out');
});
test('synthetic Jupiter buy-burn (tag 25): SOL out of custody through the route, parent burned, parent index from the body',()=>{
 const tx=structuredClone(fixture('buy-burn'));const ix=programIx(tx);const A=ix.accounts;
 const JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
 ix.accounts=[A[0],A[1],A[2],A[3],A[4],A[5],A[16],A[12],SOL,TOKEN,TOKEN,JUP,'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',A[6],A[7],A[8],A[9],A[10]];
 ix.data=data([25,0,...Buffer.alloc(24),...Buffer.alloc(40)]);
 const inner=tx.meta.innerInstructions.find(i=>i.index===1).instructions;
 inner[0]={programId:JUP,accounts:[],data:'11',stackHeight:2};// the route; its legs stay at height 3
 const [e]=only(decodeActivity(tx,ID));common(e,'buy-burn-routed','1',KEEPER);assert.equal(e.detail,'parent-0');
 assert.deepEqual(e.assets.map(a=>[a.mint,a.amountRaw,a.direction]),[['SOL','1019612','out'],[FARTCOIN,'6928','burn']]);
});
test('synthetic build-6 tag 27 (coin buyback): SOL out of the WSOL custody, the bought coins burned from the coin custody, no parent detail',()=>{
 const tx=structuredClone(fixture('buy-burn'));const ix=programIx(tx);ix.accounts=ix.accounts.slice(0,16);ix.data=data([27,...Buffer.alloc(24)]);
 const [e]=only(decodeActivity(tx,ID));common(e,'buy-burn-child','1',KEEPER);assert.equal(e.detail,null);
 assert.deepEqual(e.assets.map(a=>[a.mint,a.amountRaw,a.direction]),[['SOL','1019612','out'],[FARTCOIN,'6928','burn']]);
});
test('synthetic build-6 tag 11 (burn expired parent reserves): the burn from launch custody, no signer, actor is the fee payer',()=>{
 const tx=structuredClone(fixture('burn-child'));const ix=programIx(tx);const A=ix.accounts;ix.accounts=[A[0],A[2],A[3],A[5],A[4],A[6]];ix.data=data([11]);
 const [e]=only(decodeActivity(tx,ID));common(e,'burn-parents-expired','1',KEEPER);assert.equal(e.detail,null);
 assert.deepEqual(e.assets.map(a=>[a.mint,a.amountRaw,a.direction]),[[A[5],'670345318218','burn']]);
});
test('a failed transaction is recorded for our program with status failed and no assets, so a failed claim attempt is visible',()=>{
 const tx=structuredClone(fixture('claim-participant'));tx.meta.err={InstructionError:[1,{Custom:30}]};tx.meta.innerInstructions=[];
 const r=decodeActivity(tx,ID);assert.equal(r.failed,true);assert.deepEqual(r.skipped,[]);assert.equal(r.events.length,1);
 const [e]=r.events;assert.equal(e.kind,'claim-participant');assert.equal(e.failed,true);assert.deepEqual(e.assets,[]);assert.equal(e.actor,PARTICIPANT);assert.equal(e.instructionPath,'1');
 const launch=structuredClone(fixture('launch'));launch.meta.err={InstructionError:[1,{Custom:21}]};
 const rl=decodeActivity(launch,ID);assert.equal(rl.events.length,1,'no authority events for a failed launch');assert.equal(rl.events[0].kind,'launch');assert.equal(rl.events[0].failed,true);
});
test('binding: another campaign, a forged program id with our tag, an unknown tag and empty data produce nothing; unsupported versions are reported',()=>{
 assert.deepEqual(decodeActivity(fixture('commit'),{...ID,campaign:'Campaign1111111111111111111111111111111111'}).events,[]);
 const forged=structuredClone(fixture('commit'));programIx(forged).programId='Forge11111111111111111111111111111111111111';assert.deepEqual(decodeActivity(forged,ID).events,[]);
 const unknown=structuredClone(fixture('commit'));programIx(unknown).data=data([99]);assert.deepEqual(decodeActivity(unknown,ID).events,[]);
 const empty=structuredClone(fixture('commit'));programIx(empty).data='';assert.deepEqual(decodeActivity(empty,ID).events,[]);
 const v2=decodeActivity({...fixture('commit'),version:2},ID);assert.equal(v2.unsupported,true);assert.deepEqual(v2.events,[]);
 assert.deepEqual(decodeActivity(null,ID).skipped,[{path:null,reason:'no transaction'}]);
});
// ---- distribution program (vault campaigns): no mainnet history yet, so the shapes follow the program's account orders ----
const DIST='D1stributionProgram111111111111111111111111',DISTRIBUTION='D1stributionRecord11111111111111111111111111';
const VID={...ID,distributionProgram:DIST,distribution:DISTRIBUTION};
const vaults=['Vau1t0111111111111111111111111111111111111','Vau1t1111111111111111111111111111111111111','Vau1t2111111111111111111111111111111111111','Vau1t3111111111111111111111111111111111111'];
const auths=['Auth0111111111111111111111111111111111111','Auth1111111111111111111111111111111111111','Auth2111111111111111111111111111111111111','Auth3111111111111111111111111111111111111'];
const transfer=(source,destination,amount,height,authority=ID.launchAuthority)=>({programId:TOKEN,program:'spl-token',stackHeight:height,parsed:{type:'transfer',info:{source,destination,amount,authority}}});
const burn=(account,mint,amount,height)=>({programId:TOKEN,program:'spl-token',stackHeight:height,parsed:{type:'burn',info:{account,mint,amount,authority:auths[0]}}});
test('synthetic vault activation nested inside the launch: four vault transfers (role vault) and a donation burn, bound by the campaign account',()=>{
 const tx=structuredClone(fixture('launch'));const ix=programIx(tx);const custody=ix.accounts[4];
 ix.accounts.push(DIST,'2XKTBBY6o7HEfZbo4goagusqNBmMJJKZJrthCmQPhTLz',DISTRIBUTION,...auths,...vaults);
 const inner=tx.meta.innerInstructions.find(i=>i.index===1).instructions;
 inner.push({programId:DIST,accounts:[ID.launchAuthority,KEEPER,CAMPAIGN,'2XKTBBY6o7HEfZbo4goagusqNBmMJJKZJrthCmQPhTLz',MINT,custody,DISTRIBUTION,...auths,...vaults,TOKEN,SYSTEM],data:data([0,...Buffer.alloc(32)]),stackHeight:2},
  burn(vaults[1],MINT,'5',3),transfer(custody,vaults[0],'435000000000000',3),transfer(custody,vaults[1],'50000000000000',3),transfer(custody,vaults[2],'50000000000000',3),transfer(custody,vaults[3],'30000000000000',3));
 const r=decodeActivity(tx,VID);assert.deepEqual(r.skipped,[]);
 const activate=r.events.find(e=>e.kind==='vault-activate');assert.ok(activate);assert.equal(activate.nested,true);assert.equal(activate.instructionPath,'1.41');assert.equal(activate.program,'distribution');assert.equal(activate.actor,KEEPER);
 assert.deepEqual(activate.assets.map(a=>[a.direction,a.role,a.amountRaw,a.account]),[['out','vault','435000000000000',vaults[0]],['out','vault','50000000000000',vaults[1]],['out','vault','50000000000000',vaults[2]],['out','vault','30000000000000',vaults[3]],['burn',null,'5',vaults[1]]]);
 const launch=r.events.find(e=>e.kind==='launch');assert.equal(launch.assets.length,3,'the vault transfers out of custody do not count as pool liquidity');
 assert.equal(decodeActivity(tx,ID).events.find(e=>e.kind==='vault-activate'),undefined,'a campaign without a distribution program never reports one');
 const noHeights=structuredClone(tx);for(const x of noHeights.meta.innerInstructions[0].instructions)x.stackHeight=null;
 const rn=decodeActivity(noHeights,VID);assert.equal(rn.events.find(e=>e.kind==='vault-activate'),undefined);assert.ok(rn.skipped.some(s=>/stack heights/.test(s.reason)));
});
function distributionTx(tag,accounts,inner,dataBytes=[tag]){
 const tx=structuredClone(fixture('finalize'));const m=tx.transaction.message;
 m.accountKeys=[{pubkey:PARTICIPANT,signer:true,writable:true},...accounts.filter(a=>a!==PARTICIPANT).map(pubkey=>({pubkey,signer:false,writable:true})),{pubkey:DIST,signer:false,writable:false}];
 m.instructions=[{programId:DIST,accounts,data:data(dataBytes)}];tx.meta.innerInstructions=[{index:0,instructions:inner}];
 tx.meta.preBalances=m.accountKeys.map(()=>1);tx.meta.postBalances=m.accountKeys.map(()=>1);tx.meta.preTokenBalances=[];tx.meta.postTokenBalances=[];
 return tx;
}
test('synthetic distribution claims, expiry burn and sweep bind by the distribution record and read the vault movements',()=>{
 const dest='Dest1111111111111111111111111111111111111111';
 const p=distributionTx(1,[PARTICIPANT,DISTRIBUTION,'GxuuZhKLW3UUichLic6DiKosUG3FsZTGauqzeciDMkqB','C1aim111111111111111111111111111111111111',MINT,auths[0],vaults[0],dest,TOKEN,SYSTEM],[transfer(vaults[0],dest,'1000000',2,auths[0])]);
 const [pc]=only(decodeActivity(p,VID));common(pc,'vault-claim-participant','0',PARTICIPANT);assert.deepEqual(pc.assets,[{mint:MINT,amountRaw:'1000000',decimals:6,direction:'out',role:null,account:dest}]);
 const body=Buffer.alloc(18);body[0]=1;body.writeBigUInt64LE(9n,1);body.writeBigUInt64LE(777n,9);
 const par=distributionTx(2,[PARTICIPANT,DISTRIBUTION,'C1aim111111111111111111111111111111111111',MINT,auths[2],vaults[2],dest,TOKEN,SYSTEM],[transfer(vaults[2],dest,'777',2,auths[2])],[2,...body]);
 const [pp]=only(decodeActivity(par,VID));common(pp,'vault-claim-parent','0',PARTICIPANT);assert.equal(pp.detail,'parent-1');assert.equal(pp.assets[0].amountRaw,'777');
 const dev=distributionTx(3,[PARTICIPANT,DISTRIBUTION,MINT,auths[3],vaults[3],dest,TOKEN],[transfer(vaults[3],dest,'10',2,auths[3])]);
 const [dc]=only(decodeActivity(dev,VID));common(dc,'vault-claim-dev','0',PARTICIPANT);assert.equal(dc.assets[0].amountRaw,'10');
 const expired=distributionTx(4,[DISTRIBUTION,MINT,auths[1],vaults[1],TOKEN],[burn(vaults[1],MINT,'50000000000000',2)],[4,0]);
 const [be]=only(decodeActivity(expired,VID));common(be,'vault-burn-expired','0',PARTICIPANT);assert.equal(be.detail,'parent-0');assert.deepEqual(be.assets,[{mint:MINT,amountRaw:'50000000000000',decimals:6,direction:'burn',role:null,account:vaults[1]}]);
 const sweep=distributionTx(5,[DISTRIBUTION,MINT,auths[0],vaults[0],TOKEN],[],[5,0]);
 const [sw]=only(decodeActivity(sweep,VID));common(sw,'vault-sweep','0',PARTICIPANT);assert.equal(sw.detail,'purpose-0');assert.deepEqual(sw.assets,[],'a sweep with nothing above the owed balance executes nothing');
 const other=distributionTx(1,[PARTICIPANT,'Other111111111111111111111111111111111111111','GxuuZhKLW3UUichLic6DiKosUG3FsZTGauqzeciDMkqB','C1aim111111111111111111111111111111111111',MINT,auths[0],vaults[0],dest,TOKEN,SYSTEM],[]);
 assert.deepEqual(decodeActivity(other,VID).events,[],'another campaign\'s distribution record is ignored');
});
