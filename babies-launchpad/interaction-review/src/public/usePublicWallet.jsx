import {useCallback,useEffect,useRef,useState} from 'react';
import {accountApi} from '../Account';
import {walletForOwner} from '../wallet-connection.mjs';
import {createWalletReadSession} from './wallet-read-session.mjs';
import {uploadPrivateArtwork} from './artwork-upload.mjs';
import {uploadPrivateVideo} from './video-upload.mjs';
const terminal=s=>['confirmed','finalized','failed','expired','cancelled'].includes(s);
const present=p=>({...p,state:p.status==='cancelled'?'rejected':p.status==='finalized'?'confirmed':p.status==='expired'?'failed':p.status==='prepared'&&!p.signature?'prepared':p.status==='signed'?'delayed':p.status,reason:p.error});
export function usePublicWallet({owner,campaigns,onConfirmed,readDrafts=false}){
 const [account,setAccount]=useState(null),[drafts,setDrafts]=useState([]),[notice,setNotice]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null);
 const [tradeQuote,setTradeQuote]=useState(null);const tradeKey=useRef(null),tradeSubmitted=useRef(null);
 const [reading,setReading]=useState(false),[accountScope,setAccountScope]=useState(null),[draftOwner,setDraftOwner]=useState(null);
 const reader=useRef(null);if(!reader.current)reader.current=createWalletReadSession(accountApi);
 const reads=useRef(0),checking=useRef(false);
 const current=useRef(owner),running=useRef(false),pending=useRef(null),refreshRef=useRef(onConfirmed);current.current=owner;refreshRef.current=onConfirmed;
 const ids=campaigns.map(c=>c.id).join('|');
 const scope=JSON.stringify([owner,ids]);
 const reload=useCallback(async()=>{
  if(!owner)return;const readId=++reads.current;setReading(true);
  try{
   const {account:data,drafts:saved}=await reader.current.read({owner,campaignIds:ids?ids.split('|'):[],readDrafts});
   if(current.current!==owner||readId!==reads.current)return;setAccount(data);setAccountScope(scope);if(saved){setDrafts(saved);setDraftOwner(owner);}setError(null);
   const awaiting=data.pending?.find(p=>!terminal(p.status));if(awaiting&&!pending.current){pending.current=awaiting;setNotice(present(awaiting));}
  }catch(e){if(e.name!=='AbortError'&&current.current===owner&&readId===reads.current){setAccount(null);setAccountScope(null);setError('Wallet data is unavailable. Retry before making a transaction.');}}
  finally{if(current.current===owner&&readId===reads.current)setReading(false);}
 },[owner,ids,readDrafts,scope]);
 useEffect(()=>{reads.current++;setAccount(null);setAccountScope(null);setDrafts([]);setDraftOwner(null);setNotice(null);setError(null);pending.current=null;tradeKey.current?.secretKey.fill(0);tradeKey.current=null;tradeSubmitted.current=null;setTradeQuote(null);setBusy(false);},[owner]);
 useEffect(()=>{reload();const timer=setInterval(()=>{if(!document.hidden)reload();},30000);return()=>{clearInterval(timer);reader.current.cancel();};},[reload]);
 const check=useCallback(async()=>{
  const p=pending.current;if(!owner||!p||checking.current||running.current||p.action==='trade'&&p.status==='prepared'&&tradeKey.current&&!tradeSubmitted.current)return;checking.current=true;
  try{const session=await accountApi('state');if(session.owner!==owner||current.current!==owner)return;
   let result=await accountApi(p.action==='trade'?'launches/trade/status':'launches/status',{intentId:p.intentId},session.csrf);if(current.current!==owner)return;
   if(p.action==='trade'&&!terminal(result.status)&&tradeSubmitted.current?.intentId===p.intentId){result=await accountApi('launches/trade/submit',tradeSubmitted.current,session.csrf);if(current.current!==owner)return;}
   else if(p.action==='trade'&&!terminal(result.status)&&result.signature){result=await accountApi('launches/trade/resume',{intentId:p.intentId},session.csrf);if(current.current!==owner)return;}
   setNotice(present(result));pending.current=terminal(result.status)?null:result;
   if(terminal(result.status)){tradeSubmitted.current=null;setTradeQuote(null);tradeKey.current?.secretKey.fill(0);tradeKey.current=null;setBusy(false);running.current=false;await reload();refreshRef.current?.();}
  }catch{if(current.current===owner)setNotice(n=>({...n,state:p.status==='prepared'&&!p.signature&&!tradeSubmitted.current?'prepared':'delayed'}));}finally{checking.current=false;}
 },[owner,reload]);
 useEffect(()=>{if(!owner)return;const timer=setInterval(()=>{if(pending.current)check();},5000);return()=>clearInterval(timer);},[owner,check]);
 async function transact(vm,action,amountLamports){
  if(running.current||pending.current||!owner)return;running.current=true;setBusy(true);setNotice({state:'submitting',action});
  let submitted=false,prepared=null,session=null;
  const assertCurrent=()=>{if(current.current!==owner)throw Error('Wallet changed; reconnect before continuing');};
  try{
   session=await accountApi('state');assertCurrent();if(session.owner!==owner)throw Error('Signed-in wallet changed');
   prepared=await accountApi('launches/prepare',{campaignId:vm.id,action,amountLamports,requestId:crypto.randomUUID()},session.csrf);assertCurrent();
   if(prepared.owner!==owner||prepared.campaignId!==vm.id||prepared.genesisHash!==vm.identity.genesisHash||prepared.action!==action)throw Error('Launch or wallet identity changed');
   pending.current=prepared;
   const provider=await walletForOwner(owner);assertCurrent();
   const {decodePublicPacket,checkedSignedPacket}=await import('./public-signing.mjs');
   const transaction=decodePublicPacket(prepared.unsignedTransactionBase64,{vm,owner,action,amountLamports}),approved=transaction.serialize().slice();
   setNotice({state:'wallet',action});
   const signed=await provider.signTransaction(transaction);assertCurrent();if(provider.publicKey?.toString()!==owner)throw Error('Wallet changed during approval');
   const signedTransactionBase64=checkedSignedPacket(signed,approved);
   // From this point an HTTP failure is ambiguous. Keep the durable intent ID and reconcile it; never create another.
   submitted=true;setNotice({state:'submitting',action});
   const result=await accountApi('launches/submit',{intentId:prepared.intentId,signedTransactionBase64},session.csrf);assertCurrent();
   pending.current=terminal(result.status)?null:result;setNotice(present(result));
   if(terminal(result.status)){await reload();refreshRef.current?.();}
  }catch(e){
   if(prepared&&!submitted){try{const cancelled=await accountApi('launches/cancel',{intentId:prepared.intentId},session.csrf);if(current.current===owner&&cancelled.status==='cancelled')pending.current=null;}catch{/* reconcile on reload */}}
   if(current.current===owner){setNotice({state:submitted?'unknown':pending.current?'delayed':'blocked',reason:submitted?null:e.message,action});}
  }
  finally{running.current=false;if(current.current===owner)setBusy(!!pending.current);}
 }

 async function prepareTrade(vm,input){
  if(running.current||pending.current||!owner)return;running.current=true;setBusy(true);setError(null);
  let key=null,prepared=null,session=null;
  const assert=()=>{if(current.current!==owner)throw Error('Wallet changed before trade approval');};
  try{
   session=await accountApi('state');assert();if(session.owner!==owner)throw Error('Signed-in wallet changed');
   const {Keypair}=await import('@solana/web3.js');key=Keypair.generate();assert();
   prepared=await accountApi('launches/trade/prepare',{...input,campaignId:vm.id,requestId:crypto.randomUUID(),wrappedAccount:key.publicKey.toBase58()},session.csrf);assert();
   const expected={...prepared,owner,campaign:vm.identity.campaign,programId:vm.identity.programId,genesisHash:vm.identity.genesisHash,mint:vm.chain.mint,pool:vm.chain.pool,side:input.side,inputRaw:input.amountRaw,slippageBps:input.slippageBps};
   if(prepared.action!=='trade'||prepared.campaignId!==vm.id||prepared.wrappedAccount!==key.publicKey.toBase58())throw Error('Trade identity changed');
   const {decodeApprovedTrade}=await import('../trade-signing.mjs');decodeApprovedTrade(Uint8Array.from(atob(prepared.unsignedTransactionBase64),c=>c.charCodeAt(0)),prepared,expected);assert();
   tradeKey.current=key;key=null;pending.current=prepared;setTradeQuote(prepared);setNotice(null);
  }catch(e){if(prepared&&session)try{await accountApi('launches/trade/cancel',{intentId:prepared.intentId},session.csrf);}catch{}if(current.current===owner)setError(e.message);}
  finally{key?.secretKey.fill(0);running.current=false;if(current.current===owner)setBusy(false);}
 }
 async function cancelTrade(){
  const p=pending.current;if(!p||p.action!=='trade'||p.signature||running.current||checking.current)return;
  running.current=true;setBusy(true);
  try{const session=await accountApi('state');if(session.owner!==owner||current.current!==owner)throw Error('Wallet changed');const result=await accountApi('launches/trade/cancel',{intentId:p.intentId},session.csrf);if(current.current!==owner)return;
   if(result.status==='cancelled'){pending.current=null;tradeSubmitted.current=null;tradeKey.current?.secretKey.fill(0);tradeKey.current=null;setTradeQuote(null);setNotice(null);}else{pending.current=result;setNotice(present(result));}
  }catch(e){if(current.current===owner)setError(e.message);}finally{running.current=false;if(current.current===owner)setBusy(false);}
 }
 async function signTrade(){
  const p=tradeQuote,key=tradeKey.current;if(!owner||!p||!key||running.current||pending.current?.intentId!==p.intentId)return;
  running.current=true;setBusy(true);setError(null);let submitted=false;
  const assert=()=>{if(current.current!==owner)throw Error('Wallet changed during approval');};
  try{
   const session=await accountApi('state');assert();if(session.owner!==owner)throw Error('Signed-in wallet changed');
   const {decodeApprovedTrade}=await import('../trade-signing.mjs'),{VersionedTransaction}=await import('@solana/web3.js'),{validateApprovedMessage}=await import('../../../shared/approved-message.mjs');
   const tx=decodeApprovedTrade(Uint8Array.from(atob(p.unsignedTransactionBase64),c=>c.charCodeAt(0)),p,p),approved=VersionedTransaction.deserialize(tx.serialize()).message;
   const provider=await walletForOwner(owner);assert();setNotice({state:'wallet',action:p.side});tx.sign([key]);
   const signed=await provider.signTransaction(tx);assert();if(provider.publicKey?.toString()!==owner)throw Error('Wallet changed during approval');
   const final=VersionedTransaction.deserialize(signed.serialize());validateApprovedMessage(final.message,approved);final.sign([key]);
   if(Date.now()>=p.expiresAt)throw Error('Quote expired. Request a fresh quote.');
   const signedTransactionBase64=btoa(String.fromCharCode(...final.serialize()));tradeSubmitted.current={intentId:p.intentId,signedTransactionBase64};submitted=true;setTradeQuote(null);setNotice({state:'submitting',action:p.side});
   const result=await accountApi('launches/trade/submit',{intentId:p.intentId,signedTransactionBase64},session.csrf);assert();pending.current=terminal(result.status)?null:result;setNotice(present(result));
   if(terminal(result.status)){tradeSubmitted.current=null;await reload();refreshRef.current?.();}
  }catch(e){if(current.current===owner){setNotice({state:submitted?'unknown':'blocked',action:'trade',reason:submitted?null:e.message});if(!submitted)setError(e.message);}}
  finally{if(submitted){key.secretKey.fill(0);tradeKey.current=null;}running.current=false;if(current.current===owner)setBusy(submitted&&!!pending.current);}
 }
 async function readOperations(campaignId){
  if(!owner)throw Error('Connect a wallet first');const session=await accountApi('state');if(current.current!==owner||session.owner!==owner)throw Error('Wallet changed');
  const result=await accountApi('launches/operations/read',{campaignId},session.csrf);if(current.current!==owner||result.owner!==owner||result.campaignId!==campaignId)throw Error('Wallet or launch changed');return result;
 }
 async function saveDraft({id,revision,draft}){
  if(!owner)throw Error('Connect a wallet to save your draft');
  const session=await accountApi('state');if(session.owner!==owner||current.current!==owner)throw Error('Wallet changed');
  const result=await accountApi('launches/drafts/save',{id,revision,draft},session.csrf);
  if(current.current!==owner)throw Error('Wallet changed');setDraftOwner(owner);setDrafts(d=>[result.draft,...d.filter(x=>x.id!==id)]);return result.draft;
 }
 async function uploadArtwork(input){
  if(!owner)throw Error('Connect a wallet before uploading');
  const session=await accountApi('state');if(session.owner!==owner||current.current!==owner)throw Error('Wallet changed');
  const result=await uploadPrivateArtwork({...input,csrf:session.csrf});
  if(current.current!==owner)throw Error('Wallet changed');return result;
 }
 async function uploadVideo(input){
  if(!owner)throw Error('Connect a wallet before uploading');
  const session=await accountApi('state');if(session.owner!==owner||current.current!==owner)throw Error('Wallet changed');
  const result=await uploadPrivateVideo({...input,csrf:session.csrf});if(current.current!==owner)throw Error('Wallet changed');return result;
 }
 return {account:accountScope===scope?account:null,drafts:draftOwner===owner?drafts:[],reading:reading||!!owner&&accountScope!==scope&&!error,notice,busy:busy||!!pending.current,error,reload,check,transact,readOperations,saveDraft,uploadArtwork,uploadVideo,tradeQuote,tradeWorking:busy,prepareTrade,signTrade,cancelTrade};
}
