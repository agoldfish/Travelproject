// The ready-to-paste worker/dist/hometime-worker.js must match the source. Rebuild with: npm run build:worker
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('worker/dist is up to date with worker/src', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ht-')), 'w.js');
  const root = new URL('..', import.meta.url).pathname;
  execFileSync(path.join(root, 'node_modules/.bin/esbuild'), ['worker/src/index.js', '--bundle', '--format=esm', '--target=es2022', `--outfile=${out}`, '--legal-comments=inline'], { cwd: root, stdio: 'pipe' });
  const committed = fs.readFileSync(path.join(root, 'worker/dist/hometime-worker.js'), 'utf8');
  assert.ok(fs.readFileSync(out, 'utf8') === committed, 'worker/dist/hometime-worker.js is stale: run npm run build:worker');
});
