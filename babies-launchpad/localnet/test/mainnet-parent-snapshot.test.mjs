// FIXTURES ONLY: every mint, account, owner and RPC reply is invented. No network, no credential.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,statSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Keypair,PublicKey,SystemProgram} from '@solana/web3.js';import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ExtensionType} from '@solana/spl-token';
import {readParentSnapshot,readParentSnapshotOnce,readParentMint,decodeTokenAccount,meetsThreshold,programThreshold,parseRawAmount,writeParentSnapshotEvidence,createHeliusDasClient,publicParentSnapshot,MAINNET_GENESIS,DAS_PAGE_SIZE,loadExclusions,applyOwnerCap,finalizeParentAllocation,PER_OWNER_CAP_BPS,custodialSignals,withReadRetries,rpcCall,classifyFailure,classifyResponse,ReadFailure,sanitize} from '../mainnet-parent-snapshot.mjs';
import {parentTree,parentLeaf} from '../atomic-claims.mjs';
import {createHash} from 'node:crypto';
const MINT_A=Keypair.generate().publicKey.toBase58(),MINT_B=Keypair.generate().publicKey.toBase58(),CAMPAIGN=Keypair.generate().publicKey.toBase58();
const wallet=()=>Keypair.generate().publicKey.toBase58(),pda=seed=>PublicKey.findProgramAddressSync([Buffer.from(seed)],SystemProgram.programId)[0].toBase58();
const SUPPLY=1_000_000_000_000n; // 1M tokens at 6 decimals; floor = 500_000_000 raw
const FLOOR=SUPPLY/2000n;
function mintBytes(supply,{token2022=false,extensions=[]}={}){const b=Buffer.alloc(token2022?166:82);b.writeUInt32LE(0,0);b.writeBigUInt64LE(supply,36);b[44]=6;b[45]=1;b.writeUInt32LE(0,46);if(!token2022)return b;b[165]=1;const tlv=[];for(const [type,data] of extensions){const h=Buffer.alloc(4);h.writeUInt16LE(type,0);h.writeUInt16LE(data.length,2);tlv.push(h,data);}return Buffer.concat([b,...tlv]);}
function accountBytes(mint,owner,amount,{frozen=false,token2022=false,extensions=[]}={}){const b=Buffer.alloc(165);new PublicKey(mint).toBuffer().copy(b,0);new PublicKey(owner).toBuffer().copy(b,32);b.writeBigUInt64LE(amount,64);b[108]=frozen?2:1;if(!token2022)return b;const tlv=[Buffer.from([2])];for(const [type,data] of extensions){const h=Buffer.alloc(4);h.writeUInt16LE(type,0);h.writeUInt16LE(data.length,2);tlv.push(h,data);}return Buffer.concat([b,...tlv]);}
/** Fake chain: mints and token accounts by address; slots advance per call. */
function chain({mint=MINT_A,supply=SUPPLY,token2022=false,mintExtensions=[],accounts={},slots=[100,101,102,103,104,105,106,107],genesis=MAINNET_GENESIS,supplyAfter=null}={}){
 let calls=0,mintReads=0;const program=token2022?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
 return {calls:()=>calls,async getGenesisHash(){return genesis;},async getSlot(){return slots[Math.min(calls++,slots.length-1)];},
  async getAccountInfo(address){if(address.toBase58()!==mint)return null;mintReads+=1;return {owner:program,data:mintBytes(supplyAfter!==null&&mintReads>1?supplyAfter:supply,{token2022,extensions:mintExtensions}),executable:false,lamports:1};},
  async getMultipleAccountsInfoAndContext(addresses,config){assert.equal(config.commitment,'finalized');const slot=Math.max(config.minContextSlot,slots.at(-1));return {context:{slot},value:addresses.map(a=>{const row=accounts[a.toBase58()];return row?{owner:row.program??program,data:row.data,executable:false,lamports:1}:null;})};}};
}
function das(rows,{pageSize=DAS_PAGE_SIZE,failAt=null,loop=false}={}){let calls=0;return {calls:()=>calls,async getTokenAccounts({mint,limit,cursor}){calls+=1;if(failAt!==null&&calls>=failAt)throw Error('fixture DAS outage');const start=cursor===undefined?0:Number(cursor);const size=Math.min(limit,pageSize);const slice=rows.slice(start,start+size).map(r=>({...r,mint}));const more=start+size<rows.length;return {total:rows.length,limit:size,cursor:loop?'0':more?String(start+size):null,token_accounts:slice};}};}
const row=(address,owner,amount)=>({address,owner,amount:amount.toString(),frozen:false});
/** Builds a consistent fixture where the index and the chain agree unless overridden. */
function world(holders,opts={}){const rows=[],accounts={};for(const h of holders){for(const [address,amount] of h.accounts){rows.push(row(address,h.owner,amount));accounts[address]={data:accountBytes(opts.mint??MINT_A,h.owner,h.chainAmount??amount,{frozen:h.frozen,token2022:opts.token2022,extensions:h.extensions??[]})};}}return {rows,accounts};}
const addr=()=>Keypair.generate().publicKey.toBase58();

test('threshold rule is exact and equals the program formula at the boundary',()=>{for(const supply of [SUPPLY,999_939_456_371_879n,7n,2000n,2001n]){const t=programThreshold(supply);assert.equal(meetsThreshold(t,supply),true);assert.equal(meetsThreshold(t-1n,supply),false);assert.equal(t*2000n>=supply&&(t-1n)*2000n<supply,true);}assert.equal(parseRawAmount('12',''),12n);assert.throws(()=>parseRawAmount('1.5',''));assert.throws(()=>parseRawAmount(-1,''));});

test('fragmented holdings aggregate by owner; exact floor kept, one unit below dropped; program-owned, incinerator and frozen excluded',async()=>{
 const whale=wallet(),fragments=wallet(),edge=wallet(),under=wallet(),vault=pda('vault'),frozen=wallet();
 const w=world([{owner:whale,accounts:[[addr(),FLOOR*10n]]},{owner:fragments,accounts:[[addr(),FLOOR/2n],[addr(),FLOOR/4n],[addr(),FLOOR/4n]]},{owner:edge,accounts:[[addr(),FLOOR]]},{owner:under,accounts:[[addr(),FLOOR-1n]]},{owner:vault,accounts:[[addr(),FLOOR*100n]]},{owner:'1nc1nerator11111111111111111111111111111111',accounts:[[addr(),FLOOR*3n]]},{owner:frozen,accounts:[[addr(),FLOOR*2n]],frozen:true}]);
 const r=await readParentSnapshot(chain({accounts:w.accounts}),das(w.rows,{pageSize:2}),MINT_A,{passes:2});
 assert.deepEqual(r.balances.map(b=>b.owner).sort(),[whale,fragments,edge].sort());assert.equal(r.balances.find(b=>b.owner===fragments).balance,FLOOR);
 assert.equal(r.offCurveOwners,1);assert.equal(r.excludedOwners,1);assert.equal(r.frozenAccounts,1);assert.equal(r.belowFloorOwners,1);assert.equal(r.tokenProgram,'spl-token');assert.equal(r.passes,2);assert.equal(r.nominationPasses.length,2);assert.equal(r.pages>=4,true);
});

test('duplicate index rows count once, a looping cursor is refused, an outage mid-read throws and writes nothing',async()=>{
 const o=wallet(),a=addr();const w=world([{owner:o,accounts:[[a,FLOOR]]}]);const rows=[...w.rows,...w.rows];
 const r=await readParentSnapshotOnce(chain({accounts:w.accounts}),das(rows,{pageSize:1}),MINT_A);assert.equal(r.duplicateRows,1);assert.equal(r.balances[0].balance,FLOOR);
 await assert.rejects(readParentSnapshotOnce(chain({accounts:w.accounts}),das(rows,{pageSize:1,loop:true}),MINT_A),/did not terminate/);
 const dir=mkdtempSync(join(tmpdir(),'kids-snap-'));await assert.rejects(readParentSnapshot(chain({accounts:w.accounts}),das(rows,{pageSize:1,failAt:2}),MINT_A).then(x=>writeParentSnapshotEvidence(dir,CAMPAIGN,x)),/outage/);assert.equal(statSync(dir).isDirectory()&&!readdirLength(join(dir,CAMPAIGN)),true);
});
function readdirLength(p){try{return readdirSync(p).length;}catch{return 0;}}

test('slot drift, supply change during the read and wrong genesis are refused; an owner missed by one pass is still nominated by the union',async()=>{
 const o=wallet();const w=world([{owner:o,accounts:[[addr(),FLOOR]]}]);
 await assert.rejects(readParentSnapshotOnce(chain({accounts:w.accounts,slots:[100,20000]}),das(w.rows),MINT_A),/too many slots/);
 await assert.rejects(readParentSnapshotOnce(chain({accounts:w.accounts,supplyAfter:SUPPLY-1n}),das(w.rows),MINT_A),/changed during the read/);
 const over=await readParentSnapshotOnce(chain({accounts:w.accounts}),das([...w.rows,row(addr(),o,SUPPLY)]),MINT_A);assert.equal(over.indexOverSupplyRaw,FLOOR);assert.deepEqual(over.balances,[{owner:o,balance:FLOOR}]);assert.equal(over.staleAccounts,1);
 await assert.rejects(readParentSnapshotOnce(chain({accounts:w.accounts,genesis:'BdKFesSjNS8AMEvF1VWjs5946Nh6Vn2PK3EcSFuJRobW'}),das(w.rows),MINT_A),/not the expected network/);
 let pass=0;const shifting={async getTokenAccounts(p){if(p.cursor===undefined)pass+=1;return das(pass===1?w.rows:[],{}).getTokenAccounts(p);}};
 const u=await readParentSnapshot(chain({accounts:w.accounts}),shifting,MINT_A,{passes:2,concurrentPasses:false});assert.deepEqual(u.balances,[{owner:o,balance:FLOOR}]);assert.equal(u.candidateOwnersOnlyInSomePasses,1);assert.equal(u.candidateOwnersUnion,1);
});

test('the index nominates, the chain decides: stale accounts dropped, chain amounts override index amounts, floor re-applied on verified totals',async()=>{
 const gone=wallet(),shrunk=wallet(),ok=wallet();
 const w=world([{owner:gone,accounts:[[addr(),FLOOR*5n]]},{owner:shrunk,accounts:[[addr(),FLOOR*5n]],chainAmount:FLOOR-1n},{owner:ok,accounts:[[addr(),FLOOR*2n]],chainAmount:FLOOR*3n}]);
 for(const address of Object.keys(w.accounts))if(w.accounts[address].data.subarray(32,64).equals(new PublicKey(gone).toBuffer()))delete w.accounts[address];
 const r=await readParentSnapshotOnce(chain({accounts:w.accounts}),das(w.rows),MINT_A);
 assert.deepEqual(r.balances,[{owner:ok,balance:FLOOR*3n}]);assert.equal(r.staleAccounts,1);assert.equal(r.verifiedAccounts,2);assert.ok(r.readBackContextSlots.min>=r.slotAfter);
});

test('Token-2022: metadata extensions allowed, transfer-fee or hook mints refused clearly, holder accounts with withheld fees or unknown extensions excluded',async()=>{
 const o=wallet(),plain=addr(),withheld=addr(),hooked=addr();
 const w=world([{owner:o,accounts:[[plain,FLOOR*2n]],extensions:[[ExtensionType.ImmutableOwner,Buffer.alloc(0)]]}],{token2022:true,mint:MINT_B});
 w.rows.push(row(withheld,o,FLOOR),row(hooked,o,FLOOR));
 w.accounts[withheld]={data:accountBytes(MINT_B,o,FLOOR,{token2022:true,extensions:[[ExtensionType.TransferFeeAmount,(()=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(5n);return b;})()]]})};
 w.accounts[hooked]={data:accountBytes(MINT_B,o,FLOOR,{token2022:true,extensions:[[ExtensionType.TransferHookAccount,Buffer.alloc(1)]]})};
 const meta=[[ExtensionType.MetadataPointer,Buffer.alloc(64)]];
 const r=await readParentSnapshotOnce(chain({mint:MINT_B,accounts:w.accounts,token2022:true,mintExtensions:meta}),das(w.rows),MINT_B);
 assert.equal(r.tokenProgram,'token-2022');assert.deepEqual(r.mintExtensions,['MetadataPointer']);assert.deepEqual(r.balances,[{owner:o,balance:FLOOR*2n}]);assert.equal(r.unsupportedAccounts,2);
 await assert.rejects(readParentMint(chain({mint:MINT_B,token2022:true,mintExtensions:[[ExtensionType.TransferFeeConfig,Buffer.alloc(108)]]}),MINT_B),/unsupported Token-2022 extensions: TransferFeeConfig/);
 await assert.rejects(readParentMint(chain({mint:MINT_B,token2022:true,mintExtensions:[[ExtensionType.TransferHook,Buffer.alloc(64)]]}),MINT_B),/TransferHook/);
 assert.deepEqual(decodeTokenAccount(plain,null,{programId:TOKEN_2022_PROGRAM_ID,mint:MINT_B,tokenProgram:'token-2022'}),{excluded:'stale'});
});

test('both parents are independent: one owner eligible in both gets two allocations; totals stay within 5% each; proofs verify; duplicates refused',async()=>{
 const both=wallet(),onlyA=wallet(),onlyB=wallet();
 const A=world([{owner:both,accounts:[[addr(),FLOOR*3n]]},{owner:onlyA,accounts:[[addr(),FLOOR]]}]);
 const B=world([{owner:both,accounts:[[addr(),FLOOR*7n]]},{owner:onlyB,accounts:[[addr(),FLOOR*2n]]}],{mint:MINT_B});
 const a=await readParentSnapshot(chain({accounts:A.accounts}),das(A.rows),MINT_A),b=await readParentSnapshot(chain({mint:MINT_B,accounts:B.accounts}),das(B.rows),MINT_B);
 const child=1_000_000_000_000_000n,reserve=child/10000n*500n;
 const trees=[parentTree(CAMPAIGN,0,a.supply,a.balances,child),parentTree(CAMPAIGN,1,b.supply,b.balances,child)];
 for(const [i,t] of trees.entries()){const sum=t.entries.reduce((s,e)=>s+e.allocation,0n);assert.ok(sum<=reserve&&reserve-sum<BigInt(t.entries.length),'dust below one unit per entry');assert.equal(t.threshold,programThreshold([a,b][i].supply));
  for(const e of t.entries){let h=parentLeaf(CAMPAIGN,i,e.owner,e.balance,e.allocation);for(const s of e.proof){h=createHash('sha256').update(Buffer.concat(Buffer.compare(h,s)<=0?[h,s]:[s,h])).digest();}assert.ok(h.equals(t.root),'proof reaches the root');assert.equal(e.allocation,reserve*e.balance/t.eligibleBalance);}}
 assert.ok(trees[0].entries.some(e=>e.owner===both)&&trees[1].entries.some(e=>e.owner===both));assert.ok(!trees[0].entries.some(e=>e.owner===onlyB)&&!trees[1].entries.some(e=>e.owner===onlyA));
 assert.notEqual(trees[0].root.toString('hex'),trees[1].root.toString('hex'));
 assert.throws(()=>parentTree(CAMPAIGN,0,a.supply,[...a.balances,a.balances[0]],child),/unique/);
 assert.throws(()=>parentTree(CAMPAIGN,0,a.supply,[{owner:both,balance:a.supply+1n}],child),/exceeds parent supply/);
});

test('evidence is create-once, owner-only, and records network, mint, program, supply, slots and methodology; hashes are deterministic',async()=>{
 const o=wallet();const w=world([{owner:o,accounts:[[addr(),FLOOR]]}]);
 const r1=await readParentSnapshot(chain({accounts:w.accounts}),das(w.rows),MINT_A,{now:()=>1_758_000_000_000}),r2=await readParentSnapshot(chain({accounts:w.accounts}),das(w.rows),MINT_A,{now:()=>1_758_000_000_000});
 assert.equal(r1.snapshotSha256,r2.snapshotSha256);assert.equal(r1.csv,'owner,balance\n'+o+','+FLOOR+'\n');
 const dir=mkdtempSync(join(tmpdir(),'kids-snap-'));const {csvPath,jsonPath}=writeParentSnapshotEvidence(dir,CAMPAIGN,r1);
 assert.equal(statSync(csvPath).mode&0o777,0o600);const j=JSON.parse(readFileSync(jsonPath,'utf8'));
 for(const k of ['network','genesisHash','mint','tokenProgram','supply','slotBefore','slotAfter','readBackContextSlots','methodology','thresholdRule','passes','nominationPasses','readBackMinContextSlot','csvSha256','snapshotSha256','campaign'])assert.ok(k in j,'missing '+k);
 assert.equal(j.network,'mainnet');assert.equal(j.supply,SUPPLY.toString());assert.ok(!('csv' in j));
 assert.throws(()=>writeParentSnapshotEvidence(dir,CAMPAIGN,r1),/already exists/);
 assert.equal(JSON.stringify(publicParentSnapshot({a:1n})),'{"a":"1"}');
});

test('Helius DAS client retries an outage, refuses non-Helius hosts, and never quotes the URL or key in an error',async()=>{
 const url='https://mainnet.helius-rpc.com/?api-key=FIXTURE-KEY-0000';let calls=0;
 const fetchImpl=async(u,init)=>{calls+=1;assert.equal(u,url);const body=JSON.parse(init.body);assert.equal(body.params.displayOptions.showZeroBalance,false);if(calls===1)return {ok:false,status:429};if(calls===2)return {ok:true,json:async()=>({jsonrpc:'2.0',result:{total:1,limit:body.params.limit,cursor:null,token_accounts:[{address:addr(),mint:body.params.mint,owner:wallet(),amount:'5',frozen:false},{bad:true}]}})};return {ok:false,status:403};};
 const client=createHeliusDasClient(url,fetchImpl);const page=await client.getTokenAccounts({mint:MINT_A,limit:10});assert.equal(page.token_accounts.length,1);assert.equal(page.skipped,1);assert.equal(calls,2);
 await assert.rejects(client.getTokenAccounts({mint:MINT_A,limit:10}),e=>!e.message.includes('FIXTURE-KEY')&&!e.message.includes(url)&&e.category==='auth'&&calls===3,'auth failures are not retried and never leak the URL');
 assert.throws(()=>createHeliusDasClient('https://api.mainnet-beta.solana.com',fetchImpl),/Helius/);
});

test('nomination passes run concurrently by default and give the same result as sequential passes',async()=>{
 const whale=wallet(),small=wallet();const w=world([{owner:whale,accounts:[[addr(),FLOOR*4n],[addr(),FLOOR]]},{owner:small,accounts:[[addr(),FLOOR-1n]]}]);
 let inFlight=0,peak=0;const d=das(w.rows,{pageSize:1});const slow={async getTokenAccounts(p){inFlight+=1;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,5));try{return await d.getTokenAccounts(p);}finally{inFlight-=1;}}};
 const c=await readParentSnapshot(chain({accounts:w.accounts}),slow,MINT_A,{passes:2,now:()=>1}),q=await readParentSnapshot(chain({accounts:w.accounts}),slow,MINT_A,{passes:2,concurrentPasses:false,now:()=>1});
 assert.equal(peak,2,'two passes overlapped');assert.equal(c.csvSha256,q.csvSha256);assert.deepEqual(c.balances,[{owner:whale,balance:FLOOR*5n}]);assert.equal(c.nominationPasses.length,2);
});

const SIGNAL_URL='https://mainnet.helius-rpc.com/?api-key=FIXTURE-KEY-1234';
/** Fake Helius for owner signals: per-owner lamports and token counts; `fail` maps owner -> failure script. */
function signalFetch(profile,{fail={}}={}){const calls={};return async(u,init)=>{const body=JSON.parse(init.body);const owner=body.method==='getBalance'?body.params[0]:body.params.owner;calls[owner]=(calls[owner]??0)+1;const script=fail[owner];if(script){const step=script.shift();if(step==='timeout')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));if(step==='network')throw new TypeError('fetch failed');if(step==='429')return {ok:false,status:429,headers:{get:h=>h==='retry-after'?'1':null}};if(step==='500')return {ok:false,status:500,headers:{get:()=>null}};if(step==='403')return {ok:false,status:403,headers:{get:()=>null}};if(step==='malformed')return {ok:true,status:200,headers:{get:()=>null},json:async()=>({nope:true})};if(step==='rpc-invalid')return {ok:true,status:200,headers:{get:()=>null},json:async()=>({jsonrpc:'2.0',error:{code:-32602,message:'invalid params'}})};}
 const p=profile[owner]??{sol:0,tokens:1};return {ok:true,status:200,headers:{get:()=>null},json:async()=>({jsonrpc:'2.0',result:body.method==='getBalance'?{context:{slot:777},value:Math.round(p.sol*1e9)}:{total:p.tokens,limit:1000,cursor:null,token_accounts:[]}})};};}
const fastPolicy={attempts:4,baseMs:1,maxMs:2,jitterMs:1,requestTimeoutMs:20,operationDeadlineMs:60000};

test('named exclusions apply only when confirmed; proposed ones are reported; custodial signals are facts plus a low-confidence heuristic',async()=>{
 const exchange=wallet(),proposedOnly=wallet(),holder=wallet();
 const w=world([{owner:exchange,accounts:[[addr(),FLOOR*10n]]},{owner:proposedOnly,accounts:[[addr(),FLOOR*5n]]},{owner:holder,accounts:[[addr(),FLOOR]]}]);
 const exclusions=loadExclusions(JSON.stringify({version:'t',owners:[{owner:exchange,reason:'custodial signal',confirmed:true},{owner:proposedOnly,reason:'proposed',confirmed:false}]}));
 const fetchImpl=signalFetch({[proposedOnly]:{sol:2_000_000,tokens:500},[holder]:{sol:5,tokens:3}});
 const r=await readParentSnapshot(chain({accounts:w.accounts}),das(w.rows),MINT_A,{passes:1,exclusions,custodialSignals:{rpcUrl:SIGNAL_URL,fetchImpl,policy:fastPolicy,sleep:async()=>{}}});
 assert.deepEqual(r.balances.map(b=>b.owner).sort(),[proposedOnly,holder].sort());assert.deepEqual(r.exclusions.applied,[{owner:exchange,reason:'custodial signal'}]);assert.deepEqual(r.exclusions.proposedNotApplied,[proposedOnly]);
 assert.equal(r.complete,true);assert.deepEqual(r.custodialSignals.flaggedOwners,[proposedOnly]);const h=r.custodialSignals.entries.find(e=>e.owner===holder);assert.equal(h.status,'resolved');assert.equal(h.heuristic.flagged,false);assert.equal(h.facts.contextSlot,777);assert.match(h.heuristic.confidence,/low/);
 assert.throws(()=>loadExclusions(JSON.stringify({owners:[{owner:'bad',reason:'x'}]})),/owner and reason/);
});

test('read retries: transient then success, 429 honours Retry-After, permanent and malformed never retry, timeouts abort and end unresolved',async()=>{
 const waits=[];const sleep=async ms=>{waits.push(ms);};
 let n=0;const value=await withReadRetries('t',async()=>{n+=1;if(n<3)throw new TypeError('fetch failed');return 'ok';},{policy:fastPolicy,sleep});assert.equal(value,'ok');assert.equal(n,3);assert.equal(waits.length,2);
 waits.length=0;n=0;await assert.rejects(withReadRetries('r',async()=>{n+=1;throw classifyResponse({ok:false,status:429,headers:{get:h=>h==='retry-after'?'2':null}});},{policy:fastPolicy,sleep}),e=>e.unresolved===true&&e.category==='rate-limited'&&e.attempts===4);assert.equal(n,4);assert.ok(waits.every(w=>w>=2000),'Retry-After of 2 s respected: '+waits);
 n=0;await assert.rejects(withReadRetries('p',async()=>{n+=1;throw classifyResponse({ok:false,status:403,headers:{get:()=>null}});},{policy:fastPolicy,sleep}),e=>e.category==='auth');assert.equal(n,1,'auth failures are not retried');
 n=0;await assert.rejects(withReadRetries('m',async()=>{n+=1;throw new ReadFailure('malformed','not JSON');},{policy:fastPolicy,sleep}),/malformed/);assert.equal(n,1);
 n=0;await assert.rejects(withReadRetries('i',async()=>{n+=1;return rpcCall(SIGNAL_URL,'x',[],{fetchImpl:async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({jsonrpc:'2.0',error:{code:-32602}})})});},{policy:fastPolicy,sleep}),e=>e.category==='permanent');assert.equal(n,1,'invalid params are not retried');
 n=0;await assert.rejects(withReadRetries('to',async()=>{n+=1;return rpcCall(SIGNAL_URL,'x',[],{fetchImpl:(u,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})))),timeoutMs:5});},{policy:fastPolicy,sleep}),e=>e.unresolved&&e.category==='timeout');assert.equal(n,4);
 n=0;await assert.rejects(withReadRetries('d',async()=>{n+=1;throw new TypeError('fetch failed');},{policy:{...fastPolicy,baseMs:1000,maxMs:5000},sleep,deadlineAt:Date.now()+10}),e=>e.category==='deadline');assert.equal(n,1,'the deadline stops before a wait that would pass it');
 assert.equal(classifyFailure(new Error('429 Too Many Requests')).category,'rate-limited');assert.equal(classifyFailure(Object.assign(new Error('x'),{name:'AbortError'})).category,'timeout');assert.equal(classifyFailure(new Error('Minimum context slot has not been reached')).retry,true);
 assert.ok(!sanitize('boom https://mainnet.helius-rpc.com/?api-key=SECRET-9 x').includes('SECRET'));assert.ok(!sanitize('api-key=ABC').includes('ABC'));
});

test('partial completion: an unresolved owner stays unresolved (never safe, never custodial), the snapshot is incomplete and evidence is refused',async()=>{
 const good=wallet(),bad=wallet();const w=world([{owner:good,accounts:[[addr(),FLOOR*2n]]},{owner:bad,accounts:[[addr(),FLOOR*3n]]}]);
 const fetchImpl=signalFetch({[good]:{sol:1,tokens:2},[bad]:{sol:9_999_999,tokens:999}},{fail:{[bad]:['network','500','timeout','network','network','network','network','network']}});
 const r=await readParentSnapshot(chain({accounts:w.accounts}),das(w.rows),MINT_A,{passes:1,custodialSignals:{rpcUrl:SIGNAL_URL,fetchImpl,policy:{...fastPolicy,requestTimeoutMs:5},sleep:async()=>{}}});
 assert.equal(r.complete,false);assert.equal(r.custodialSignals.unresolved,1);assert.equal(r.custodialSignals.resolved,1);const e=r.custodialSignals.entries.find(x=>x.owner===bad);assert.equal(e.status,'unresolved');assert.equal(e.heuristic,null);assert.equal(e.facts,null);assert.ok(['transient','timeout'].includes(e.failure.category));assert.equal(e.failure.attempts,4);
 assert.deepEqual(r.custodialSignals.flaggedOwners,[]);assert.deepEqual(r.balances.map(b=>b.owner).sort(),[good,bad].sort(),'eligibility itself is chain-decided and unaffected');
 const dir=mkdtempSync(join(tmpdir(),'kids-snap-'));assert.throws(()=>writeParentSnapshotEvidence(dir,CAMPAIGN,r),/Incomplete evidence is not published/);
 // temporary failure followed by success resolves the owner
 const fetch2=signalFetch({[good]:{sol:1,tokens:2},[bad]:{sol:9_999_999,tokens:999}},{fail:{[bad]:['429']}});
 const ok=await readParentSnapshot(chain({accounts:w.accounts}),das(w.rows),MINT_A,{passes:1,custodialSignals:{rpcUrl:SIGNAL_URL,fetchImpl:fetch2,policy:fastPolicy,sleep:async()=>{}}});
 assert.equal(ok.complete,true,JSON.stringify(ok.custodialSignals.entries));assert.deepEqual(ok.custodialSignals.flaggedOwners,[bad]);
 // the read-back itself also retries transient failures and fails closed otherwise
 const c=chain({accounts:w.accounts});const original=c.getMultipleAccountsInfoAndContext.bind(c);let calls=0;c.getMultipleAccountsInfoAndContext=async(...a)=>{calls+=1;if(calls===1)throw new Error('fetch failed');return original(...a);};
 const rb=await readParentSnapshot(c,das(w.rows),MINT_A,{passes:1});assert.equal(rb.eligibleOwners,2);assert.equal(calls,2);
 c.getMultipleAccountsInfoAndContext=async()=>{throw new Error('403 forbidden');};await assert.rejects(readParentSnapshot(c,das(w.rows),MINT_A,{passes:1}),/unresolved/);
});

test('per-owner cap counts a whale at the cap and re-splits the rest, iterated; 10000 bps disables it',()=>{
 const rows=[{owner:'A',balance:900n},{owner:'B',balance:50n},{owner:'C',balance:50n}];
 assert.deepEqual(applyOwnerCap(rows,10000).balances.map(b=>b.balance),[900n,50n,50n]);
 const capped=applyOwnerCap(rows,5000);const total=capped.balances.reduce((s,b)=>s+b.balance,0n);const a=capped.balances[0];
 assert.equal(capped.capped,1);assert.equal(a.balance,100n);assert.equal(a.balance*10000n,total*5000n,'A holds exactly 50% of the counted total');assert.equal(a.originalBalance,900n);assert.deepEqual(capped.balances.slice(1).map(b=>b.balance),[50n,50n]);
 const two=applyOwnerCap([{owner:'A',balance:100n},{owner:'B',balance:100n},{owner:'C',balance:1n}],4000);assert.equal(two.capped,2);assert.deepEqual(two.balances.map(b=>b.balance),[2n,2n,1n]);
 assert.throws(()=>applyOwnerCap(rows,0),/capBps/);
});

test('final allocation applies the 2% owner cap: capped wallets count at exactly 2% of the pool, originals kept, evidence written; tiny communities leave a remainder',async()=>{
 assert.equal(PER_OWNER_CAP_BPS,200);const reserve=1000000000000000n/10000n*500n;
 // realistic: one whale among 60 small wallets -> only the whale is capped, no remainder
 const whale=wallet();const holders=[{owner:whale,accounts:[[addr(),FLOOR*400n]]},...Array.from({length:60},()=>({owner:wallet(),accounts:[[addr(),FLOOR*2n]]}))];
 const w=world(holders);const r=await readParentSnapshot(chain({accounts:w.accounts}),das(w.rows),MINT_A,{passes:1});r.allocation=finalizeParentAllocation(r);
 const a=r.allocation;assert.equal(a.capped,1);assert.equal(a.unallocatedBps,0);const wb=a.balances.find(b=>b.owner===whale);assert.equal(wb.originalBalance,FLOOR*400n);const gap=wb.balance*10000n-a.eligibleTotal*200n;assert.ok(gap<=0n&&gap>-10000n,'whale counts at 2% within one raw unit: '+gap);
 const tree=parentTree(CAMPAIGN,0,r.supply,a.balances.map(b=>({owner:b.owner,balance:b.balance})),1000000000000000n,a.eligibleTotal);const whaleAlloc=tree.entries.find(e=>e.owner===whale).allocation;assert.ok(reserve*200n/10000n-whaleAlloc<=reserve/a.eligibleTotal+1n&&whaleAlloc<=reserve*200n/10000n,'whale allocation is 2% of the reserve minus rounding');
 assert.ok(a.csv.startsWith('owner,countedBalance,originalBalance\n'));
 const dir=mkdtempSync(join(tmpdir(),'kids-snap-'));const out=writeParentSnapshotEvidence(dir,CAMPAIGN,r);assert.ok(out.allocationPath.endsWith('.allocation.csv'));const j=JSON.parse(readFileSync(out.jsonPath,'utf8'));assert.equal(j.allocation.capBps,200);assert.equal(j.allocation.capped,1);assert.ok(!('csv' in j.allocation));
 // tiny community: 21 wallets cannot all fit under 2%, so each is held at exactly 2% and 58% of the pool stays unallocated
 const tiny=[{owner:wallet(),accounts:[[addr(),FLOOR*400n]]},...Array.from({length:20},()=>({owner:wallet(),accounts:[[addr(),FLOOR*2n]]}))];const wt=world(tiny);
 const rt=await readParentSnapshot(chain({accounts:wt.accounts}),das(wt.rows),MINT_A,{passes:1});rt.allocation=finalizeParentAllocation(rt);const at=rt.allocation;
 assert.equal(at.capped,21);assert.equal(at.unallocatedBps,5800);const tt=parentTree(CAMPAIGN,0,rt.supply,at.balances.map(b=>({owner:b.owner,balance:b.balance})),1000000000000000n,at.eligibleTotal);
 for(const e of tt.entries){const d=reserve*200n/10000n-e.allocation;assert.ok(d>=0n&&d<=reserve/at.eligibleTotal+1n,'each capped wallet gets 2% of the reserve minus rounding: '+d);}const sum=tt.entries.reduce((s,e)=>s+e.allocation,0n);assert.ok(reserve*4200n/10000n-sum>=0n&&reserve*4200n/10000n-sum<=21n*(reserve/at.eligibleTotal+1n));
 assert.throws(()=>parentTree(CAMPAIGN,0,rt.supply,at.balances.map(b=>({owner:b.owner,balance:b.balance})),1000000000000000n,at.countedTotal-1n),/Eligible total/);
});
