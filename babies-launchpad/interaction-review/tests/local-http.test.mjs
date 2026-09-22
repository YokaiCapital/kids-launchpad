import test from 'node:test';
import assert from 'node:assert/strict';
import {guardLocalRequest,newCsrfToken} from '../../shared/local-http.mjs';
test('local operator guard rejects remote peers, rebound hosts and cross-origin requests',()=>{
 const request={socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:4175',origin:'http://localhost:4175','sec-fetch-site':'same-origin'}};
 const check=r=>guardLocalRequest(r,{port:4175});
 assert.equal(check(request),null);
 assert.equal(check({...request,socket:{remoteAddress:'192.0.2.1'}}).status,403);
 for(const headers of [{host:'attacker.example:4175'},{origin:'https://attacker.example'},{'sec-fetch-site':'cross-site'}])assert.equal(check({...request,headers:{...request.headers,...headers}}).status,403);
 assert.notEqual(newCsrfToken(),newCsrfToken());
});
