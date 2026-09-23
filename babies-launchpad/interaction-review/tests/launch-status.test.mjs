import test from 'node:test';import assert from 'node:assert/strict';import {describeLaunch,formatCountdown,solText} from '../src/launch-status.mjs';
const base={configured:true,phase:'open',chainTimeUnix:1000,deadlineUnix:1300,launchDeadlineUnix:1300+86400,totalLamports:'400000000',softCapLamports:'1000000000',hardCapLamports:'5000000000',mint:'M',pool:null,escrowAddress:'E',explorerUrl:null};
test('countdown formats minutes, hours and days',()=>{assert.equal(formatCountdown(299),'04:59');assert.equal(formatCountdown(3661),'01:01:01');assert.equal(formatCountdown(90061),'1d 01h 01m');assert.equal(formatCountdown(-5),'00:00');});
test('open: countdown to close and progress against soft and hard cap',()=>{
 const d=describeLaunch(base,1000);assert.equal(d.phase,'open');assert.equal(d.countdown.seconds,300);assert.equal(d.countdown.label,'Closes in');assert.equal(d.progress.raised,'0.4');assert.equal(d.progress.pct,8);assert.equal(d.progress.softPct,20);assert.equal(d.progress.reached,false);
 const r=describeLaunch({...base,totalLamports:'1500000000'},1000);assert.match(r.headline,/Soft cap reached/);assert.equal(r.progress.reached,true);
});
test('closed, failed and launched states say what happened and what to do',()=>{
 const a=describeLaunch({...base,phase:'awaiting-launch'},1400);assert.equal(a.pill,'Launching');assert.equal(a.countdown,null);assert.match(a.sub,/refunded/);
 const f=describeLaunch({...base,phase:'failed'},2000);assert.equal(f.pill,'Not launched');assert.match(f.sub,/Only 0\.4 of the 1 SOL soft cap/);assert.match(f.sub,/refund/);assert.equal(f.countdown,null);
 const f2=describeLaunch({...base,phase:'failed',totalLamports:'2000000000'},2000);assert.match(f2.sub,/launch window closed/);
 const l=describeLaunch({...base,phase:'launched',pool:'P',totalLamports:'1000000000'},2000);assert.equal(l.pill,'Live');assert.deepEqual(l.addresses.map(x=>x.value),['M','P','E']);assert.equal(l.explorerUrl,null);
});
test('no campaign and loading states',()=>{assert.equal(describeLaunch({configured:false},0).phase,'unscheduled');assert.equal(describeLaunch(null,0).phase,'loading');assert.equal(solText('123456789012'),'123.46');});
test('no campaign: a planned schedule shows an opening countdown and the planned terms; without a date, "to be announced"',()=>{
 const next={coin:'Shartcoin',opensAtUnix:2000,terms:{soft:'1000000000',hard:'5000000000',deadlineSeconds:3600}};
 const d=describeLaunch({configured:false,next},1000);assert.equal(d.phase,'scheduled');assert.equal(d.countdown.seconds,1000);assert.match(d.headline,/Shartcoin opens/);assert.match(d.sub,/Soft cap 1 SOL/);assert.equal(d.progress.hard,'5');
 const u=describeLaunch({configured:false,next:{...next,opensAtUnix:null}},1000);assert.equal(u.phase,'unscheduled');assert.match(u.headline,/to be announced/);assert.ok(u.progress);
 assert.equal(describeLaunch({configured:false},0).progress,null);
});
