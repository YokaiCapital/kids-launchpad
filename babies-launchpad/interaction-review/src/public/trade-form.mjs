export function parseTradeAmount(text,decimals){
 if(!Number.isInteger(decimals)||decimals<0||decimals>9||typeof text!=='string'||text.length>40)return null;
 const match=/^(\d+)?(?:\.(\d*))?$/.exec(text.trim());if(!match||!match[1]&&!match[2]||(match[2]||'').length>decimals)return null;
 const raw=BigInt(match[1]||0)*10n**BigInt(decimals)+BigInt((match[2]||'').padEnd(decimals,'0')||0);return raw>0n&&raw<=18446744073709551615n?String(raw):null;
}
