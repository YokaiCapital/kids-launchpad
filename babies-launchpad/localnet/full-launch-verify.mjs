// Fixed local-only qualification sequence used by the operator panel.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let activeChild;process.on('SIGTERM',()=>{activeChild?.kill('SIGTERM');process.exitCode=1;});
for(const [stage,file] of [['launch-and-claims','atomic-launch-verify.mjs'],['fees-and-parent-burns','verify-atomic-fees.mjs']]){
 console.log('KIDS_STAGE:'+stage);
 await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL(file,import.meta.url))],{stdio:'inherit'});activeChild=child;child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(stage+' failed with code '+code)));});
}
console.log('KIDS_STAGE:complete');
