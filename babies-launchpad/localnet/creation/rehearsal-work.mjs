// Fail a rehearsal only after every in-flight action has settled. Never close a
// signer/database or erase fixture keys while another action is still using it.
export async function runRehearsalBatch(items,concurrency,fn){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('Rehearsal concurrency must be 1..8');
 let next=0,failure=null;const results=[];
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(!failure){const i=next++;if(i>=items.length)return;try{results[i]=await fn(items[i],i);}catch(e){failure??=e;}}
 }));
 if(failure)throw failure;return results;
}
