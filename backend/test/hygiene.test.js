import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function isIgnored(relativePath) {
  return spawnSync('git', ['check-ignore', '-q', '--no-index', relativePath], {
    cwd: repositoryRoot,
    stdio: 'ignore',
  }).status === 0;
}

test('required local-only paths are ignored while env examples remain available', () => {
  for (const ignoredPath of [
    'backend/node_modules/',
    'dist/',
    '.next/',
    '.env.production',
    'cold-call-transcripts-100/README.md',
  ]) {
    assert.equal(isIgnored(ignoredPath), true, `${ignoredPath} should be ignored`);
  }
  assert.equal(isIgnored('backend/.env.example'), false);
});

test('transcript corpus remains ignored and is not tracked by Git', () => {
  assert.equal(isIgnored('cold-call-transcripts-100/'), true);
  const tracked = execFileSync('git', ['ls-files', 'cold-call-transcripts-100'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(tracked.trim(), '');
});

test('tracked dependency files are removed from the index without deleting local dependencies', () => {
  assert.equal(existsSync(path.join(repositoryRoot, 'backend/node_modules/express/package.json')), true);
  const tracked = execFileSync('git', ['ls-files', 'backend/node_modules'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(tracked.trim(), '');
});
