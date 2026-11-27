import {verifyBurnRelease} from '../burn-release-verification.js';

const names = ['--verifier', '--verifier-sha256', '--manifest', '--policy', '--policy-sha256', '--expected-ledger', '--output'];
const args = process.argv.slice(2), flags = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!names.includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error('Unknown or duplicate Burn verifier argument');
  flags.set(args[i], args[i + 1]);
}
if (flags.size !== names.length) throw new Error('All explicit Burn verifier paths and digests are required');
const result = await verifyBurnRelease({verifier: flags.get('--verifier')!, verifierSha256: flags.get('--verifier-sha256')!,
  manifest: flags.get('--manifest')!, policy: flags.get('--policy')!, policySha256: flags.get('--policy-sha256')!,
  expectedLedger: flags.get('--expected-ledger')!, output: flags.get('--output')!});
process.stdout.write(JSON.stringify(result) + '\n');
