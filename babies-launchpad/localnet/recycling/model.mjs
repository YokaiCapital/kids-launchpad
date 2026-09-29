// Research model only. No transaction builders, RPC, signer, keeper or activation path.
// Values are integer raw units; this is not an exact simulator of a deployed Raydium release.
import {canonicalHash} from '../registry/canonical.mjs';

const BPS=10000n, PPM=1000000n, MAX=(1n<<64n)-1n;
export const DAY=86400n;
export const POLICY_KIND='standard-bounded-recycling-v1';
const KEYS=['kind','mode','permanentLpBps','recyclableLpBps','dailyRemainingBps','durationDays'];
function amount(value,name){
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw new RangeError(`${name}: unsafe integer`);
 if(!['bigint','number','string'].includes(typeof value)||!/^\d+$/.test(String(value)))throw new TypeError(`${name}: unsigned integer required`);
 const n=BigInt(value);if(n>MAX)throw new RangeError(`${name}: exceeds u64`);return n;
}
function integer(n,min,max,name){if(!Number.isSafeInteger(n)||n<min||n>max)throw new RangeError(`${name}: outside research bounds`);}
export function validatePolicy(p){
 if(!p||Object.getPrototypeOf(p)!==Object.prototype||Object.keys(p).length!==KEYS.length||Object.keys(p).some(k=>!KEYS.includes(k)))throw new TypeError('Unexpected or missing recycling policy field');
 if(p.kind!==POLICY_KIND||p.mode!=='standard')throw new Error('Recycling research is Standard only');
 // Research envelope, not owner-approved launch terms or a production safety assessment.
 integer(p.permanentLpBps,9000,9999,'permanentLpBps');integer(p.recyclableLpBps,1,1000,'recyclableLpBps');
 if(p.permanentLpBps+p.recyclableLpBps!==10000)throw new Error('LP shares must sum to 10000');
 integer(p.dailyRemainingBps,1,100,'dailyRemainingBps');integer(p.durationDays,2,365,'durationDays');
 return p;
}
export function policyHash(p){validatePolicy(p);return canonicalHash({domain:'kids-recycling-research-v1',policy:p});}
export function splitLaunchLp(initialLp,policy){
 validatePolicy(policy);initialLp=amount(initialLp,'initialLp');
 const recyclable=initialLp*BigInt(policy.recyclableLpBps)/BPS;
 if(recyclable===0n)throw new RangeError('Recycling allocation rounds to zero');
 return {permanent:initialLp-recyclable,recyclable}; // rounding favours permanent custody
}
export function initialize(initialLp,launchedAt,policy){
 const parts=splitLaunchLp(initialLp,policy);launchedAt=amount(launchedAt,'launchedAt');
 const sunsetAt=amount(launchedAt+BigInt(policy.durationDays)*DAY,'sunsetAt');
 return Object.freeze({policyHash:policyHash(policy),initialLp:amount(initialLp,'initialLp'),permanentLp:parts.permanent,
  initialRecyclableLp:parts.recyclable,remainingLp:parts.recyclable,recycledLp:0n,relockedLp:0n,
  launchedAt,lastExecutedAt:launchedAt,sunsetAt,closed:false});
}
function verifyState(s,p){
 if(s.policyHash!==policyHash(p))throw new Error('Policy changed after launch');
 for(const k of ['initialLp','permanentLp','initialRecyclableLp','remainingLp','recycledLp','relockedLp','launchedAt','lastExecutedAt','sunsetAt'])amount(s[k],k);
 if(s.permanentLp+s.initialRecyclableLp!==s.initialLp||s.remainingLp+s.recycledLp+s.relockedLp!==s.initialRecyclableLp)throw new Error('LP custody conservation failed');
 const expected=splitLaunchLp(s.initialLp,p);
 if(s.permanentLp!==expected.permanent||s.initialRecyclableLp!==expected.recyclable)throw new Error('Initial LP split differs from sealed policy');
 if(s.sunsetAt!==s.launchedAt+BigInt(p.durationDays)*DAY||s.lastExecutedAt<s.launchedAt||s.lastExecutedAt>=s.sunsetAt)throw new Error('Invalid schedule state');
 if(typeof s.closed!=='boolean'||(s.closed&&s.remainingLp!==0n)||(!s.closed&&s.relockedLp!==0n))throw new Error('Invalid closure state');
}
export function nextAction(state,policy,now){
 verifyState(state,policy);now=amount(now,'now');
 if(state.closed)return {kind:'closed',lp:0n};
 if(now>=state.sunsetAt)return {kind:'lock-remainder',lp:state.remainingLp};
 if(now<state.lastExecutedAt+DAY)return {kind:'wait',lp:0n};
 const lp=state.remainingLp*BigInt(policy.dailyRemainingBps)/BPS;
 return lp===0n?{kind:'lock-remainder',lp:state.remainingLp}:{kind:'recycle',lp};
}
// Model one atomic withdrawal + token burn + same-pool swap + output burn.
// Protocol/fund fee shares are removed from economic reserves, even if still in the raw vault.
// Creator fee and transfer-fee tokens are outside this research model and refused by policy design.
export function recyclePool({tokenReserve,solReserve,lpSupply,lpAmount,tradeFeePpm,protocolFeeSharePpm,fundFeeSharePpm}){
 const x=amount(tokenReserve,'tokenReserve'),y=amount(solReserve,'solReserve'),l=amount(lpSupply,'lpSupply'),r=amount(lpAmount,'lpAmount');
 const feeRate=amount(tradeFeePpm,'tradeFeePpm'),protocol=amount(protocolFeeSharePpm,'protocolFeeSharePpm'),fund=amount(fundFeeSharePpm,'fundFeeSharePpm');
 if(x===0n||y===0n||r===0n||r>=l||feeRate>=PPM||protocol+fund>PPM)throw new RangeError('Invalid pool or fee parameters');
 const withdrawnTokens=x*r/l,withdrawnSol=y*r/l;
 if(withdrawnTokens===0n||withdrawnSol===0n)throw new RangeError('Withdrawal rounds to dust');
 const fee=(withdrawnSol*feeRate+PPM-1n)/PPM,net=withdrawnSol-fee;
 if(net<=0n)throw new RangeError('Fee consumes the input');
 const boughtTokens=(x-withdrawnTokens)*net/(y-withdrawnSol+net);
 if(boughtTokens===0n)throw new RangeError('Buy rounds to dust');
 const protocolFee=fee*protocol/PPM,fundFee=fee*fund/PPM;
 return {tokenReserve:x-withdrawnTokens-boughtTokens,solReserve:y-protocolFee-fundFee,lpSupply:l-r,
  withdrawnTokens,withdrawnSol,boughtTokens,burnedTokens:withdrawnTokens+boughtTokens,
  swapFee:fee,protocolFee,fundFee,lpFee:fee-protocolFee-fundFee,returnedSol:withdrawnSol};
}
export function simulateStep(state,policy,now,pool){
 const action=nextAction(state,policy,now);now=amount(now,'now');
 if(amount(pool.lpSupply,'lpSupply')<state.permanentLp+state.remainingLp+state.relockedLp)throw new Error('Pool LP supply is below protected custody');
 if(action.kind==='closed'||action.kind==='wait')return {state,pool,action};
 if(action.kind==='lock-remainder')return {state:Object.freeze({...state,remainingLp:0n,relockedLp:state.relockedLp+action.lp,closed:true}),pool,action};
 // No caller-selected redemption amount; no use of donations or permanently locked LP.
 const result=recyclePool({...pool,lpAmount:action.lp});
 return {state:Object.freeze({...state,remainingLp:state.remainingLp-action.lp,recycledLp:state.recycledLp+action.lp,lastExecutedAt:now}),
  pool:{...pool,tokenReserve:result.tokenReserve,solReserve:result.solReserve,lpSupply:result.lpSupply},action,result};
}
