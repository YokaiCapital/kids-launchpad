import {resolveCoinDescription} from '../src/coin-display.js';
import {BUILT_IN_SHART_VIDEOS,resolveShartVideo} from '../src/coin-media.js';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {allocation,parseSol,emptyPrelaunch} from '../src/prelaunch.js';
import {candidates,normalizeDraft,draftError,submitVersion,reviewVersion,recordVote} from '../src/model.js';

// One shared local demo account. Never a wallet authorization or live protocol ledger.
export class DemoStore {
  constructor(filename=':memory:',clock=Date.now) {
    this.clock=clock;
    this.db=new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS demo_state(id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS demo_requests(id TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL);');
    this.db.prepare('INSERT OR IGNORE INTO demo_state VALUES(1,?)').run(JSON.stringify({history:[],accepted:null,revision:0}));
  }
  read(){return JSON.parse(this.db.prepare('SELECT body FROM demo_state WHERE id=1').get().body);}
  close(){this.db.close();}
  apply({requestId,revision,action,payload={}}, verifiedPayload=payload) {
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw Error('Valid request ID required');
    const hash=createHash('sha256').update(JSON.stringify({revision,action,payload})).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior=this.db.prepare('SELECT * FROM demo_requests WHERE id=?').get(requestId);
      if(prior){if(prior.hash!==hash)throw Error('Request ID was reused with different content');this.db.exec('COMMIT');return JSON.parse(prior.response);}
      const state=this.read();
      if(revision!==state.revision)throw Error('Demo records changed in another tab. Refresh records and try again.');
      let proposal=null;
      if(action==='submit') {
        const draft=normalizeDraft(verifiedPayload.draft),problem=draftError(draft);if(problem)throw Error(problem);
        if(draft.proposalId&&!state.history.some(p=>p.id===draft.proposalId))throw Error('Original proposal is not in the local service. Start a new proposal.');
        const result=submitVersion(state.history,draft);state.history=result.records;proposal=result.proposal;
      } else if(action==='vote') {
        if(this.clock()>=Date.parse('2026-09-21T16:00:00Z'))throw Error('Demo round closed. Your previous vote is unchanged.');
        const candidate=candidates.find(c=>c.id===payload.candidateId);
        const result=recordVote(state.accepted,candidate,{});if(result.error)throw Error(result.error);state.accepted=result.vote;
      } else if(action==='review') {
        if(!state.history.some(p=>p.id===payload.id&&p.version===payload.version&&p.status==='Awaiting review'))throw Error('This version is no longer awaiting review');
        state.history=reviewVersion(state.history,payload.id,payload.version,payload.status);
      } else if(action.startsWith('prelaunch-')) {
        state.prelaunch??={...emptyPrelaunch};const launch=state.prelaunch;
        if(action==='prelaunch-reset'){
          state.prelaunch={...emptyPrelaunch};
        }else if(action==='prelaunch-commit'){
          if(launch.phase!=='open')throw Error('Demo commitments are closed');
          const total=BigInt(launch.committed)+parseSol(payload.amount);if(total>1000000000000n)throw Error('Demo account limit is 1,000 SOL');launch.committed=total.toString();
        }else if(action==='prelaunch-settle'){
          if(launch.phase!=='open'||BigInt(launch.committed)===0n)throw Error('No open demo commitment');
          const result=allocation(launch.committed);if(!result.filled)throw Error('Pool target is not reached');
          launch.phase='settled';launch.accepted=result.retained.toString();launch.refund=result.refund.toString();
        }else if(action==='prelaunch-refund'){
          if(launch.phase!=='settled'||launch.refundClaimed||BigInt(launch.refund)===0n)throw Error('No demo refund available');launch.refundClaimed=true;
        }else throw Error('Unknown prelaunch action');
      } else if(action==='coin-profile'){
        const {description,banner,logo,xUrl='',websiteUrl='',video=''}=payload;
        for(const [key,value] of Object.entries({xUrl,websiteUrl})){
          if(typeof value!=='string'||value.length>500)throw Error('Social links must be under 500 characters');
          if(value){let url;try{url=new URL(value);}catch{throw Error('Enter a valid HTTPS URL');}
          if(url.protocol!=='https:'||url.username||url.password)throw Error('Use HTTPS links without credentials');
          if(key==='xUrl'&&!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname))throw Error('X profile must link to x.com or twitter.com');}
        }
        if(typeof description!=='string'||description.length>1200)throw Error('Description must be under 1,200 characters');
        const validImage=x=>x===''||(typeof x==='string'&&x.length<1500000&&/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/.test(x));
        if(!validImage(banner)||!validImage(logo))throw Error('Use PNG or WebP images under 1 MB each');
        if(typeof video!=='string')throw Error('Invalid video');
        if(video && !BUILT_IN_SHART_VIDEOS.includes(video) && !(/^data:video\/(mp4|webm);base64,[A-Za-z0-9+/=]+$/.test(video)&&video.length<=13333400)){
          let media;try{media=new URL(video);}catch{throw Error('Use an MP4 or WebM upload or HTTPS video URL');}
          if(video.length>2000||media.protocol!=='https:'||media.username||media.password||! /\.(mp4|webm)$/i.test(media.pathname))throw Error('Use a direct HTTPS MP4 or WebM video URL');
        }
        state.coinProfile={description:resolveCoinDescription(description),banner,logo,xUrl,websiteUrl,video:resolveShartVideo(video)};
      } else if(action==='coin-post'){
        const {text,url}=payload;if(typeof text!=='string'||text.length>2000||typeof url!=='string'||url.length>500||(!text.trim()&&!url))throw Error('Add text or a link; text must be under 2,000 characters');
        if(url){let parsed;try{parsed=new URL(url);}catch{throw Error('Enter a valid HTTPS link');}if(parsed.protocol!=='https:')throw Error('Links must use HTTPS');}
        state.coinPosts??=[];if(state.coinPosts.length>=100)throw Error('Demo feed limit reached');
        state.coinPosts.unshift({id:requestId,text:text.trim(),url,createdAt:new Date(this.clock()).toISOString(),author:'Shartcoin · Dev'});
      } else if(action==='reset-vote')state.accepted=null;
      else throw Error('Unknown demo action');
      state.revision++;
      const response={...state,proposal};
      this.db.prepare('UPDATE demo_state SET body=? WHERE id=1').run(JSON.stringify(state));
      this.db.prepare('INSERT INTO demo_requests VALUES(?,?,?)').run(requestId,hash,JSON.stringify(response));
      this.db.exec('COMMIT');return response;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
