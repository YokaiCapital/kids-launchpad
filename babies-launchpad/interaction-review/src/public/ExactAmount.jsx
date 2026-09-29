import {useEffect,useState} from 'react';
import {Copy,Check} from '@phosphor-icons/react';
import {Exact} from '../Help';
/**
 * ExactAmount (spec §13): the rounded figure is what you read; tap, focus or hover shows the exact value in the site's
 * portalled popover, and a screen reader hears it without opening anything. `amount` is {compact, exact, unit}.
 * With `copy` a small button copies the exact value (addresses, signatures). Nothing lives only in a title attribute.
 */
export function ExactAmount({amount,label,unit=true,copy=false,className=''}){
 if(!amount)return <span className={'pl-dash '+className} aria-label="Unknown">—</span>;
 const showUnit=unit&&amount.unit?' '+amount.unit:'';
 const detail=amount.exact===amount.compact&&!copy?null:amount.exact+showUnit;
 return <span className={('pl-num '+className).trim()}>
  <Exact detail={detail} label={label}>{amount.compact}{showUnit}</Exact>
  {copy&&<CopyButton value={amount.exact} label={label||'value'}/>}
 </span>;
}
export function CopyButton({value,label}){
 const [copied,setCopied]=useState(false);
 useEffect(()=>{if(!copied)return;const id=setTimeout(()=>setCopied(false),1500);return()=>clearTimeout(id);},[copied]);
 return <button type="button" className="pl-exact-copy pl-quiet" aria-label={(copied?'Copied ':'Copy ')+label} onClick={async()=>{try{await navigator.clipboard.writeText(value);setCopied(true);}catch{}}}>{copied?<Check size={15} weight="bold" aria-hidden="true"/>:<Copy size={15} aria-hidden="true"/>}</button>;
}
