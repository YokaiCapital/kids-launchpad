import test from 'node:test';import assert from 'node:assert/strict';import {friendlyError} from '../src/friendly-errors.mjs';
const raw='Simulation failed. Message: Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1. Logs: [ "Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke [1]", "Program log: Instruction: SwapBaseInput", "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]", "Program log: Instruction: TransferChecked", "Program log: Error: insufficient funds", "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1" ]. Catch the `SendTransactionError` and call `getLogs()` on it for full details.';
test('the owner\'s sell error becomes a plain headline with the raw text kept',()=>{
 const f=friendlyError(raw,{payWith:'$Shartcoin'});assert.equal(f.title,'Not enough $Shartcoin in your wallet');assert.match(f.detail,/Lower the amount/);assert.equal(f.technical,raw);
});
test('known cases: slippage, expiry, wallet cancel, timeout, generic program error, reachability',()=>{
 assert.match(friendlyError('custom program error: 0x1787 ExceededSlippage').title,/price moved/);
 assert.match(friendlyError('Blockhash not found').title,/ran out of time/);
 assert.match(friendlyError({message:'User rejected the request.'}).title,/cancelled/);
 assert.match(friendlyError('Confirmation timed out. Retry checks the same transaction').title,/taking too long/);
 assert.match(friendlyError('Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1771').title,/network rejected/);
 assert.match(friendlyError('TypeError: Failed to fetch').title,/could not reach/);
});
test('plain server messages pass through unchanged; long unknown text gets a headline and the ledger reason',()=>{
 assert.deepEqual(friendlyError('You hold 12.5 $Shartcoin. Enter at most that amount.'),{title:'You hold 12.5 $Shartcoin. Enter at most that amount.',detail:'',technical:null});
 assert.deepEqual(friendlyError('Wallet changed. Refresh before trading.'),{title:'Wallet changed. Refresh before trading.',detail:'',technical:null});
 const f=friendlyError('x'.repeat(200)+' "Program log: Error: account frozen" ');assert.equal(f.title,'This did not go through');assert.match(f.detail,/account frozen/);assert.ok(f.technical);
 assert.equal(friendlyError('').title,'Something went wrong');
});
