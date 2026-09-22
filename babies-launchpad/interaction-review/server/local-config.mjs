import {withLaunchPolicy} from '../../localnet/launch-policy.mjs';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export function readLocalConfig(){
 const operator=fileURLToPath(new URL('../../protocol/.runtime/operator.sqlite',import.meta.url));
 if(existsSync(operator)){const db=new DatabaseSync(operator,{readOnly:true});try{const row=db.prepare('SELECT body FROM settings WHERE id=1').get();if(row)return withLaunchPolicy(JSON.parse(row.body));}finally{db.close();}}
 const file=fileURLToPath(new URL('../../localnet/.runtime/config.json',import.meta.url));
 return existsSync(file)?withLaunchPolicy(JSON.parse(readFileSync(file,'utf8'))):null;
}
