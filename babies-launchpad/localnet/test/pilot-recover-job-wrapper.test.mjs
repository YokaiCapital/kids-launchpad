// The owner wrapper must return the command's exit status through its output filter: a refused recovery (exit 2), an
// SSH failure (exit 1) and a success (exit 0); a usage error is 64. A stub "railway" on PATH stands in for the CLI;
// nothing leaves this machine. The script is POSIX sh, so it is exercised under sh and, where installed, under zsh.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const wrapper=join(dirname(fileURLToPath(import.meta.url)),'..','..','deployment','hosted','pilot-recover-job.sh');
const shells=['sh',...(spawnSync('zsh',['-c','true']).status===0?['zsh']:[])];
function run(shell,stub,args=['--job','j','--reason','r','--recovery-id','id','--dry-run']){
 const dir=mkdtempSync(join(tmpdir(),'kids-wrapper-'));
 try{
  const bin=join(dir,'railway');writeFileSync(bin,'#!/bin/sh\n'+stub+'\n');chmodSync(bin,0o755);
  const r=spawnSync(shell,[wrapper,...args],{env:{...process.env,PATH:dir+':'+process.env.PATH},encoding:'utf8'});
  assert.equal(r.error,undefined,'spawn failed for '+shell+': '+(r.error&&r.error.message));
  return {status:r.status,stdout:r.stdout,stderr:r.stderr};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('pilot-recover-job.sh exits with the command status under every shell: refused 2, ssh failure 1, success 0; usage error 64',()=>{
 assert.ok(shells.includes('sh'));
 for(const shell of shells){
  const refused=run(shell,'echo "warning: newer Railway CLI available"; echo \'{"refused":true,"code":"RECOVERY_CONFLICT","message":"x"}\'; exit 2');
  assert.equal(refused.status,2,shell+' refused status');assert.match(refused.stdout,/"refused":true/);assert.doesNotMatch(refused.stdout,/newer Railway CLI/);
  const ssh=run(shell,'echo "ssh: connect failed" >&2; exit 1');assert.equal(ssh.status,1,shell+' ssh failure status');
  const ok=run(shell,'echo \'{"before":{}}\'; echo \'{"dryRun":true}\'; exit 0');assert.equal(ok.status,0,shell+' success status');assert.match(ok.stdout,/"dryRun":true/);
  const usage=run(shell,'exit 0',['--job']);assert.equal(usage.status,64,shell+' usage status');
 }
});
