import {useState} from 'react';
export const SHART_PFP='/assets/shart-pfp.png';
/** Shartcoin profile picture. Falls back to the typographic S! mark when the image cannot load, so the slot never goes blank. */
export function CoinPfp({src=SHART_PFP,alt='Shartcoin',className='',size=68}){
 const [failed,setFailed]=useState(false);
 if(failed)return <span className={('shart-mark coin-pfp-fallback '+className).trim()} aria-hidden="true">S!</span>;
 return <img className={('coin-pfp '+className).trim()} src={src} alt={alt} width={size} height={size} decoding="async" onError={()=>setFailed(true)}/>;
}
