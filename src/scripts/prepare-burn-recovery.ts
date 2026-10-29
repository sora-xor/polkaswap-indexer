import {pathToFileURL} from 'node:url';
import {prepareBurnRecovery} from '../burn-recovery-preparation.js';
export {prepareBurnRecovery} from '../burn-recovery-preparation.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--capture', '--capture-sha256', '--policy', '--policy-sha256', '--output'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) {
      throw new Error('Use --capture FILE --capture-sha256 HASH --policy FILE --policy-sha256 HASH --output NEW_FILE');
    }
    flags.set(args[i], args[i + 1]);
  }
  if (flags.size !== 5) throw new Error('All five explicit preparation arguments are required');
  await prepareBurnRecovery({ capture: flags.get('--capture')!, captureSha256: flags.get('--capture-sha256')!,
    policy: flags.get('--policy')!, policySha256: flags.get('--policy-sha256')!, output: flags.get('--output')! });
}
