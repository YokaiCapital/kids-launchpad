import {XLogo,Globe} from '@phosphor-icons/react';
import {solAmount} from './campaign-adapter.mjs';
import {selectedPreset,schedule} from './launch-draft.mjs';
import {Pfp} from './CoinMedia';
import {ParentPair} from './CoinIdentity';
import {CapMeter} from './FundingSummary';
/**
 * LiveCoinPreview (spec §4): the coin card as it will appear on Explore and the coin page, fed by the draft.
 * An empty PFP is the quiet initial-letter placeholder, confined to the preview and never shown as uploaded art.
 */
export function LiveCoinPreview({draft,manifest,clock}){
 const preset=selectedPreset(draft,manifest),sched=schedule(draft,manifest,clock());
 const parents=draft.mode==='family'?draft.parents.filter(Boolean):[];
 const name=draft.name.trim()||'Your coin',symbol=draft.symbol.trim();
 return <div className="pl-preview" aria-label="Preview">
  <span className="pl-label">Preview</span>
  <div className="pl-banner">
   {draft.banner?.url&&!draft.banner.error?<img src={draft.banner.url} alt="" width={900} height={300}/>:<span className="pl-sr">No banner yet</span>}
   {(draft.xUrl||draft.websiteUrl)&&<div className="pl-banner-links" aria-hidden="true">{draft.xUrl&&<a><XLogo size={18} weight="bold"/></a>}{draft.websiteUrl&&<a><Globe size={18} weight="bold"/></a>}</div>}
  </div>
  <div className="pl-identity">
   <Pfp src={draft.pfp?.url&&!draft.pfp.error?draft.pfp.url:null} name={name} size={56}/>
   <div className="pl-identity-text"><h2>{name}<span>{symbol?'$'+symbol:''}</span></h2><span className="pl-identity-mode">{draft.mode==='family'?'Family':'Standard'}</span>{parents.length>0&&<ParentPair parents={parents}/>}</div>
  </div>
  <p className={'pl-about'+(draft.description.trim()?'':' is-empty')} style={{marginTop:12,fontSize:14}}>{draft.description.trim()||'Your short introduction appears here.'}</p>
  {preset&&<div className="pl-preview-terms">
   <div className="pl-row" style={{padding:0,border:0}}><span>Funding</span><span className="pl-num">0 / {solAmount(preset.hardLamports).compact} SOL</span></div>
   <CapMeter committedLamports="0" softLamports={preset.softLamports} hardLamports={preset.hardLamports} mini label="Nothing committed yet"/>
   <div className="pl-row" style={{padding:'8px 0 0',border:0}}><span>Minimum</span><span className="pl-num">{solAmount(preset.softLamports).compact} SOL</span></div>
   <div className="pl-row" style={{padding:0,border:0}}><span>Closes</span><span className="pl-num">{sched.estimated?'2 h after creation confirms':sched.closeUtc}</span></div>
  </div>}
 </div>;
}
