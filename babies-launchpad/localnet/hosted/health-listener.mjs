// Liveness and readiness listener for hosted roles that serve no HTTP API (worker lanes, the indexer): the platform
// healthcheck (railway.json: /readyz) and the private network see /healthz (process alive) and /readyz (role started;
// 503 before that and while stopping). Nothing else is served and the body never carries endpoints or identifiers.
import http from 'node:http';
export function createHealthListener({role,ready=()=>false}){
 if(typeof role!=='string'||!/^[a-z0-9-]{1,32}$/.test(role))throw Error('Health listener needs a role name');
 if(typeof ready!=='function')throw Error('Health listener needs a readiness function');
 const server=http.createServer((req,res)=>{
  req.resume();
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
  if(req.method!=='GET')return send(405,{error:'method not allowed'});
  if(req.url==='/healthz')return send(200,{status:'alive',role});
  if(req.url==='/readyz'){const ok=ready()===true;return send(ok?200:503,{status:ok?'ready':'starting',role});}
  send(404,{error:'not found'});
 });
 server.keepAliveTimeout=5000;server.headersTimeout=6000;server.requestTimeout=5000;
 return {server,
  listen:(port,host='::')=>new Promise((resolve,reject)=>{const fail=e=>reject(e);server.once('error',fail);server.listen(port,host,()=>{server.off('error',fail);resolve(server.address());});}),
  close:()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(()=>resolve());})};
}
/** The platform sets PORT for a hosted service; a role listens there when it is present and refuses a non-port value. */
export function healthPort(env){
 if(env.PORT===undefined||env.PORT==='')return null;
 const port=Number(env.PORT);if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT must be a port number');return port;
}
