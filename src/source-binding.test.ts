import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fingerprintWorkspace, isSourceExcluded } from './source-files.js';

test('source selection excludes metadata, dependencies, environment, and credential paths', () => {
  for (const relative of [
    '.notchlet/changes/a/tasks.json',
    '.git/config',
    'node_modules/pkg/index.js',
    'dist/app.js',
    '.env',
    '.env.local',
    'credentials.json',
    'secrets/token.txt',
    'certs/private.pem',
  ]) assert.equal(isSourceExcluded(relative), true, relative);
  for (const relative of ['src/index.ts', 'README.md', 'packages/app/main.js']) {
    assert.equal(isSourceExcluded(relative), false, relative);
  }
});

test('workspace fingerprints track source edits and never retain secret contents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-source-binding-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.notchlet', 'changes', 'demo'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'secrets'), { recursive: true });
    await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
    await writeFile(path.join(root, 'README.md'), '# Source\n');
    await writeFile(path.join(root, '.notchlet', 'changes', 'demo', 'tasks.json'), '{}');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'dependency');
    await writeFile(path.join(root, 'dist', 'app.js'), 'build output');
    await writeFile(path.join(root, '.env'), 'TOP SECRET');
    await writeFile(path.join(root, 'credentials.json'), '{"token":"TOP SECRET"}');
    await writeFile(path.join(root, 'secrets', 'token.txt'), 'TOP SECRET');
    await writeFile(path.join(root, 'private.pem'), 'TOP SECRET');

    const first = await fingerprintWorkspace(root);
    assert.equal(first.algorithm, 'sha256');
    assert.equal(first.files, 2);
    assert.equal(first.truncated, false);
    assert(!JSON.stringify(first).includes('TOP SECRET'));
    assert(!JSON.stringify(first).includes('.env'));

    await writeFile(path.join(root, '.env'), 'CHANGED SECRET');
    await writeFile(path.join(root, 'credentials.json'), '{"token":"CHANGED"}');
    await writeFile(path.join(root, 'secrets', 'token.txt'), 'CHANGED');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'changed dependency');
    await writeFile(path.join(root, '.notchlet', 'changes', 'demo', 'tasks.json'), '{"changed":true}');
    assert.equal((await fingerprintWorkspace(root)).digest, first.digest);

    await writeFile(path.join(root, 'src', 'index.ts'), 'export const value = 2;\n');
    const edited = await fingerprintWorkspace(root);
    assert.notEqual(edited.digest, first.digest);
    assert.equal(edited.files, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace fingerprints report truncation instead of silently skipping large source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-source-binding-large-'));
  try {
    await writeFile(path.join(root, 'oversized.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
    const fingerprint = await fingerprintWorkspace(root);
    assert.equal(fingerprint.truncated, true);
    assert.equal(fingerprint.files, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
