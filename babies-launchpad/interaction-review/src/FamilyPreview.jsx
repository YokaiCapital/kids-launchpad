import {parentLabel,parents} from './model';
export function FamilyPreview({ draft }) {
  const isSample = draft.art === '/assets/sprout.png' && draft.a === 'ALPHA' && draft.b === 'BETA';
  return <div className={`family-preview ${isSample ? 'sample-family' : ''}`}>
    {isSample ? <img className="family-art" src="/assets/family-v1.png" alt="Purple Alpha and cream Beta with their lime kid Sprout"/> : <div className="custom-family"><span>{parentLabel(draft.a)}</span><img src={draft.art || '/assets/sprout.png'} alt={`${draft.name || 'Your kid'} artwork`}/><span>{parentLabel(draft.b)}</span></div>}
    <div className="family-labels"><div><strong>{parentLabel(draft.a)}</strong><span>{parents.includes(draft.a)?'Example token':'Localnet mint'}</span></div><div><strong>{draft.name || 'Your kid'}</strong><span>${draft.ticker || 'KIDS'}</span></div><div><strong>{parentLabel(draft.b)}</strong><span>{parents.includes(draft.b)?'Example token':'Localnet mint'}</span></div></div>
  </div>;
}
