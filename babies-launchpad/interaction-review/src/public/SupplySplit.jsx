import {supplySplit} from './campaign-adapter.mjs';
/** SupplySplit (spec §4 step 3): one strip, percentages of total original supply, plus the dev vesting line. */
export function SupplySplit({terms,compact=false}){
 const s=supplySplit(terms);
 const text=s.segments.map(seg=>seg.percent+' '+seg.label.toLowerCase()).join(', ');
 return <div className="pl-supply-wrap">
  <div className="pl-supply" role="img" aria-label={'Supply split: '+text+'.'+(s.sumsToWhole?'':' The published split does not sum to 100%.')}>
   {s.segments.map(seg=><i key={seg.key} className={'is-'+seg.key} style={{'--bps':seg.bps}}/>)}
  </div>
  <div className="pl-supply-legend" aria-hidden="true">
   {s.segments.map(seg=><span key={seg.key}><i className={'is-'+seg.key} style={{background:{participants:'var(--pl-pink)',liquidity:'var(--pl-grape)',parents:'var(--pl-ice)',dev:'#6d5385'}[seg.key]}}/><strong>{seg.percent}</strong> {seg.label}</span>)}
  </div>
  {!compact&&<p className="pl-supply-dev">{s.devLine}{s.sumsToWhole?'':' · The published split does not sum to 100%; check the terms.'}</p>}
 </div>;
}
