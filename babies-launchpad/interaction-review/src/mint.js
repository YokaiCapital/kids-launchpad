export const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function isMintAddress(value) {
  if(typeof value!=='string' || value.length<32 || value.length>44)return false;
  let n=0n; for(const c of value){const i=alphabet.indexOf(c);if(i<0)return false;n=n*58n+BigInt(i);}
  let bytes=0;for(;n>0n;n>>=8n)bytes++;
  return bytes+(value.match(/^1*/)?.[0].length||0)===32;
}
export function tokenAmount(raw,decimals) {
  const s=BigInt(raw).toString().padStart(decimals+1,'0');
  const whole=(decimals?s.slice(0,-decimals):s).replace(/\B(?=(\d{3})+(?!\d))/g,',');
  const fraction=decimals?s.slice(-decimals).replace(/0+$/,''):'';
  return whole+(fraction?'.'+fraction:'');
}
export const thresholdRaw=supply=>(BigInt(supply)+1999n)/2000n;
export const shortMint=mint=>`${mint.slice(0,5)}…${mint.slice(-5)}`;
export function parseMint(mint,result,checkedAt=new Date().toISOString()) {
  if(!isMintAddress(mint))throw Error('Paste a valid Solana mint address (32-byte base58).');
  const account=result?.value, parsed=account?.data?.parsed, info=parsed?.info;
  if(!account)throw Error('No account exists at this address on the selected Solana network.');
  if(![TOKEN_PROGRAM,TOKEN_2022].includes(account.owner) || account.executable || parsed?.type!=='mint' || info?.isInitialized!==true)throw Error('This address is not an initialized token mint. Paste the mint, not a wallet or token account.');
  if(!/^\d+$/.test(info.supply) || BigInt(info.supply)>18446744073709551615n || !Number.isInteger(info.decimals) || info.decimals<0 || info.decimals>255 || !Number.isSafeInteger(result.context?.slot))throw Error('The RPC returned incomplete mint data. Retry lookup.');
  const supported=account.owner===TOKEN_PROGRAM && BigInt(info.supply)>0n;
  return {mint,supply:info.supply,decimals:info.decimals,slot:result.context.slot,checkedAt,program:account.owner,
    mintAuthority:info.mintAuthority||null,freezeAuthority:info.freezeAuthority||null,supported,
    reason:account.owner===TOKEN_2022?'Token-2022 parent support is not qualified yet. Choose a standard SPL mint.':BigInt(info.supply)===0n?'A zero-supply token cannot be selected as a parent.':''};
}
export function savedMint(value) {
  if(!value || !isMintAddress(value.mint) || !/^\d+$/.test(value.supply) || BigInt(value.supply)>18446744073709551615n || !Number.isInteger(value.decimals) || value.decimals<0 || value.decimals>255 || !Number.isSafeInteger(value.slot) || !Number.isFinite(Date.parse(value.checkedAt)) || value.program!==TOKEN_PROGRAM || BigInt(value.supply)===0n)return null;
  return {...value,supported:true};
}
export async function lookupMint(mint,signal) {
  if(!isMintAddress(mint))throw Error('Paste a valid Solana mint address (32-byte base58).');
  const response=await fetch(`/api/parents?mint=${encodeURIComponent(mint)}`,{signal,headers:{Accept:'application/json'}});
  if(!response.headers.get('content-type')?.includes('application/json'))throw Error('Live lookup is unavailable here. Open the local preview with its lookup service.');
  const payload=await response.json();
  if(!response.ok)throw Error(payload.error||'Lookup unavailable. Your current parents are kept. Retry shortly.');
  return payload;
}
