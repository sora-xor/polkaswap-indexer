import {pathToFileURL} from 'node:url';
import {extractBurnHistory} from '../burn-history-extraction.js';
export {decodeAuthenticatedBurnRecord, extractBurnHistory} from '../burn-history-extraction.js';
import {resolve} from 'node:path';
function ensure(condition: unknown, message: string): asserts condition {if (!condition) throw new Error(message);}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    ensure(['--verifier', '--verifier-sha256', '--manifest', '--verified-output', '--output'].includes(args[i]) &&
      args[i + 1] && !values.has(args[i]), 'Invalid Burn extraction arguments'); values.set(args[i], args[i + 1]);
  }
  ensure(values.size === 5, 'All five explicit Burn extraction arguments are required');
  await extractBurnHistory({verifier: values.get('--verifier')!, verifierSha256: values.get('--verifier-sha256')!,
    manifest: values.get('--manifest')!, verifiedOutput: values.get('--verified-output')!, output: values.get('--output')!});
}
