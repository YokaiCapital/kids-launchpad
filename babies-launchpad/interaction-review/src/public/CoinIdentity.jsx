import {XLogo,Globe} from '@phosphor-icons/react';
import {Pfp} from './CoinMedia';
import {shortAddress} from './campaign-adapter.mjs';
/** Parent communities inline: icon beside name, "×" between (spec §3, §5). Identifies mints; claims nothing else. */
export function ParentPair({parents,size=18}){
 if(!parents||parents.length===0)return null;
 return <span className="pl-parents" aria-label={'Parent communities: '+parents.map(p=>p.name).join(' and ')}>
  {parents.map((p,i)=><span key={p.mint||i} style={{display:'inline-flex',alignItems:'center',gap:6}}>
   {i>0&&<span className="pl-x" aria-hidden="true">×</span>}
   {p.logo?<img src={p.logo} alt="" width={size} height={size} loading="lazy" decoding="async"/>:<span className="pl-parent-mark" aria-hidden="true">{(p.name||'?').charAt(0)}</span>}
   <b>{p.name}</b>
  </span>)}
 </span>;
}
/**
 * CoinIdentity (spec §5): 3:1 banner with X/website icons over it, PFP (56 desktop / 48 mobile via CSS), name and
 * ticker, mode and parents under the name. Rendered once per page; the coin page header repeats only the text.
 */
export function CoinIdentity({vm,heading='h2',banner=true}){
 const H=heading;
 return <div className="pl-identity-wrap">
  {banner&&<div className="pl-banner">
   {vm.media.banner?<img src={vm.media.banner} alt="" width={900} height={300} decoding="async"/>:<span className="pl-sr">No banner yet</span>}
   {(vm.links.x||vm.links.website)&&<div className="pl-banner-links">
    {vm.links.x&&<a href={vm.links.x} target="_blank" rel="noreferrer noopener" aria-label={vm.name+' on X (opens in a new tab)'}><XLogo size={18} weight="bold" aria-hidden="true"/></a>}
    {vm.links.website&&<a href={vm.links.website} target="_blank" rel="noreferrer noopener" aria-label={vm.name+' website (opens in a new tab)'}><Globe size={18} weight="bold" aria-hidden="true"/></a>}
   </div>}
  </div>}
  <div className="pl-identity">
   <Pfp src={vm.media.pfp} name={vm.name} size={56} preview/>
   <div className="pl-identity-text">
    <H>{vm.name||'Unnamed coin'}<span>{vm.symbol?'$'+vm.symbol:''}</span></H>
    <span className="pl-identity-mode">{vm.mode==='family'?'Family':'Standard'}{vm.chain?.mint?<> · CA <span className="pl-mono">{shortAddress(vm.chain.mint)}</span></>:null}</span>
    {vm.mode==='family'&&<ParentPair parents={vm.parents}/>}
   </div>
  </div>
 </div>;
}
