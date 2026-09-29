// Draft Direct policy codec and offline model. Never imported by a live launch builder.
// Schedule and fee treatment must be provided explicitly; no default activates this feature.
import {createHash} from 'node:crypto';
import {recyclePool} from './model.mjs';
export const KIND='direct-liquidity-v1', DAY=86400n, U64_MAX=(1n<<64n)-1n;
export const POLICY_LEN=32;
export const SELECTED_TEMPORARY_FEE_TREATMENT='preserve-treasury-dev';
// Release precondition only: there is no production activation path in this offline module.
export function validateForActivation(p){
 if(p?.temporaryFeeTreatment!==SELECTED_TEMPORARY_FEE_TREATMENT)throw new Error('Owner selected preservation of treasury/dev fees from both LP halves');
 throw new Error('Fee-preserving harvesting and principal accounting are not implemented');
}
const keys=['kind','mode','permanentLpBps','temporaryLpBps','dailyRemainingBps','firstDelaySeconds','end','temporaryFeeTreatment'];
export function u64(value,name='amount'){
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw new TypeError(`${name}: unsafe integer`);
 if(!['number','string','bigint'].includes(typeof value)||!/^\d+$/.test(String(value)))throw new TypeError(`${name}: unsigned integer required`);
 const n=BigInt(value);if(n>U64_MAX)throw new RangeError(`${name}: exceeds u64`);return n;
}
function exact(object,fields,name){
 if(!object||Object.getPrototypeOf(object)!==Object.prototype||Object.keys(object).length!==fields.length||Object.keys(object).some(k=>!fields.includes(k)))throw new TypeError(`${name}: unexpected or missing field`);
}
export function validatePolicy(p){
 exact(p,keys,'Direct policy');
 if(p.kind!==KIND||p.mode!=='direct'||p.permanentLpBps!==5000||p.temporaryLpBps!==5000||p.dailyRemainingBps!==300)throw new Error('Direct policy must be separate 50/50 LP with 3% of remaining temporary LP');
 if(u64(p.firstDelaySeconds,'firstDelaySeconds')<DAY)throw new RangeError('First cycle requires at least 24 hours');
 if(p.temporaryFeeTreatment!=='recycle-with-principal')throw new Error('Temporary fee treatment not implemented');
 if(p.end?.kind==='until-dust')exact(p.end,['kind'],'end');
 else{
  exact(p.end,['kind','cycles'],'end');
  if(p.end.kind!=='after-cycles'||!Number.isSafeInteger(p.end.cycles)||p.end.cycles<1||p.end.cycles>0xffffffff)throw new Error('Invalid cycle limit');
 }
 return p;
}
export function encodePolicy(p){
 validatePolicy(p);const b=Buffer.alloc(POLICY_LEN);b.write('KIDSDLP1');b.writeUInt16LE(1,8);b[10]=1;
 if(p.end.kind==='after-cycles'){b[11]=1;b.writeUInt32LE(p.end.cycles,12);}
 b.writeBigUInt64LE(u64(p.firstDelaySeconds),16);b.writeUInt16LE(5000,24);b.writeUInt16LE(5000,26);b.writeUInt16LE(300,28);return b;
}
export function decodePolicy(input){
 const b=Buffer.from(input);
 if(b.length!==POLICY_LEN||b.subarray(0,8).toString()!=='KIDSDLP1'||b.readUInt16LE(8)!==1||b[10]!==1||b[11]>1)throw new Error('Unsupported Direct policy encoding');
 const p={kind:KIND,mode:'direct',permanentLpBps:5000,temporaryLpBps:5000,dailyRemainingBps:300,firstDelaySeconds:b.readBigUInt64LE(16).toString(),end:b[11]===0?{kind:'until-dust'}:{kind:'after-cycles',cycles:b.readUInt32LE(12)},temporaryFeeTreatment:'recycle-with-principal'};
 if(!encodePolicy(p).equals(b))throw new Error('Noncanonical Direct policy encoding');return p;
}
export function policyHash(p){return createHash('sha256').update('kids-direct-liquidity-policy-v1').update(encodePolicy(p)).digest('hex');}
export function splitLp(received){received=u64(received);const temporary=received/2n;if(!temporary)throw new RangeError('LP allocation rounds to zero');return{permanent:received-temporary,temporary};}
export function initialize(received,launchedAt,p){
 const hash=policyHash(p),{permanent,temporary}=splitLp(received),at=u64(launchedAt);
 u64(at+u64(p.firstDelaySeconds),'first cycle');
 return Object.freeze({policyHash:hash,initialLp:u64(received),permanentLp:permanent,remainingLp:temporary,redeemedLp:0n,relockedLp:0n,launchedAt:at,lastExecution:null,cycles:0,burnedWithdrawn:0n,burnedPurchased:0n,closed:false});
}
function verify(s,p){
 if(s.policyHash!==policyHash(p))throw new Error('Direct policy changed');
 for(const k of ['initialLp','permanentLp','remainingLp','redeemedLp','relockedLp','launchedAt','burnedWithdrawn','burnedPurchased'])u64(s[k],k);
 const parts=splitLp(s.initialLp),first=u64(s.launchedAt+u64(p.firstDelaySeconds));
 if(!Number.isSafeInteger(s.cycles)||s.cycles<0||s.cycles>2048||parts.permanent!==s.permanentLp||parts.temporary!==s.remainingLp+s.redeemedLp+s.relockedLp||typeof s.closed!=='boolean'||s.closed!==(s.remainingLp===0n)||(!s.closed&&s.relockedLp!==0n)||(s.cycles===0)!==(s.lastExecution===null)|| (s.lastExecution!==null&&u64(s.lastExecution)<first+BigInt(s.cycles-1)*DAY)|| (p.end.kind==='after-cycles'&&s.cycles>p.end.cycles))throw new Error('Invalid Direct custody/schedule state');
 let expected=parts.temporary;
 for(let i=0;i<s.cycles;i++){const slice=expected*300n/10000n;if(slice===0n)throw new Error('Cycles exceed LP budget');expected-=slice;}
 if(s.closed&&!(p.end.kind==='after-cycles'&&s.cycles>=p.end.cycles)&&expected*300n/10000n!==0n)throw new Error('Premature remainder lock');
 if(s.redeemedLp!==parts.temporary-expected||(!s.closed&&s.remainingLp!==expected)||(s.closed&&s.relockedLp!==expected)||(s.cycles===0&&(s.burnedWithdrawn!==0n||s.burnedPurchased!==0n))||(s.cycles>0&&(s.burnedWithdrawn<BigInt(s.cycles)||s.burnedPurchased<BigInt(s.cycles))))throw new Error('Invalid Direct budget trajectory');
 u64(s.burnedWithdrawn+s.burnedPurchased);
}
export function nextAction(s,p,now){
 verify(s,p);now=u64(now);
 if(s.closed)return{kind:'closed',lp:0n};
 if(p.end.kind==='after-cycles'&&s.cycles>=p.end.cycles)return{kind:'lock-remainder',lp:s.remainingLp};
 const due=u64(s.lastExecution===null?s.launchedAt+u64(p.firstDelaySeconds):s.lastExecution+DAY);
 if(now<due)return{kind:'wait',lp:0n,due};
 const lp=s.remainingLp*300n/10000n;return lp?{kind:'recycle',lp}:{kind:'lock-remainder',lp:s.remainingLp};
}
export function simulateStep(s,p,now,pool){
 const action=nextAction(s,p,now);now=u64(now);
 if(u64(pool.lpSupply)<s.permanentLp+s.remainingLp+s.relockedLp)throw new Error('Pool LP supply below tracked protected custody');
 if(action.kind==='wait'||action.kind==='closed')return{state:s,pool,action};
 if(action.kind==='lock-remainder')return{state:Object.freeze({...s,remainingLp:0n,relockedLp:s.relockedLp+action.lp,closed:true}),pool,action};
 const result=recyclePool({...pool,lpAmount:action.lp});
 const state=Object.freeze({...s,remainingLp:s.remainingLp-action.lp,redeemedLp:s.redeemedLp+action.lp,lastExecution:now,cycles:s.cycles+1,burnedWithdrawn:u64(s.burnedWithdrawn+result.withdrawnTokens),burnedPurchased:u64(s.burnedPurchased+result.boughtTokens)});
 verify(state,p);
 return{state,pool:{...pool,tokenReserve:result.tokenReserve,solReserve:result.solReserve,lpSupply:result.lpSupply},action,result};
}
