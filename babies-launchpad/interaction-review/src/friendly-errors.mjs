// Turns wallet, RPC and program errors into plain words for the page. The raw text stays available under
// "Technical details" so nothing is hidden; the headline and next step are what people read first.
const PATTERNS=[
 {test:/insufficient funds|insufficient lamports|custom program error: 0x1\b/i,title:({payWith})=>'Not enough '+payWith+' in your wallet',detail:'Lower the amount and get a new quote.'},
 {test:/You hold [\d.,]+ \$Shartcoin|You have [\d.,]+ SOL/,passthrough:true},
 {test:/ExceededSlippage|exceeded slippage|slippage tolerance|0x1787\b/i,title:()=>'The price moved more than 1% while you approved',detail:'Get a fresh quote and try again.'},
 {test:/block height exceeded|blockhash not found|has expired|quote expired|Unsigned claim expired/i,title:()=>'The quote ran out of time',detail:'Get a fresh quote and approve it within 30 seconds.'},
 {test:/user rejected|rejected the request|user cancel|user denied|declined by user/i,title:()=>'You cancelled the approval in your wallet',detail:'Nothing was sent. Try again when ready.'},
 {test:/Wallet account changed|active account is|Wallet changed|no wallet chosen|Choose your wallet/i,passthrough:true},
 {test:/timed out|TimeoutError/i,title:()=>'The confirmation is taking too long',detail:'The transaction may still land. Use "Check / retry" instead of starting another one.'},
 {test:/simulation failed|SendTransactionError|custom program error|Error processing Instruction/i,title:()=>'The network rejected this transaction',detail:'Nothing was charged. Refresh the quote and try again; if it repeats, send the technical details to the team.'},
 {test:/fetch|network|Failed to fetch|Load failed/i,title:()=>'The site could not reach the network',detail:'Check your connection and try again.'}
];
const programLog=text=>{const m=/Program log: Error: ([^"\]]+)/.exec(text)||/Program log: ([^"\]]*(?:failed|error|invalid)[^"\]]*)/i.exec(text);return m?m[1].trim():'';};
/** @returns {{title:string,detail:string,technical:string|null}} */
export function friendlyError(raw,{payWith='SOL'}={}){
 const text=typeof raw==='string'?raw:raw?.message||String(raw||'');
 if(!text)return {title:'Something went wrong',detail:'Try again.',technical:null};
 for(const p of PATTERNS){if(!p.test.test(text))continue;if(p.passthrough)return {title:text,detail:'',technical:null};return {title:p.title({payWith}),detail:p.detail,technical:text.length>160||/Program log|Instruction/.test(text)?text:null};}
 if(text.length<=160&&!/[{}\[\]]/.test(text))return {title:text,detail:'',technical:null};
 const hint=programLog(text);return {title:'This did not go through',detail:hint?'Reason from the ledger: '+hint+'.':'Try again; if it repeats, send the technical details to the team.',technical:text};
}
