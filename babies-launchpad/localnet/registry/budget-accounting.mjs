import {canonicalJson} from './canonical.mjs';
const address=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/,key=/^[A-Za-z0-9_.:-]{1,128}$/;
const select='SELECT descriptor,result_json FROM budget_operations WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? AND operation_key=?';
const insert='INSERT INTO budget_operations(genesis_hash,program_id,campaign,payer,operation_key,descriptor,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)';
export const budgetView=(b,held=0n)=>({reservedLamports:b.reserved.toString(),spentLamports:b.spent.toString(),returnedLamports:b.returned.toString(),availableLamports:(b.reserved-b.spent-b.returned-held).toString(),...(held?{heldLamports:held.toString()}:{}),policy:b.policy});
function normalize(input){
 const {genesisHash,programId,campaign,payer,operationKey,action,policy='creator-funded-v1'}=input;
 if(![genesisHash,programId,campaign,payer].every(v=>typeof v==='string'&&address.test(v)))throw Error('Budget needs a full campaign and payer identity');
 if(!key.test(operationKey??''))throw Error('Budget needs a stable operationKey');
 if(!['reserve','spend','return'].includes(action))throw Error('Unknown budget action');
 if(!key.test(policy))throw Error('Invalid budget policy');
 const text=String(input.lamports);if(!/^\d{1,40}$/.test(text))throw Error('lamports must be a non-negative integer');
 const lamports=BigInt(text).toString();
 return {identity:{genesisHash,programId,campaign,payer},binding:[genesisHash,programId,campaign,payer,operationKey],descriptor:canonicalJson({action,lamports,policy}),action,lamports,policy};
}
function existing(row,input){
 if(!row)return null;
 if(row.descriptor!==input.descriptor)throw Object.assign(Error('Budget operation key reused with different parameters'),{code:'IDEMPOTENCY_CONFLICT'});
 return JSON.parse(row.result_json);
}
function change(row,{action,lamports,policy},held=0n){
 const n=BigInt(lamports),b=row?{reserved:BigInt(row.reservedLamports),spent:BigInt(row.spentLamports),returned:BigInt(row.returnedLamports),policy:row.policy}:{reserved:0n,spent:0n,returned:0n,policy};
 const available=b.reserved-b.spent-b.returned-held;
 if(available<0n)throw Error('Budget accounting invariant violated');
 if(b.policy!==policy)return {result:{outcome:'refused',reason:'budget row follows policy '+b.policy}};
 if(action!=='reserve'&&(!row||n>available))return {result:{outcome:'insufficient',requestedLamports:n.toString(),availableLamports:available.toString(),...(action==='spend'?{shortfallLamports:(n-available).toString()}:{})}};
 if(action==='reserve')b.reserved+=n;else if(action==='spend')b.spent+=n;else b.returned+=n;
 const result={outcome:{reserve:'reserved',spend:'spent',return:'returned'}[action],budget:budgetView(b,held)};
 return {result,budget:{reservedLamports:b.reserved.toString(),spentLamports:b.spent.toString(),returnedLamports:b.returned.toString(),policy:b.policy}};
}
// Keep the sync legacy transaction callback sync; the shared backend awaits every
// statement. Both paths use the same validation, arithmetic and idempotency rules.
export function budgetAccounting(driver,budgets,{now=Date.now,async=false}={}){
 if(async)return async input=>{
  const x=normalize(input);
  return driver.transaction(async()=>{
   const prior=existing(await driver.get(select,x.binding),x);if(prior)return prior;
   const pending=await driver.get("SELECT COALESCE(SUM(CAST(maximum_lamports AS NUMERIC)),0) held FROM operating_spend_holds WHERE genesis_hash=? AND program_id=? AND campaign=? AND payer=? AND state='held'",x.binding.slice(0,4));
   const {result,budget}=change(await budgets.get(x.identity),x,BigInt(pending.held));
   if(budget)await budgets.put({...x.identity,...budget});
   await driver.run(insert,[...x.binding,x.descriptor,canonicalJson(result),new Date(now()).toISOString()]);
   return result;
  },{lockKey:'budget:'+x.binding.slice(0,4).join(':')});
 };
 return input=>{
  const x=normalize(input);
  return driver.transaction(()=>{
   const prior=existing(driver.get(select,x.binding),x);if(prior)return prior;
   const {result,budget}=change(budgets.get(x.identity),x);
   if(budget)budgets.put({...x.identity,...budget});
   driver.run(insert,[...x.binding,x.descriptor,canonicalJson(result),new Date(now()).toISOString()]);
   return result;
  });
 };
}
