import {createServer} from 'node:http';
import {generateKeyPairSync,createPrivateKey,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Protocol,readiness,preset} from './core.mjs';
export function createProtocolServer({protocol,adminToken,allowedOrigin='http://localhost:4181'}) {
 if(!adminToken||adminToken.length<32)throw Error('Strong admin token required');
 const buckets=new Map();
 return createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  try{
   if(req.headers.origin&&req.headers.origin!==allowedOrigin)return send(403,{error:'Origin not allowed'});
   const host=req.headers.host?.split(':')[0];if(!['localhost','127.0.0.1'].includes(host))return send(403,{error:'Local service only'});
   const url=new URL(req.url,allowedOrigin),path=url.pathname;
   if(req.method==='GET') {
    if(path==='/health')return send(200,{service:'kid.fun local protocol',...readiness()});
    if(path==='/preset')return send(200,preset);
    if(path==='/receipts')return send(200,{signingKey:protocol.receiptPublicKey,receipts:protocol.read().receipts});
    if(path==='/proposals')return send(200,protocol.read().proposals);
    if(path==='/rounds')return send(200,protocol.read().rounds);
    if(path==='/events')return send(200,protocol.read().events);
    if(path==='/tally')return send(200,protocol.tally(url.searchParams.get('round')));
    return send(404,{error:'Not found'});
   }
   if(req.method!=='POST')return send(405,{error:'Method not allowed'});
   const now=Date.now(),ip=req.socket.remoteAddress;let bucket=buckets.get(ip);if(!bucket||now-bucket.since>60000){bucket={since:now,count:0};buckets.set(ip,bucket);}if(++bucket.count>120)return send(429,{error:'Too many requests; retry in one minute'});
   if(path.startsWith('/admin/')){const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+adminToken);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return send(401,{error:'Admin authentication required'});}
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>32768)return send(413,{error:'Request too large'});}const input=JSON.parse(body||'{}');
   if(path==='/challenge')return send(200,protocol.challenge(input));
   if(path==='/accept')return send(200,protocol.accept(input));
   if(path==='/admin/moderate')return send(200,protocol.moderate({...input,actor:'authenticated-local-admin'}));
   if(path==='/admin/rounds')return send(200,protocol.openRound(input));
   if(path==='/admin/close')return send(200,protocol.closeRound(input.round));
   if(path==='/admin/launch')return send(409,{error:'Public launches are closed. No execution endpoint is enabled.',...readiness()});
   return send(404,{error:'Not found'});
  }catch(e){send(400,{error:e.message});}
 });
}
export function openLocalProtocol(directory) {
 mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
 const tokenPath=resolve(directory,'admin.token'),keyPath=resolve(directory,'receipts.pem');
 if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{mode:0o600});
 if(!existsSync(keyPath))writeFileSync(keyPath,generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 return {adminToken:readFileSync(tokenPath,'utf8').trim(),protocol:new Protocol({filename:resolve(directory,'protocol.sqlite'),receiptKey:createPrivateKey(readFileSync(keyPath))})};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const runtime=openLocalProtocol(fileURLToPath(new URL('./.runtime',import.meta.url)));
 const server=createProtocolServer(runtime);server.listen(4181,'127.0.0.1',()=>console.log('kid.fun local protocol: http://127.0.0.1:4181/health — launches CLOSED'));
 const close=()=>server.close(()=>{runtime.protocol.close();process.exit(0);});process.on('SIGTERM',close);process.on('SIGINT',close);
}
