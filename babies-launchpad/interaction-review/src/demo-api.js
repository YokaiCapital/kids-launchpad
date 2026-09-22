async function request(options){
  let response;
  try{response=await fetch('/api/demo',{...options,signal:AbortSignal.timeout(20000)});}catch{throw Error("Local service is unavailable. Your draft and previous vote are kept.");}
  let result;try{result=await response.json();}catch{throw Error("This preview does not have the local service.");}
  if(!response.ok)throw Error(result.error||"Local request failed");return result;
}
export const loadDemo=()=>request();
export const saveDemo=input=>request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
