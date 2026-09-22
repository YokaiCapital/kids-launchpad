// All allocation amounts are raw token units. Calendar months use UTC and clamp month ends.
export function threeMonthsAfter(start) {
 if(!Number.isSafeInteger(start)||start<=0)throw Error('Launch timestamp must be positive whole Unix seconds');
 const d=new Date(start*1000),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+3);
 const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));
 return Math.floor(d.getTime()/1000);
}
export function devPlan(supply,start) {
 supply=BigInt(supply);if(supply<=0n||supply>18446744073709551615n)throw Error('Supply must fit u64');
 const immediate=supply*100n/10000n,linear=supply*200n/10000n;
 if(!immediate||!linear)throw Error('Supply too small');
 return {start,end:threeMonthsAfter(start),immediateRaw:immediate.toString(),linearRaw:linear.toString(),totalRaw:(immediate+linear).toString()};
}
export function scheduleBytes(kind,start,end) {
 const b=Buffer.alloc(kind==='launch'?9:17);b[0]=kind==='launch'?2:1;b.writeBigInt64LE(BigInt(start),1);
 if(kind!=='launch')b.writeBigInt64LE(BigInt(end),9);return b;
}
export function unlockedRaw(kind,amount,start,end,now) {
 amount=BigInt(amount);if(now<start)return 0n;if(kind==='launch'||now>=end)return amount;
 return amount*BigInt(now-start)/BigInt(end-start);
}
