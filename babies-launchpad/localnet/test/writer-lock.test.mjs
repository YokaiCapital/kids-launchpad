import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
test('Linux kernel writer lock rejects a second writer and releases on direct child termination',{skip:process.platform!=='linux',timeout:10000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-writer-lock-')),lock=join(dir,'api-writer.lock');
 const child=spawn('flock',['--nonblock','--no-fork',lock,process.execPath,'-e',"console.log(process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});});
 const ready=await Promise.race([once(child.stdout,'data'),once(child,'error').then(([error])=>{throw error;}),once(child,'exit').then(()=>{throw Error('Lock owner exited before ready');})]);
 assert.equal(Number(String(ready[0]).trim()),child.pid,'--no-fork must retain the directly supervised PID');
 const second=spawnSync('flock',['--nonblock','--no-fork',lock,process.execPath,'-e','process.exit(0)']);assert.equal(second.status,1);
 const exited=once(child,'exit');child.kill('SIGTERM');await exited;
 const recovered=spawnSync('flock',['--nonblock','--no-fork',lock,process.execPath,'-e','process.exit(0)']);assert.equal(recovered.status,0);
});
