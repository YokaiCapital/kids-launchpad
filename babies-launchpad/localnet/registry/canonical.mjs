// Canonical JSON: the one byte sequence for a value, whatever key order or whitespace the author used. Object keys are
// sorted by code unit, arrays keep their order, strings use JSON.stringify escaping, integers print as plain digits.
// Refused: undefined, functions, symbols, NaN, Infinity (a canonical form must not silently drop or bend a value).
// BigInt values print as decimal strings so amounts survive the round trip as text (plan section 5).
import {createHash} from 'node:crypto';
export function canonicalJson(value){
 if(value===null)return 'null';
 switch(typeof value){
  case 'string':return JSON.stringify(value);
  case 'boolean':return value?'true':'false';
  case 'number':if(!Number.isFinite(value))throw Error('Canonical JSON refuses a non-finite number');return Number.isInteger(value)?String(value):JSON.stringify(value);
  case 'bigint':return JSON.stringify(value.toString());
  case 'undefined':case 'function':case 'symbol':throw Error('Canonical JSON refuses '+typeof value);
 }
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw Error('Canonical JSON takes plain objects only');
 const keys=Object.keys(value).filter(k=>value[k]!==undefined).sort();
 return '{'+keys.map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';
}
/** sha256 (hex) over the canonical JSON of the value. */
export function canonicalHash(value){return createHash('sha256').update(canonicalJson(value)).digest('hex');}
