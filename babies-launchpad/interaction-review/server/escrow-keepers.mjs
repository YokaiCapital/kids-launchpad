// Independent leases prevent an absent or slow legacy service from blocking v3.
export function createEscrowKeepers(jobs,onError){
 const busy=new Set();
 return ()=>Promise.allSettled(Object.entries(jobs).map(async([name,run])=>{
  if(busy.has(name))return;busy.add(name);
  try{await run();}catch(error){onError(name,error);}finally{busy.delete(name);}
 }));
}
