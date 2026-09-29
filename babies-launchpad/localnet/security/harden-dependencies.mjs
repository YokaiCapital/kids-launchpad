// Use bigint-buffer's own pure-JS distribution. No new arithmetic implementation,
// lifecycle script, native binding or renamed package. Keep its Apache-2.0 license.
import {readFileSync, writeFileSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const hashes = Object.freeze({
  native: '6882e3d44987bbb7c47580928fd5e3be126bdae26a448f8a31228cf879a85210',
  pure: '52233e36e5a854477a3f43f255e68474a9e4e46f51107d53320ad38ee5dff47c',
});

export function hardenDependencies(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const require = createRequire(resolve(root, 'package.json'));
  const packagePath = require.resolve('bigint-buffer/package.json');
  // Refuse accidental changes to dependencies belonging to another checkout.
  if (!realpathSync(packagePath).startsWith(realpathSync(root) + '/node_modules/')) throw Error('Dependency outside this checkout');
  const pkg = JSON.parse(readFileSync(packagePath));
  if (pkg.version !== '1.1.5' || pkg.main !== 'dist/node.js') throw Error('Review changed bigint-buffer before hardening');
  const entry = resolve(dirname(packagePath), pkg.main);
  const pure = readFileSync(resolve(dirname(packagePath), 'dist/browser.js'));
  const original = readFileSync(entry);
  if (sha(pure) !== hashes.pure || ![hashes.native, hashes.pure].includes(sha(original))) throw Error('Unexpected dependency contents; review required');
  if (sha(original) !== hashes.pure) writeFileSync(entry, pure);
  return {name: pkg.name, version: pkg.version, entrySha256: sha(readFileSync(entry)), implementation: 'upstream-pure-js'};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(hardenDependencies()));
