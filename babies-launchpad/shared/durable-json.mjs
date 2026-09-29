// Single-writer journal durability: file contents reach storage before atomic rename,
// then the containing directory is synced before the caller may broadcast a transaction.
import * as fs from 'node:fs';
import {dirname,basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';
export function createDurableJsonWriter(io=fs){
 return function writeDurableJson(path,value){
  const body=JSON.stringify(value,null,2)+'\n';
  const directory=dirname(path),temporary=join(directory,`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd,dir,renamed=false;
  try{
   fd=io.openSync(temporary,'wx',0o600);
   io.writeFileSync(fd,body,'utf8');io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   io.renameSync(temporary,path);renamed=true;
   dir=io.openSync(directory,'r');io.fsyncSync(dir);io.closeSync(dir);dir=undefined;
  }finally{
   if(fd!==undefined)try{io.closeSync(fd);}catch{}
   if(dir!==undefined)try{io.closeSync(dir);}catch{}
   if(!renamed)try{io.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
 };
}
export const writeDurableJson=createDurableJsonWriter();
