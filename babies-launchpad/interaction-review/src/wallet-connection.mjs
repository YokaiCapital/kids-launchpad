import {getWallets} from '@wallet-standard/app';
let selected=null;
const registry=getWallets();
const usable=w=>w.features?.['standard:connect']&&w.features?.['solana:signMessage']&&w.features?.['solana:signTransaction'];
// Every wallet prompt is bounded (Pairz wallet-connect-session lesson): a stalled or closed
// extension popup must not leave the page busy forever. A late answer has no continuation.
export const WALLET_DEADLINES={connectMs:60000,signMessageMs:60000,signTransactionMs:120000};
export function withWalletDeadline(promise,ms,label){
 let timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error(label+' timed out. Check your wallet, then try again.'),{name:'TimeoutError'})),ms);});
 return Promise.race([Promise.resolve(promise),deadline]).finally(()=>clearTimeout(timer));
}
const unchanged=(before,after,what)=>{if(before!==after)throw Error('Wallet account changed during '+what+'. Reconnect before signing.');};
// Injected (non-Standard) providers get the same deadlines and account-consistency checks.
function injectedProvider(raw){
 return {
  get publicKey(){return raw.publicKey||null;},
  connect:()=>withWalletDeadline(raw.connect(),WALLET_DEADLINES.connectMs,'Wallet connection'),
  async signMessage(message,encoding){const before=raw.publicKey?.toString();const result=await withWalletDeadline(raw.signMessage(message,encoding),WALLET_DEADLINES.signMessageMs,'Message signing');unchanged(before,raw.publicKey?.toString(),'signing');return result;},
  async signTransaction(transaction){const before=raw.publicKey?.toString();const result=await withWalletDeadline(raw.signTransaction(transaction),WALLET_DEADLINES.signTransactionMs,'Transaction signing');unchanged(before,raw.publicKey?.toString(),'signing');return result;},
  disconnect:()=>raw.disconnect?.()
 };
}
// Phantom shows a malicious-site warning for domains it has not whitelisted yet. Until kids.fun is
// whitelisted, Phantom stays visible but cannot be selected, so nobody meets that warning here.
export const PAUSED_WALLETS={phantom:'Waiting for Phantom whitelisting'};
const pausedReason=name=>PAUSED_WALLETS[name.toLowerCase()]||null;
/** Always listed, in this order, whether or not the browser has them (owner, 23 Sep 2026: most people have Phantom and
 * might not notice the other options). A missing one is an install link, never a dead button. */
export const FEATURED_WALLETS=Object.freeze([
 Object.freeze({name:'Phantom',install:'https://phantom.com/download'}),
 Object.freeze({name:'Backpack',install:'https://backpack.app/download'}),
 Object.freeze({name:'Jupiter',install:'https://jup.ag/wallet',aliases:['Jupiter Wallet','Jupiter Mobile']}),
]);
const featuredIndex=name=>FEATURED_WALLETS.findIndex(f=>f.name.toLowerCase()===name.toLowerCase()||(f.aliases||[]).some(a=>a.toLowerCase()===name.toLowerCase()));
/** Detected wallets first (featured order, then the rest as found), then an install entry for each featured wallet that
 * is not detected. Install entries carry `install` (the download page) and no provider. */
export function discoverWallets(scope=globalThis.window){
 const detected=detectWallets(scope);
 const rank=w=>{const i=featuredIndex(w.name);return i<0?FEATURED_WALLETS.length:i;};
 detected.sort((a,b)=>rank(a)-rank(b));
 const missing=FEATURED_WALLETS.filter((f,i)=>!detected.some(w=>featuredIndex(w.name)===i)).map(f=>({id:'install:'+f.name,name:f.name,install:f.install,paused:pausedReason(f.name)}));
 return [...detected,...missing];
}
function detectWallets(scope){
 const standard=registry.get().filter(usable).map(wallet=>({id:'standard:'+wallet.name,name:wallet.name,icon:wallet.icon,wallet,paused:pausedReason(wallet.name)}));
 const injected=[['Phantom',scope?.phantom?.solana],['Solflare',scope?.solflare],['Backpack',scope?.backpack],['Solana wallet',scope?.solana]];
 const seen=new Set();
 for(const [name,provider] of injected){if(!provider?.connect||!provider.signMessage||!provider.signTransaction||seen.has(provider))continue;seen.add(provider);if(standard.some(w=>w.name.toLowerCase()===name.toLowerCase()))continue;standard.push({id:'injected:'+name,name,provider:injectedProvider(provider),paused:pausedReason(name)});}
 return standard;
}
export function subscribeWallets(fn){const a=registry.on('register',fn),b=registry.on('unregister',fn);return()=>{a();b();};}
export function standardProvider(wallet){
 let account=null,unsubscribe=null;
 const present=()=>!!account&&wallet.accounts.some(a=>a.address===account.address);
 const current=()=>{if(!present())throw Error('Wallet account changed. Reconnect before signing.');return account;};
 return {
 get publicKey(){return present()?{toString:()=>account.address}:null;},
 async connect(preferred){
  const result=await withWalletDeadline(wallet.features['standard:connect'].connect(),WALLET_DEADLINES.connectMs,'Wallet connection');
  // A wallet may expose several accounts; after a reload we must reconnect to the SIGNED-IN one, not the first.
  const usable=result.accounts.filter(a=>a.features.includes('solana:signMessage')&&a.features.includes('solana:signTransaction'));
  account=(preferred&&usable.find(a=>a.address===preferred))||usable[0];
  if(!account)throw Error('This wallet account cannot sign Solana messages and transactions.');
  // Drop the session when the wallet removes or switches the account (Wallet Standard change event).
  unsubscribe?.();unsubscribe=wallet.features['standard:events']?.on?.('change',({accounts})=>{if(accounts&&account&&!accounts.some(a=>a.address===account.address))account=null;})||null;
  return{publicKey:this.publicKey};
 },
 async signMessage(message){const expected=current();const [result]=await withWalletDeadline(wallet.features['solana:signMessage'].signMessage({account:expected,message}),WALLET_DEADLINES.signMessageMs,'Message signing');if(current().address!==expected.address||result.signedMessage.length!==message.length||!result.signedMessage.every((b,i)=>b===message[i]))throw Error('Wallet changed the sign-in message');return{signature:result.signature};},
 async signTransaction(transaction){const expected=current(),{VersionedTransaction}=await import('@solana/web3.js');const [result]=await withWalletDeadline(wallet.features['solana:signTransaction'].signTransaction({account:expected,transaction:transaction.serialize()}),WALLET_DEADLINES.signTransactionMs,'Transaction signing');if(current().address!==expected.address)throw Error('Wallet account changed');return VersionedTransaction.deserialize(result.signedTransaction);},
 async disconnect(){account=null;unsubscribe?.();unsubscribe=null;await wallet.features['standard:disconnect']?.disconnect();}
 };
}
// The wallet choice is a per-browser convenience (localStorage): the sign-in itself is a server cookie, so a
// direct link or a new tab must find the same wallet again instead of asking to "connect" while signed in.
// Reads fall back to the older sessionStorage key. A paused wallet is never restored.
const STORE_KEY='kids-wallet';
const readChoice=()=>{for(const store of [globalThis.localStorage,globalThis.sessionStorage]){try{const id=store?.getItem(STORE_KEY);if(id)return id;}catch{}}return null;};
const writeChoice=id=>{for(const store of [globalThis.localStorage,globalThis.sessionStorage]){try{if(id)store?.setItem(STORE_KEY,id);else store?.removeItem(STORE_KEY);}catch{}}};
export function selectWallet(choice){if(choice.install)throw Error(choice.name+' is not installed in this browser. Install it, then choose it here.');if(choice.paused)throw Error(choice.name+': '+choice.paused+'. Choose another wallet.');selected={id:choice.id,provider:choice.wallet?standardProvider(choice.wallet):choice.provider};writeChoice(choice.id);return selected.provider;}
export function getSelectedWallet(){if(!selected){const id=readChoice();const choice=discoverWallets().find(w=>w.id===id);if(choice&&!choice.paused&&!choice.install)selectWallet(choice);}if(!selected)throw Error('Choose your wallet in Connect wallet first.');return selected.provider;}
/** When no choice is stored, a Wallet Standard wallet that already lists the signed-in account is selected without a prompt. */
export function restoreWalletForOwner(owner){
 if(selected)return selected.provider;
 try{return getSelectedWallet();}catch{}
 const match=discoverWallets().find(w=>!w.paused&&w.wallet?.accounts?.some(a=>a.address===owner));
 if(!match)throw Error('Your sign-in is still valid, but this tab has no wallet chosen. Open Connect wallet, pick '+'the wallet you signed in with, then retry.');
 return selectWallet(match);
}
export function forgetWallet(){selected=null;writeChoice(null);}

export function validateWalletChallenge(challenge,owner,origin,now=Date.now()){
 const lines=challenge.message?.split('\n'),issued=Date.parse(lines?.[8]?.slice(11)),expires=Date.parse(lines?.[9]?.slice(17));
 if(lines?.length!==10||lines[0]!==new URL(origin).host+' wants you to sign in with your Solana account:'||lines[1]!==owner||lines[2]!==''||lines[3]!=='Sign in to KIDS. This does not authorize transactions or move funds.'||lines[4]!==''||lines[5]!=='URI: '+origin||lines[6]!=='Version: 1'||lines[7]!=='Nonce: '+challenge.id||!lines[8].startsWith('Issued At: ')||!lines[9].startsWith('Expiration Time: ')||!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now+60000||expires<=now||expires-issued>600000)throw Error('Sign-in challenge does not match this site and wallet.');
}
const short=a=>a?String(a).slice(0,4)+'…'+String(a).slice(-4):'none';
/** The selected wallet, connected to the signed-in account. Used before every transaction signature. */
export async function walletForOwner(owner){
 const provider=restoreWalletForOwner(owner);
 if(!provider?.signTransaction)throw Error('Use a wallet that supports Solana transaction signing.');
 if(!provider.publicKey||provider.publicKey.toString()!==owner)await provider.connect(owner);
 const active=provider.publicKey?.toString();
 if(active!==owner)throw Error('Your wallet\'s active account is '+short(active)+', but you signed in with '+short(owner)+'. Switch to that account in your wallet, or sign out and sign in again.');
 return provider;
}
