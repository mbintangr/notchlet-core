import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectGitContext } from './git-context.js';

const exec = promisify(execFile);
async function run(cwd: string, ...args: string[]) { await exec('git', args, { cwd, windowsHide: true }); }
async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-git-'));
  await run(root, 'init', '-b', 'main');
  await run(root, 'config', 'user.email', 'test@example.invalid');
  await run(root, 'config', 'user.name', 'Test');
  await writeFile(path.join(root, 'tracked.txt'), 'initial');
  await run(root, 'add', 'tracked.txt'); await run(root, 'commit', '-m', 'initial');
  return root;
}

test('fingerprints tracked and applicable untracked content, excluding ignored and secret files', async () => {
  const root = await repo();
  try {
    const clean = await inspectGitContext(root); assert.equal(clean.isRepository, true);
    if (!clean.isRepository) return;
    await writeFile(path.join(root, '.gitignore'), '.env\nignored.txt\nnode_modules/\n');
    await writeFile(path.join(root, '.env'), 'TOP SECRET'); await writeFile(path.join(root, 'ignored.txt'), 'secret');
    await mkdir(path.join(root, 'node_modules'), { recursive: true }); await writeFile(path.join(root, 'node_modules', 'x'), 'secret');
    await writeFile(path.join(root, 'tracked.txt'), 'changed'); await writeFile(path.join(root, 'new.txt'), 'new content');
    const dirty = await inspectGitContext(root); assert.equal(dirty.isRepository, true);
    if (!dirty.isRepository) return;
    assert.notEqual(dirty.tracked.digest, clean.tracked.digest);
    assert.equal(dirty.untracked.files, 2); // .gitignore and new.txt
    assert(!JSON.stringify(dirty).includes('TOP SECRET'));
    assert.notEqual(dirty.untracked.digest, clean.untracked.digest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('linked worktrees retain their distinct git-dir and HEAD identity', async () => {
  const root = await repo(); const linked = `${root}-linked`;
  try {
    await run(root, 'branch', 'linked'); await run(root, 'worktree', 'add', linked, 'linked');
    const [a, b] = await Promise.all([inspectGitContext(root), inspectGitContext(linked)]);
    assert(a.isRepository && b.isRepository);
    if (a.isRepository && b.isRepository) {
      assert.equal(a.repository.commonDir, b.repository.commonDir);
      assert.notEqual(a.repository.gitDir, b.repository.gitDir);
      assert(b.repository.isLinkedWorktree);
      assert.notEqual(a.repository.branch, b.repository.branch);
    }
  } finally { await rm(linked, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('normalizes SSH and HTTPS remotes and strips credentials', async () => {
  const root = await repo();
  try {
    await run(root, 'remote', 'add', 'ssh', 'git@github.com:team/project.git');
    await run(root, 'remote', 'add', 'https', 'https://alice:secret@gitlab.example/group/repo.git?token=hidden');
    const result = await inspectGitContext(root); assert(result.isRepository);
    if (result.isRepository) {
      assert.deepEqual(result.repository.remotes, [{ host: 'github.com', owner: 'team', repo: 'project' }, { host: 'gitlab.example', owner: 'group', repo: 'repo' }]);
      assert(!JSON.stringify(result).match(/alice|secret|hidden/));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('returns an explicit non-repository result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-outside-'));
  try { assert.deepEqual(await inspectGitContext(root), { available: true, isRepository: false, reason: 'not_a_repository' }); }
  finally { await rm(root, { recursive: true, force: true }); }
});
