// Real HTTP + signed PostgreSQL sessions + actual image sanitizer and quote
// composition. Chain reads and object/provider adapters are explicit fixtures;
// this test does not qualify external wallets or hosted publication providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import {Keypair,PublicKey} from '@solana/web3.js';
import {PostgresRegistry} from '../registry/registry.mjs';
import {readPresets} from '../registry/presets.mjs';
import {discriminator} from '../cpmm.mjs';
import {RAYDIUM_CPMM} from '../protocol-v2/client.mjs';
import {rentLamports} from '../signer-policy.mjs';
import {signWithSeed} from '../../shared/solana.mjs';
import {createImageSanitizer} from './image-sanitizer.mjs';
import {composeLocalCreatorHttp} from '../../interaction-review/server/local-creator-services.mjs';
import {accountPlugin} from '../../interaction-review/server/account-plugin.mjs';
import {createApiServer} from '../../interaction-review/server/runtime.mjs';
import {initialDraft} from '../../interaction-review/src/public/launch-draft.mjs';
const url=process.env.KIDS_TEST_POSTGRES_URL,key=()=>Keypair.generate().publicKey.toBase58();
test('creator HTTP composes signed login, private artwork, draft, exact quote and restart-safe acceptance',{skip:!url},async()=>{
 const schema='kids_test_'+randomUUID().replaceAll('-',''),control=new pg.Pool({connectionString:url,max:1});let pool,runtime;
 const owner=Keypair.generate(),foreign=Keypair.generate(),objects=new Map();let pins=0,signs=0,reservations=0;
 try{
  await control.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,max:8,options:`-c search_path=${schema}`});const registry=new PostgresRegistry({pool});await registry.migrate();
  const config={mode:'localnet-rehearsal',programVersion:3,rpcUrl:'http://127.0.0.1:19199',genesisHash:key(),programId:key(),treasury:key(),pilotCreator:String(owner.publicKey)};
  const amm=Buffer.alloc(236);discriminator('account:AmmConfig').copy(amm);amm.writeUInt16LE(7,10);amm.writeBigUInt64LE(25000n,12);amm.writeBigUInt64LE(120000n,20);amm.writeBigUInt64LE(40000n,28);amm.writeBigUInt64LE(150000000n,36);
  const clock=Buffer.alloc(40);clock.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32);
  const connection={rpcEndpoint:config.rpcUrl,getGenesisHash:async()=>config.genesisHash,getMultipleAccountsInfoAndContext:async()=>({context:{slot:100},value:[{owner:RAYDIUM_CPMM,data:amm},{data:clock}]}),getMinimumBalanceForRentExemption:async n=>Number(rentLamports(n)),getLatestBlockhash:async()=>({blockhash:key(),lastValidBlockHeight:1000}),getFeeForMessage:async()=>({context:{slot:101},value:5000})};
  const storage={storageId:'c'.repeat(64),verifyPrivacy:async()=>true,put:async(k,image)=>{objects.set(k,image);return {sha256:image.sha256,byteCount:image.bytes.length};},read:async k=>objects.get(k)};
  const inventory={reserve:async()=>{reservations++;throw Error('No available mint');},assetMintSigner:()=>async()=>{signs++;throw Error('No signing in this HTTP admission test');}};
  const args={registry,connection,config,manifest:readPresets(),setupPlan:{version:'http-qualification',counts:{transactions:8,signatures:11,ataCreates:9,lockedPositions:1,feeStates:1},priorityFeeLamports:'10000',marginBps:1500},inventory,storage,sanitize:createImageSanitizer(),provider:{publish:async()=>{pins++;throw Error('Not published');},recover:async()=>null},artworkLimits:{ownerAttempts:10,globalAttempts:20,ownerBytes:30000000,globalBytes:60000000,ownerActive:1,globalActive:2},publicationLimits:{ownerPins:4,globalPins:8,ownerBytes:4000000,globalBytes:8000000}};
  let services=composeLocalCreatorHttp(args);const forwarding={canAccess:owner=>services.account.canAccess(owner),handle:input=>services.account.handle(input)},gate={open:true};
  runtime=createApiServer({writesGate:gate,probe:async()=>true,probeInterval:60000,plugins:[accountPlugin({publicLaunchService:forwarding,accountRegistry:registry,sharedAccounts:true,csrfSecret:randomBytes(32).toString('hex'),backgroundServices:false}),services.directory]});
  await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+runtime.server.address().port;
  async function request(path,{cookie='',body,csrf,headers={}}={}){const r=await fetch(origin+'/api/account/'+path,{method:body===undefined?'GET':'POST',headers:{origin,cookie,...(body===undefined?{}:{'content-type':'application/json','x-kids-csrf':csrf}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const csrf=(await request('state')).body.csrf;
  async function login(wallet){const challenge=await request('challenge',{csrf,body:{owner:String(wallet.publicKey)}});assert.equal(challenge.status,200);return request('verify',{csrf,body:{id:challenge.body.id,signature:signWithSeed(Buffer.from(wallet.secretKey.subarray(0,32)),Buffer.from(challenge.body.message)).toString('base64')}});}
  const auth=await login(owner),other=await login(foreign);assert.equal(auth.body.publicLaunches.allowed,true);assert.equal(other.body.publicLaunches.allowed,false);
  const directory=await request('launches/campaigns',{cookie:auth.cookie});assert.equal(directory.status,200);assert.equal(directory.body.manifest.capabilities.artwork,true);assert.equal(directory.body.manifest.capabilities.create,false);assert.equal(directory.body.manifest.treasury,config.treasury);assert.equal(directory.body.manifest.supply.totalBaseUnits,'1000000000000000');assert.equal((await request('launches/campaigns')).status,401);assert.equal((await request('launches/campaigns',{cookie:other.cookie})).status,403);
  assert.equal(directory.body.manifest.capabilities.marketRead,true);
  const marketInput={campaign:key(),kind:'trades',limit:8};
  assert.equal((await request('launches/market/read',{csrf,body:marketInput})).status,401);
  assert.equal((await request('launches/market/read',{cookie:other.cookie,csrf,body:marketInput})).status,403);
  assert.equal((await request('launches/market/read',{cookie:auth.cookie,csrf:'bad',body:marketInput})).status,403);
  for(const authCase of [{csrf,status:401},{cookie:other.cookie,csrf,status:403},{cookie:auth.cookie,csrf:'bad',status:403},{cookie:auth.cookie,csrf,status:200}])assert.equal((await request('launches/activity/read',{...authCase,body:{campaign:marketInput.campaign}})).status,authCase.status);
  assert.equal(directory.body.manifest.capabilities.portfolioRead,true);
  for(const authCase of [{csrf,status:401},{cookie:other.cookie,csrf,status:403},{cookie:auth.cookie,csrf:'bad',status:403},{cookie:auth.cookie,csrf,status:200}]){const p=await request('launches/portfolio/read',{...authCase,body:{owner:String(foreign.publicKey)}});assert.equal(p.status,authCase.status);if(p.status===200){assert.equal(p.body.owner,config.pilotCreator);assert.deepEqual(p.body.campaignIds,[]);}}
  const market=await request('launches/market/read',{cookie:auth.cookie,csrf,body:marketInput});assert.equal(market.status,200);assert.equal(market.body.available,false);assert.equal(market.body.genesisHash,config.genesisHash);assert.equal(market.body.programId,config.programId);
  const png=await sharp({create:{width:64,height:64,channels:4,background:'#f576ca'}}).withMetadata().png().toBuffer();
  const upload=await fetch(origin+'/api/account/launches/artwork/upload',{method:'POST',headers:{origin,cookie:auth.cookie,'x-kids-csrf':csrf,'content-type':'image/png','x-kids-upload-id':'http-pfp','x-kids-artwork-kind':'pfp'},body:png});assert.equal(upload.status,200);const asset=(await upload.json()).artwork;assert.equal(asset.status,'ready');
  const imageUrl='launches/artwork/'+asset.assetId;assert.equal((await request(imageUrl)).status,401);assert.equal((await request(imageUrl,{cookie:other.cookie})).status,403);
  const image=await fetch(origin+'/api/account/'+imageUrl,{headers:{origin,cookie:auth.cookie}});assert.equal(image.headers.get('cache-control'),'private, no-store');assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).exif,undefined);
  const draft={...initialDraft(services.manifest(),{creator:config.pilotCreator}),name:'HTTP rehearsal',symbol:'HTTPTest',description:'Private integration test',pfp:asset,publicationConsent:true};
  const save={id:'http-draft',revision:0,draft};assert.equal((await request('launches/drafts/save',{cookie:auth.cookie,csrf:'bad',body:save})).status,403);
  assert.equal((await request('launches/drafts/save',{cookie:other.cookie,csrf,body:{...save,owner:config.pilotCreator}})).status,403);
  const saved=await request('launches/drafts/save',{cookie:auth.cookie,csrf,body:save});assert.equal(saved.status,200,JSON.stringify(saved.body));
  const input={draftId:saved.body.draft.id,revision:saved.body.draft.revision,requestId:'http-review'};
  const quote=await request('launches/creation/quote',{cookie:auth.cookie,csrf,body:{...input,treasury:String(foreign.publicKey),softCapLamports:'1'}});assert.equal(quote.status,200,JSON.stringify(quote.body));assert.equal(quote.body.body.treasury,config.treasury);assert.equal(quote.body.body.terms.softCapLamports,'1000000000');assert.equal(quote.body.body.terms.hardCapLamports,'5000000000');assert.equal(quote.body.body.fundingEnabled,false);
  const accept=()=>request('launches/creation/accept',{cookie:auth.cookie,csrf,body:{quoteId:quote.body.id}}),accepted=await accept();assert.equal(accepted.status,200);
  services=composeLocalCreatorHttp(args);const replay=await accept();assert.equal(replay.body.id,accepted.body.id);assert.equal((await registry.drafts.get(config.pilotCreator,'http-draft')).status,'creating');
  const status=await request('launches/creation/status',{cookie:auth.cookie,csrf,body:{draftId:'http-draft'}});assert.equal(status.body.id,accepted.body.id);
  assert.equal(pins,0);assert.equal(signs,0);assert.equal(reservations,0,'quote and acceptance must not sign, publish, debit or reserve stock');
  // Restart under changed active presets (schedule and reserve amount). The accepted request is still served under the terms it
  // was quoted with; a quote issued before the change can no longer be accepted; a new quote carries the new settings.
  const stale=await request('launches/drafts/save',{cookie:auth.cookie,csrf,body:{id:'http-draft-stale',revision:0,draft:{...draft,name:'Stale quote'}}});assert.equal(stale.status,200);
  const staleQuote=await request('launches/creation/quote',{cookie:auth.cookie,csrf,body:{draftId:'http-draft-stale',revision:stale.body.draft.revision,requestId:'http-review-stale'}});assert.equal(staleQuote.status,200);
  const changed={...args.manifest,schedule:{...args.manifest.schedule,fundingDurationSeconds:600,launchWindowSeconds:1200},agreed:{...args.manifest.agreed,operating:{...args.manifest.agreed.operating,reserveLamports:'200000000'}}};
  services=composeLocalCreatorHttp({...args,manifest:changed});
  const survived=await request('launches/creation/status',{cookie:auth.cookie,csrf,body:{draftId:'http-draft'}});assert.equal(survived.status,200);assert.equal(survived.body.id,accepted.body.id,'an accepted request survives a preset change');
  assert.equal(survived.body.body.quote.operatingReserveLamports,quote.body.body.operatingReserveLamports,'its accepted reserve amount is unchanged');
  const survivedFlow=await request('launches/creation/flow/status',{cookie:auth.cookie,csrf,body:{requestId:accepted.body.id}});assert.equal(survivedFlow.status,200,JSON.stringify(survivedFlow.body));assert.equal(survivedFlow.body.stage,'reservation');assert.equal(survivedFlow.body.review.operatingReserveLamports,quote.body.body.operatingReserveLamports);
  const staleAccept=await request('launches/creation/accept',{cookie:auth.cookie,csrf,body:{quoteId:staleQuote.body.id}});assert.notEqual(staleAccept.status,200,'a quote from before the change cannot be accepted');assert.match(staleAccept.body.error,/before a settings change/);
  const fresh=await request('launches/creation/quote',{cookie:auth.cookie,csrf,body:{draftId:'http-draft-stale',revision:stale.body.draft.revision,requestId:'http-review-fresh'}});assert.equal(fresh.status,200);assert.equal(fresh.body.body.operatingReserveLamports,'200000000','a new quote carries the new settings');
  assert.equal(reservations,0);services=composeLocalCreatorHttp(args);
  services=composeLocalCreatorHttp({...args,config:{...config,treasury:String(foreign.publicKey)}});assert.equal((await request('launches/creation/flow/prepare',{cookie:auth.cookie,csrf,body:{requestId:accepted.body.id}})).status,409);assert.equal(reservations,0);services=composeLocalCreatorHttp(args);
  gate.open=false;const flow='launches/creation/flow/',payload={requestId:accepted.body.id};
  assert.equal((await request('launches/market/read',{cookie:auth.cookie,csrf,body:marketInput})).status,200,'private market reads survive a financial write pause');
  assert.equal((await request(flow+'prepare',{cookie:auth.cookie,csrf,body:payload})).status,503);
  const read=await request(flow+'status',{cookie:auth.cookie,csrf,body:payload});assert.equal(read.status,200,JSON.stringify(read.body));assert.equal(read.body.stage,'reservation');assert.equal(reservations,0);
  services=composeLocalCreatorHttp({...args,tradeAdmission:{resource:'http-trade-rpc',policy:{ratePerSecond:100,burst:100,lanes:{'wallet-trade':{ratePerSecond:100,burst:100}}}}});
  assert.equal(services.manifest().capabilities.trade,true);
  for(const action of ['prepare','submit','resume'])assert.equal((await request('launches/trade/'+action,{cookie:auth.cookie,csrf,body:{}})).status,503,'financial gate covers trade '+action);
  assert.equal((await request('launches/trade/status',{cookie:auth.cookie,csrf,body:{intentId:'missing'}})).status,400,'trade outcome reads remain reachable while writes paused');
  gate.open=true;
  assert.equal((await request('launches/trade/prepare',{csrf,body:{}})).status,401);
  assert.equal((await request('launches/trade/prepare',{cookie:other.cookie,csrf,body:{}})).status,403);
  assert.equal((await request('launches/trade/prepare',{cookie:auth.cookie,csrf:'bad',body:{}})).status,403);
  await request('logout',{cookie:auth.cookie,csrf,body:{}});assert.equal((await request(flow+'status',{cookie:auth.cookie,csrf,body:payload})).status,401);assert.equal((await request(imageUrl,{cookie:auth.cookie})).status,401);
  assert.throws(()=>composeLocalCreatorHttp({...args,config:{...config,mode:'mainnet'}}));assert.throws(()=>composeLocalCreatorHttp({...args,config:{...config,rpcUrl:'https://remote.invalid'}}));
 }finally{if(runtime)await runtime.shutdown();if(pool)await pool.end();await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();owner.secretKey.fill(0);foreign.secretKey.fill(0);}
});
