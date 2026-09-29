import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hardenDependencies} from './harden-dependencies.mjs';
const require = createRequire(import.meta.url);

test('hardened upstream bigint conversion never loads native code and keeps exact values', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = hardenDependencies();
  assert.equal(hardenDependencies().entrySha256, result.entrySha256, 'repeatable after fresh npm ci');
  // A poison loader makes accidental loading fail instead of just checking a warning.
  execFileSync(process.execPath, ['-e', `
    const Module = require('module'); const load = Module._load;
    Module._load = function(id, ...args) {
      if (id === 'bindings' || id.endsWith('.node')) throw Error('native binding reached');
      return load.call(this, id, ...args);
    };
    const assert = require('assert/strict');
    const {toBigIntLE,toBigIntBE,toBufferLE,toBufferBE} = require('bigint-buffer');
    for (const width of [1,8,16,24,32,64]) {
      for (const n of [0n,1n,(1n << BigInt(width*8))-1n]) {
        for (const [encode,decode] of [[toBufferLE,toBigIntLE],[toBufferBE,toBigIntBE]]) {
          const b=encode(n,width),copy=Buffer.from(b);
          assert.equal(decode(b),n); assert.deepEqual(b,copy);
        }
      }
    }
    assert.equal(toBigIntLE(Buffer.alloc(0)),0n);
    assert.equal(toBigIntLE(Buffer.alloc(10000,0)),0n);
  `], {cwd: root, stdio: 'pipe'});
});

test('RPC uses patched UUID v4 and never loads the vulnerable stream-json filters', async () => {
  const {Connection,PublicKey} = require('@solana/web3.js');
  const jaysonRequire = createRequire(require.resolve('jayson/lib/client/browser'));
  assert.equal(jaysonRequire('uuid/package.json').version, '11.1.1');
  const requests = [];
  const connection = new Connection('http://127.0.0.1:19199', {fetch: async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{context:{slot:1},value:42}}));
  }});
  assert.equal(await connection.getBalance(new PublicKey(Buffer.alloc(32,1))), 42);
  assert.match(requests[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(Object.keys(require.cache).some(p=>p.includes('/stream-json/')), false);
  const client = readFileSync(require.resolve('jayson/lib/client/browser'), 'utf8');
  assert.match(client, /require\('uuid'\).v4/);
});
