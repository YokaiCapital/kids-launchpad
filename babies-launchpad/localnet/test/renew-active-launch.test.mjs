import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,existsSync,readFileSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {canRenewActiveCampaign,archiveActiveCampaignFiles,restoreArchivedCampaignFiles,unresolvedIntents,parseRenewSetting,tokenAlreadyApplied,ACTIVE_CAMPAIGN_FILES} from '../renew-active-launch.mjs';
const failed={configured:true,phase:'failed',totalLamports:'16000000',refundedLamports:'16000000',receiptCount:'6',settledReceiptCount:'6',escrowAddress:'J7KdyyREzrcyzZWpEVo2t2oGYncXyh4gSotgCVxj7ske'};
test('only a failed, fully refunded, fully settled campaign may be renewed',()=>{
 assert.equal(canRenewActiveCampaign(failed).ok,true);
 assert.equal(canRenewActiveCampaign({...failed,phase:'launched'}).ok,false);assert.equal(canRenewActiveCampaign({...failed,phase:'open'}).ok,false);
 assert.match(canRenewActiveCampaign({...failed,refundedLamports:'15000000'}).reason,/refunds outstanding/);
 assert.match(canRenewActiveCampaign({...failed,settledReceiptCount:'5'}).reason,/not all settled/);
 assert.equal(canRenewActiveCampaign({configured:false}).ok,false);assert.equal(canRenewActiveCampaign(null).ok,false);
});
test('archiving moves every campaign file into archive/<campaign> and refuses to overwrite an existing archive',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-renew-'));const c=failed.escrowAddress;
 for(const f of ACTIVE_CAMPAIGN_FILES)writeFileSync(join(dir,f),'{"x":1}');writeFileSync(join(dir,'parent-snapshot-'+c+'.json'),'{}');writeFileSync(join(dir,'unrelated.json'),'{}');
 const r=archiveActiveCampaignFiles(dir,c);assert.equal(r.moved.length,ACTIVE_CAMPAIGN_FILES.length+1);
 for(const f of ACTIVE_CAMPAIGN_FILES)assert.ok(!existsSync(join(dir,f))&&existsSync(join(r.target,f)),f);
 assert.ok(existsSync(join(dir,'unrelated.json')),'unrelated files untouched');assert.equal(readFileSync(join(r.target,'active-launch.json'),'utf8'),'{"x":1}');
 writeFileSync(join(dir,'active-launch.json'),'{}');assert.throws(()=>archiveActiveCampaignFiles(dir,c),/already holds/);
 assert.throws(()=>archiveActiveCampaignFiles(dir,'../x'),/Campaign address/);
});

test("mode 'any' renews a launched campaign only when settled and nothing is pending; 'finished' never does",()=>{
 const launched={...failed,phase:'launched',refundedLamports:'0'};
 assert.equal(canRenewActiveCampaign(launched).ok,false);assert.equal(canRenewActiveCampaign(launched,{mode:'finished'}).ok,false);
 assert.equal(canRenewActiveCampaign(launched,{mode:'any'}).ok,true);assert.equal(canRenewActiveCampaign(failed,{mode:'any'}).ok,true);
 assert.equal(canRenewActiveCampaign({...launched,settledReceiptCount:'5'},{mode:'any'}).ok,false);
 assert.match(canRenewActiveCampaign(launched,{mode:'any',unresolved:[{service:'postlaunch-claims',unresolvedSigned:1}]}).reason,/unresolved/);
 assert.equal(canRenewActiveCampaign({...launched,phase:'open'},{mode:'any'}).ok,false);assert.equal(canRenewActiveCampaign(failed,{mode:'bogus'}).ok,false);
});
test('unresolved signed intents are detected across the three intent files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-renew-intents-'));
 writeFileSync(join(dir,'active-launch-intents.json'),JSON.stringify({a:{submittedSignature:'sig',confirmedSignature:'sig'},b:{unsignedTransactionBase64:'x'}}));
 assert.deepEqual(unresolvedIntents(dir),[]);
 writeFileSync(join(dir,'postlaunch-trade-intents.json'),JSON.stringify({t:{signature:'sig'}}));
 assert.deepEqual(unresolvedIntents(dir),[{service:'postlaunch-trades',unresolvedSigned:1}]);
});
test('archiving also moves intent archive folders',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-renew-arch-'));const c=failed.escrowAddress;
 writeFileSync(join(dir,'active-launch.json'),'{}');const a=join(dir,'active-launch-intents.json.archive');require_mkdir(a);writeFileSync(join(a,'0001.json'),'{}');
 const r=archiveActiveCampaignFiles(dir,c);assert.ok(r.moved.includes('active-launch-intents.json.archive'));assert.ok(existsSync(join(r.target,'active-launch-intents.json.archive','0001.json')));
});
function require_mkdir(p){mkdirSync(p,{recursive:true});}

test("mode 'any' replaces an open campaign only while nobody has committed",()=>{
 const empty={...failed,phase:'open',totalLamports:'0',refundedLamports:'0',receiptCount:'0',settledReceiptCount:'0'};
 assert.equal(canRenewActiveCampaign(empty,{mode:'any'}).ok,true);assert.equal(canRenewActiveCampaign(empty,{mode:'finished'}).ok,false);
 assert.equal(canRenewActiveCampaign({...empty,receiptCount:'1',settledReceiptCount:'1',totalLamports:'5'},{mode:'any'}).ok,false);
 assert.equal(canRenewActiveCampaign({...empty,totalLamports:'5'},{mode:'any'}).ok,false);
});

test("'any' needs a token so a restart never archives a launched coin twice; 'finished' does not",()=>{
 assert.deepEqual(parseRenewSetting('finished'),{mode:'finished',token:null,refused:null});
 assert.match(parseRenewSetting('any').refused,/needs a token/);
 assert.deepEqual(parseRenewSetting('any:1758580000'),{mode:'any',token:'1758580000',refused:null});
 assert.equal(parseRenewSetting('bogus'),null);assert.equal(parseRenewSetting(''),null);assert.equal(parseRenewSetting(undefined),null);
 const dir=mkdtempSync(join(tmpdir(),'kids-renew-token-'));assert.equal(tokenAlreadyApplied(dir,'t1'),false);
 writeFileSync(join(dir,'renew-applied.json'),JSON.stringify({tokens:['t1']}));assert.equal(tokenAlreadyApplied(dir,'t1'),true);assert.equal(tokenAlreadyApplied(dir,'t2'),false);assert.equal(tokenAlreadyApplied(dir,null),false);
});

test('restoring an archived campaign moves every file back and keeps whatever replaced it aside; nothing is deleted',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kids-restore-'));const campaign='9FjwHicbkzP17NEW94UasBa3LfWtqmsmddzstq8UqKxP';
 for(const name of ACTIVE_CAMPAIGN_FILES)writeFileSync(join(dir,name),JSON.stringify({real:true,name}));writeFileSync(join(dir,'parent-snapshot-'+campaign+'.json'),'{"real":true}');
 const archived=archiveActiveCampaignFiles(dir,campaign);assert.equal(archived.moved.length,ACTIVE_CAMPAIGN_FILES.length+1);
 writeFileSync(join(dir,'active-launch.json'),JSON.stringify({real:false,ready:false}));writeFileSync(join(dir,'active-launch-setup-keys.json'),'{"fresh":true}');
 const r=restoreArchivedCampaignFiles(dir,campaign,'stamp');
 assert.equal(r.moved.length,ACTIVE_CAMPAIGN_FILES.length+1);assert.deepEqual(r.replaced.sort(),['active-launch-setup-keys.json','active-launch.json']);
 assert.equal(JSON.parse(readFileSync(join(dir,'active-launch.json'),'utf8')).real,true);assert.equal(JSON.parse(readFileSync(join(dir,'archive',campaign+'-replaced-stamp','active-launch.json'),'utf8')).real,false);
 assert.throws(()=>restoreArchivedCampaignFiles(dir,campaign,'again'),/No archived campaign files/);assert.throws(()=>restoreArchivedCampaignFiles(dir,'bad address'),/invalid/);
});
