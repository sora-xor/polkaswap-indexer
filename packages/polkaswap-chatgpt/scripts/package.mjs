import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const submission = process.argv.includes('--submission');
const pluginRoot = resolve(packageRoot, 'plugin');
const allowlist = [
  'LICENSE',
  'plugin.json',
  'mcp.json',
  'assets/icon.svg',
  'assets/logo.svg',
  'skills/read-chain-evidence/SKILL.md',
];

async function localFile(relativePath) {
  assert(relativePath.startsWith('./'), 'Manifest paths must start with ./');
  const file = resolve(pluginRoot, relativePath);
  assert(file.startsWith(`${pluginRoot}${sep}`), 'Manifest path escapes plugin root');
  const relative = relativePath.slice(2);
  assert(allowlist.includes(relative), `Referenced file is outside the package allowlist: ${relative}`);
  const stat = await lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Expected a regular file: ${relative}`);
  assert(stat.size < 5 * 1024 * 1024, `Packaged file exceeds 5 MiB: ${relative}`);
  return readFile(file, 'utf8');
}

function httpsUrl(value, label) {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password, `${label} must use HTTPS without credentials`);
}

const manifest = JSON.parse(await readFile(resolve(pluginRoot, 'plugin.json'), 'utf8'));
const mcp = JSON.parse(await readFile(resolve(pluginRoot, 'mcp.json'), 'utf8'));
assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.match(manifest.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert(manifest.name.length <= 64);
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
const openai = manifest.extensions?.['com.openai'];
assert(openai && !openai.apps && !openai.hooks, 'Public preview must not include app references or lifecycle hooks');
const view = openai.interface;
for (const [field, max] of [['displayName', 30], ['shortDescription', 30], ['longDescription', 4000], ['developerName', 80]]) {
  assert(typeof view?.[field] === 'string' && view[field].length > 0 && view[field].length <= max, `Invalid ${field}`);
}
for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL']) httpsUrl(view[field], field);
if (view.termsOfServiceURL) httpsUrl(view.termsOfServiceURL, 'termsOfServiceURL');
if (submission) {
  httpsUrl(view.termsOfServiceURL, 'termsOfServiceURL');
  assert(typeof openai.review?.demo_recording_url === 'string', 'Submission requires the actual reviewer-accessible demo recording URL');
  httpsUrl(openai.review.demo_recording_url, 'demo_recording_url');
  for (const name of ['privacy', 'support', 'terms']) {
    const policy = await readFile(resolve(packageRoot, 'public', `${name}.html`), 'utf8');
    assert(policy.length > 0, `Submission requires a populated ${name} page`);
  }
}
assert(Array.isArray(view.defaultPrompt) && view.defaultPrompt.length <= 3);
assert(view.defaultPrompt.every((prompt) => typeof prompt === 'string' && prompt.length > 0 && prompt.length <= 128));
assert.match(view.brandColor, /^#[0-9A-Fa-f]{6}$/);
for (const field of ['composerIcon', 'logo']) {
  const svg = await localFile(view[field]);
  const box = svg.match(/viewBox="\s*([\d.-]+)\s+([\d.-]+)\s+([\d.]+)\s+([\d.]+)\s*"/);
  assert(box && Number(box[3]) === Number(box[4]) && Number(box[3]) >= 48, `${field} must be a square SVG at least 48 by 48`);
  assert(!/<script|on\w+\s*=|(?:href|src)\s*=\s*["'](?:https?:|data:)/i.test(svg), `${field} must be self-contained and script-free`);
}
const skill = await localFile(openai.onboardingSkill);
assert(/^---\nname: [a-z0-9-]+\ndescription: [^\n]+\n---/.test(skill), 'Skill must have name and description frontmatter');
const servers = Object.values(mcp.mcpServers ?? {});
assert.equal(servers.length, 1, 'Exactly one remote server is expected');
assert.equal(servers[0].type, 'streamable-http');
httpsUrl(servers[0].url, 'MCP server URL');
const cases = openai.review?.test_cases;
assert.equal(cases?.positive?.length, 5);
assert.equal(cases?.negative?.length, 3);
for (const testCase of [...cases.positive, ...cases.negative]) {
  assert(typeof testCase.description === 'string' && testCase.description.length > 0);
  assert(typeof testCase.prompt === 'string' && testCase.prompt.length > 0);
  assert(typeof testCase.expected_behavior === 'string' && testCase.expected_behavior.length > 0);
}
assert(cases.positive.every((testCase) => typeof testCase.tools_triggered === 'string' && testCase.tools_triggered.length > 0));
for (const relative of allowlist) await localFile(`./${relative}`);

const output = resolve(packageRoot, 'dist', `${manifest.name}-${manifest.version}.zip`);
await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
const zipped = spawnSync('zip', ['-X', '-q', output, ...allowlist], { cwd: pluginRoot, encoding: 'utf8' });
if (zipped.error) throw zipped.error;
assert.equal(zipped.status, 0, zipped.stderr || 'ZIP creation failed');
const check = spawnSync('unzip', ['-Z1', output], { encoding: 'utf8' });
assert.equal(check.status, 0, check.stderr || 'ZIP inspection failed');
assert.deepEqual(check.stdout.trim().split('\n').sort(), [...allowlist].sort());
console.log(`Local package checks passed; created ${output}`);
console.log(submission
  ? 'Submission artifact checks passed. This does not certify policy accuracy, ChatGPT test outcomes, publisher/domain verification, portal scans or OpenAI approval.'
  : 'Preview only: publisher/domain verification, operator-approved policies, ChatGPT test evidence, video and public review remain required.');
