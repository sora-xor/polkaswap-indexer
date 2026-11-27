import { copyFileSync, mkdirSync } from 'node:fs';

// TypeScript reformats imported JSON. Ship the exact reviewed bytes so the
// source provenance digests also verify the compiled deployment artifact.
const source = new URL('../src/runtime/', import.meta.url);
const destination = new URL('../dist/src/runtime/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const name of ['sora-legacy-types.json', 'sora-mobile-types.json', 'provenance.json', 'LICENSE', 'README.md']) {
  copyFileSync(new URL(name, source), new URL(name, destination));
}
