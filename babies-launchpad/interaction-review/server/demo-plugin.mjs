import {guardLocalRequest} from '../../shared/local-http.mjs';
import {trustedGatewayContext} from '../../shared/trusted-gateway.mjs';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DemoStore} from './demo-store.mjs';
import {fetchMint} from './parent-lookup.mjs';
import {parents} from '../src/model.js';

export function demoPersistencePlugin(){
  let store;
  const install=server=>{
    const directory=new URL('../../protocol/.runtime/',import.meta.url);
    mkdirSync(directory,{recursive:true,mode:0o700});
    store=new DemoStore(fileURLToPath(new URL('preview.sqlite',directory)));
    server.httpServer?.once('close',()=>store.close());
    server.middlewares.use(async(req,res,next)=>{
      if(req.url?.split('?')[0]!=='/api/demo')return next();
      const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
      const port=server.httpServer.address()?.port||4175,denied=guardLocalRequest(req,{port,subject:'KIDS preview data',allowGateway:true});if(denied)return send(denied.status,denied.body);
      if(trustedGatewayContext(req,{port})&&req.method!=='GET')return send(403,{error:'Remote preview data is read-only'});
      try {
        if(req.method==='GET')return send(200,{...store.read(),scope:'shared-local-demo'});
        if(req.method!=='POST')return send(405,{error:'Method not allowed'});
        if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON required'});
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>17000000)return send(413,{error:'Proposal is too large'});}
        const input=JSON.parse(body),original=structuredClone(input);
        if(['vote','submit'].includes(input.action))return send(410,{error:'Voting and submissions have been removed.'});
        if(['submit','review','coin-profile','coin-post'].includes(input.action))return send(403,{error:'Use wallet submissions or the protected admin panel for this action'});
        if(input.action==='submit'){
          // Verify real parents on the server; browser lookup evidence is not trusted.
          const draft=input.payload?.draft;if(!draft)throw Error('Draft required');
          for(const key of ['a','b'])if(!parents.includes(draft[key])){
            const info=await fetchMint(draft[key]);if(!info.supported)throw Error('Parent mint is not supported');
            draft.parentData={...draft.parentData,[key]:info};
          }
        }
        send(200,store.apply(original,input.payload));
      }catch(error){send(400,{error:error.message});}
    });
  };
  return {name:'persistent-local-demo',configureServer:install,configurePreviewServer:install};
}
