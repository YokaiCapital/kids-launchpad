import test from 'node:test';import assert from 'node:assert/strict';
import {creationFunding} from '../server/public-creation.mjs';
test('creation funding: the wallet must hold the setup costs plus the operating reserve, said in plain words',()=>{
 const costs={totalLamports:'269714238'};
 const short=creationFunding({costs,reserveLamports:'100000000',balanceLamports:18737495});
 assert.equal(short.neededLamports,'369714238');assert.equal(short.shortfallLamports,'350976743');
 assert.equal(short.message,'Your wallet holds 0.019 SOL; creating needs about 0.370 SOL (setup costs plus the operating reserve). Add funds and try again.');
 const ok=creationFunding({costs,reserveLamports:'100000000',balanceLamports:2_000_000_000});assert.equal(ok.message,null);assert.equal(ok.shortfallLamports,'0');
 assert.equal(creationFunding({costs,balanceLamports:'269714238'}).message,null,'no reserve when the manifest has none; exact balance is enough');
});
