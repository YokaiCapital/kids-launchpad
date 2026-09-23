import {useEffect,useRef,useState} from 'react';
import {discoverWallets,subscribeWallets,selectWallet,getSelectedWallet,forgetWallet,validateWalletChallenge} from './wallet-connection.mjs';
import {disconnectAndSignOut} from './wallet-sign-out.mjs';
import './wallet-connection.css';
// One request, one intent: a busy answer (429/503 with Retry-After up to 5 s) is retried ONCE with the identical body,
// so the request id and the prepared intent are preserved. Errors carry status and retryAfter for the page.
export async function accountApi(path,body,csrf,{retries=1}={}){
 const response=await fetch('/api/account/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Kids-CSRF':csrf}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
 if(!response.headers.get('content-type')?.includes('application/json'))throw Object.assign(Error('Local account service unavailable'),{status:response.status});
 const result=await response.json();
 if((response.status===429||response.status===503)&&retries>0){const after=Number(response.headers.get('retry-after')||result.retryAfter||0);if(after>0&&after<=5){await new Promise(r=>setTimeout(r,after*1000));return accountApi(path,body,csrf,{retries:retries-1});}}
 if(!response.ok)throw Object.assign(Error(result.error||'Account request failed'),{status:response.status,retryAfter:Number(response.headers.get('retry-after')||result.retryAfter||0)||null});
 return result;
}
export function Account({onChange}){
 const [state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[wallets,setWallets]=useState(()=>discoverWallets());
 const running=useRef(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;accountApi('state').then(s=>{if(mounted.current)setState(s);}).catch(e=>setError(e.message));const update=()=>setWallets(discoverWallets()),unsubscribe=subscribeWallets(update);window.addEventListener('focus',update);return()=>{mounted.current=false;unsubscribe();window.removeEventListener('focus',update);};},[]);
 async function act(label,fn){if(running.current)return;running.current=true;setBusy(label);setError('');try{const result=await fn();if(mounted.current){const next={...state,...result};setState(next);onChange?.(next);}}catch(e){if(mounted.current)setError(e.message);}finally{running.current=false;if(mounted.current)setBusy('');}}
 async function connect(choice){
  // Explicit click only. A failed or abandoned attempt forgets the choice so the next
  // transaction cannot silently reuse a wallet that never finished signing in.
  const provider=selectWallet(choice);
  try{
   const connected=await provider.connect(),owner=connected.publicKey.toString();
   const assertCurrent=()=>{if(!mounted.current||provider.publicKey?.toString()!==owner)throw Error('Wallet changed. Choose your wallet again.');};assertCurrent();
   const challenge=await accountApi('challenge',{owner},state.csrf);assertCurrent();
   validateWalletChallenge(challenge,owner,location.origin);
   const signed=await provider.signMessage(new TextEncoder().encode(challenge.message),'utf8');assertCurrent();
   const session=await accountApi('verify',{id:challenge.id,signature:btoa(String.fromCharCode(...signed.signature))},state.csrf);
   if(session.owner!==owner)throw Error('Signed-in wallet does not match the connected wallet.');
   return session;
  }catch(e){forgetWallet();throw e;}
 }
 async function signOut(){let next;const result=await disconnectAndSignOut({disconnect:async()=>{try{await getSelectedWallet().disconnect?.();}catch{}},forgetWallet,logout:async()=>{next=await accountApi('logout',{},state.csrf);}});if(!result.sessionRevoked)throw Error('Wallet removed. Sign-out could not finish; retry before connecting again.');return next;}
 return <section className="wallet-account kids-wallet"><div className="kids-wallet-heading"><img src="/assets/kids-logo-integrated-v1.png" alt="KIDS"/><span>Solana wallets</span></div><h3>{state?.owner?'You’re connected.':'Pick your wallet.'}</h3><p className="small muted">{state?.owner?'Your wallet stays in control.':'Sign one message to get started. No payment or transaction.'}</p>
 {state?.owner?<><div className="kids-wallet-address">{state.owner}</div><button disabled={!!busy} onClick={()=>act('Signing out…',signOut)}>Disconnect & sign out</button></>:<div className="kids-wallet-list" aria-busy={!!busy}>{wallets.map(choice=>choice.install?<a key={choice.id} className="kids-wallet-install" href={choice.install} target="_blank" rel="noreferrer"><span className="kids-wallet-monogram" aria-hidden="true">{choice.name[0]}</span><strong>{choice.name}</strong><span>Not installed · Install ↗</span></a>:<button key={choice.id} className={choice.paused?'kids-wallet-paused':''} disabled={!state||!!busy||!!choice.paused} aria-disabled={!!choice.paused} title={choice.paused||undefined} onClick={()=>act('Connecting '+choice.name+'…',()=>connect(choice))}>{choice.icon?.startsWith('data:image/')?<img src={choice.icon} alt=""/>:<span className="kids-wallet-monogram" aria-hidden="true">{choice.name[0]}</span>}<strong>{choice.name}</strong><span>{choice.paused||'Detected ↗'}</span></button>)}{!wallets.some(w=>!w.install)&&<div className="kids-wallet-empty"><strong>No wallet detected in this browser</strong><p>Install one above, or open this site inside your wallet’s browser, then check again.</p><button onClick={()=>setWallets(discoverWallets())}>Check again</button></div>}</div>}
 {busy&&<p role="status">{busy} Check your wallet.</p>}{error&&<p role="alert" className="warning">{error}</p>}
 {Object.keys(state?.localIdentities||{}).length>0&&<details className="kids-wallet-testing"><summary>Localnet test wallets</summary><div className="admin-actions">{Object.keys(state.localIdentities).map(identity=><button key={identity} disabled={!!busy} onClick={()=>act('Opening test wallet…',()=>accountApi('local',{identity},state.csrf))}>Use {identity}</button>)}</div></details>}<p className="kids-wallet-footnote">Transactions are requested separately. This site currently uses localnet.</p></section>;
}
