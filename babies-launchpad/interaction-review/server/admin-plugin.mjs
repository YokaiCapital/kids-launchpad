import {trustedGatewayContext} from '../../shared/trusted-gateway.mjs';
import {activeLaunchStatus,startActiveLaunch} from './active-launch-control.mjs';
import {rehearsalStatus,startRehearsal} from './launch-rehearsal.mjs';
import {withLaunchPolicy,validateLaunchPolicy} from '../../localnet/launch-policy.mjs';
import {governance,publicRounds,openLocalRound} from './local-governance.mjs';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {guardLocalRequest,newCsrfToken} from '../../shared/local-http.mjs';
import {rpc,isAddress} from '../../shared/solana.mjs';
import {AccountStore} from './account-store.mjs';
import {DemoStore} from './demo-store.mjs';
import {parseMint} from '../src/mint.js';

const releaseGates=JSON.parse(readFileSync(new URL('../../deployment/RELEASE-GATES.json',import.meta.url),'utf8'));
const configPath=fileURLToPath(new URL('../../localnet/.runtime/config.json',import.meta.url));
const runtime=fileURLToPath(new URL('../../protocol/.runtime/',import.meta.url));
export function validateSettings(input){
 if(!input||input.network!=='localnet'||input.rpcUrl!=='http://127.0.0.1:18999')throw Error('This operator panel is restricted to the isolated localnet');
 if(!isAddress(input.admin)||!input.mints||Object.keys(input.mints).sort().join(',')!=='BUTTCOIN,FARTCOIN,KIDS,SHART'||Object.values(input.mints).some(m=>!isAddress(m)))throw Error('Four valid mint addresses and an admin wallet are required');
 if(new Set(Object.values(input.mints)).size!==4)throw Error('Each token requires a distinct mint');
 input=withLaunchPolicy(input);
 const l=input.launch;
 validateLaunchPolicy(l);
 if(!l||l.poolUsd!==200000||!Number.isFinite(l.solUsd)||l.solUsd<=0||l.solUsd>1000000||l.holderMinimumBps!==5||l.parentShareBps!==1000)throw Error('Keep the $200K pool, 10% parent reserve and 0.05% holder rule');
 if(l.commitmentsOpen!==false)throw Error('Real-money escrow cannot be enabled from this localnet settings panel.');
 const cap=BigInt(Math.round(100000/l.solUsd*1e9)).toString();
 return {...input,launch:{...l,capLamports:cap}};
}
export function adminPlugin(){
 const install=server=>{
  mkdirSync(runtime,{recursive:true,mode:0o700});
  const store=new DemoStore(runtime+'/preview.sqlite'),db=new DatabaseSync(runtime+'/operator.sqlite');
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);');
  const csrf=newCsrfToken();
  mkdirSync(fileURLToPath(new URL('../../localnet/.runtime/',import.meta.url)),{recursive:true,mode:0o700});
  const accounts=new AccountStore({filename:fileURLToPath(new URL('../../localnet/.runtime/accounts.sqlite',import.meta.url)),origin:'http://localhost:4175'});
  const read=()=>{const row=db.prepare('SELECT * FROM settings WHERE id=1').get();return row?{revision:row.revision,config:withLaunchPolicy(JSON.parse(row.body))}:{revision:0,config:existsSync(configPath)?withLaunchPolicy(JSON.parse(readFileSync(configPath,'utf8'))):null};};
  const audit=(action,detail)=>db.prepare('INSERT INTO audit(time,action,detail) VALUES(?,?,?)').run(new Date().toISOString(),action,JSON.stringify(detail));
  server.httpServer?.once('close',()=>{store.close();accounts.close();db.close();});
  server.middlewares.use(async(req,res,next)=>{
   const path=req.url?.split('?')[0];if(!path?.startsWith('/api/admin/'))return next();
   const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
   const port=server.httpServer.address()?.port||4175;
   const denied=guardLocalRequest(req,{port,subject:'KIDS local operator',allowGateway:true});if(denied)return send(denied.status,denied.body);
   const gateway=trustedGatewayContext(req,{port});if(gateway&&!gateway.operator)return send(403,{error:'Operator authentication required'});
   try{
    if(req.method==='GET'&&path==='/api/admin/state')return send(200,{...read(),csrf,rounds:publicRounds(),preview:store.read(),submissions:accounts.db.prepare('SELECT owner,body FROM accounts').all().flatMap(row=>JSON.parse(row.body).history.map(p=>({...p,owner:row.owner}))),audit:db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all(),releaseGates,capabilities:{network:'localnet',escrow:true,claims:true,mainnet:false,worker:'Railway kids-mint-worker'}});
    if(req.method==='GET'&&path==='/api/admin/active-launch')return send(200,await activeLaunchStatus());
    if(req.method==='GET'&&path==='/api/admin/launch-test')return send(200,rehearsalStatus());
    if(req.method==='GET'&&path==='/api/admin/health'){
     const {config}=read();if(!config)throw Error('Run localnet setup first');
     const genesisHash=await rpc(config.rpcUrl,'getGenesisHash');if(genesisHash!==config.genesisHash)throw Error('Validator genesis differs from the configured ledger');
     const [slot,balance,mints]=await Promise.all([rpc(config.rpcUrl,'getSlot',[{commitment:'finalized'}]),rpc(config.rpcUrl,'getBalance',[config.admin]),Promise.all(Object.entries(config.mints).map(async([symbol,mint])=>({symbol,...parseMint(mint,await rpc(config.rpcUrl,'getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'finalized'}]))})))]);
     return send(200,{genesisHash,slot,adminLamports:balance.value,mints});
    }
    if(req.method!=='POST')return send(405,{error:'Method not allowed'});
    const actual=Buffer.from(String(req.headers['x-kids-csrf']||'')),expected=Buffer.from(csrf);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(403,{error:'Refresh the admin page before saving'});
    if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
    let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>17000000)return send(413,{error:'Request too large'});}
    const input=JSON.parse(body);
    if(path==='/api/admin/active-launch'){const result=await startActiveLaunch();audit('active-local-launch',{status:result.job?.status});return send(202,result);}
    if(path==='/api/admin/launch-test'){const result=await startRehearsal();audit('local-launch-test',{startedAt:result.job?.startedAt});return send(202,result);}
    if(path==='/api/admin/settings'){
     const current=read();if(input.revision!==current.revision)return send(409,{error:'Settings changed in another tab. Refresh first.'});
     const config=validateSettings(input.config);if(config.genesisHash!==current.config?.genesisHash)throw Error('Genesis identity cannot be edited');
     for(const mint of Object.values(config.mints)){const info=parseMint(mint,await rpc(config.rpcUrl,'getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'finalized'}]));if(!info.supported||info.decimals!==6)throw Error('Localnet configuration requires funded standard SPL mints with six decimals');}
     db.exec('BEGIN IMMEDIATE');try{if(read().revision!==input.revision)throw Error('Settings changed in another tab. Refresh first.');db.prepare('INSERT INTO settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(input.revision+1,JSON.stringify(config));audit('settings-updated',{revision:input.revision+1});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
     return send(200,read());
    }
    if(path==='/api/admin/round/open'){const config=read().config;if(!config)throw Error('Set up localnet first');const round=await openLocalRound({config,records:accounts.publicProposals(),id:input.id,durationMinutes:input.durationMinutes});audit('round-opened',{id:round.id,snapshotHash:round.snapshot.hash});return send(200,round);}
    if(path==='/api/admin/round/close'){const result=governance().closeRound(input.id);audit('round-closed',{id:input.id});return send(200,result);}
    if(path==='/api/admin/moderate'){
     const admin=read().config?.admin;if(!admin)throw Error('Localnet setup required');accounts.admins=new Set([admin]);const result=accounts.moderate(admin,input);audit('proposal-reviewed',{owner:input.owner,id:input.id,version:input.version,status:input.status});return send(200,result);
    }
    if(path==='/api/admin/content'){
     if(!['coin-profile','coin-post','review'].includes(input.action))throw Error('Unsupported content action');
     const result=store.apply(input);audit(input.action,{requestId:input.requestId});return send(200,result);
    }
    return send(404,{error:'Not found'});
   }catch(e){send(400,{error:e.message});}
  });
 };
 return {name:'kids-local-operator',configureServer:install,configurePreviewServer:install};
}
