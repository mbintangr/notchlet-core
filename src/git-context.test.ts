import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { changedTrackedPaths, inspectGitContext } from './git-context.js';

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
    assert.equal(clean.dirty, false);
    assert.match(clean.repository.headTree ?? '', /^[a-f0-9]{40}$/);
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
    assert.equal(dirty.dirty, true);
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
      assert.deepEqual(result.repository.remoteDetails, [{ name: 'https', host: 'gitlab.example', owner: 'group', repo: 'repo' }, { name: 'ssh', host: 'github.com', owner: 'team', repo: 'project' }]);
      assert.deepEqual(result.repository.originRemote, undefined);
      assert(!JSON.stringify(result).match(/alice|secret|hidden/));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retains the origin remote name without retaining credentials', async () => {
  const root = await repo();
  try {
    await run(root, 'remote', 'add', 'origin', 'https://alice:secret@github.com/team/project.git');
    const result = await inspectGitContext(root); assert(result.isRepository);
    if (result.isRepository) {
      assert.deepEqual(result.repository.originRemote, { host: 'github.com', owner: 'team', repo: 'project' });
      assert.deepEqual(result.repository.remoteDetails, [{ name: 'origin', host: 'github.com', owner: 'team', repo: 'project' }]);
      assert(!JSON.stringify(result).match(/alice|secret/));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('excludes tracked credentials and workspace metadata from fingerprints and dirty status', async () => {
  const root = await repo();
  try {
    await writeFile(path.join(root, 'credentials.json'), '{"token":"secret"}');
    await mkdir(path.join(root, '.notchlet', 'changes', 'demo'), { recursive: true });
    await writeFile(path.join(root, '.notchlet', 'changes', 'demo', 'tasks.json'), '{}');
    await run(root, 'add', 'credentials.json'); await run(root, 'commit', '-m', 'credentials');
    const clean = await inspectGitContext(root); assert(clean.isRepository);
    if (!clean.isRepository) return;
    assert.equal(clean.dirty, false);

    await writeFile(path.join(root, 'credentials.json'), '{"token":"changed"}');
    await writeFile(path.join(root, '.env'), 'CHANGED');
    await writeFile(path.join(root, '.notchlet', 'changes', 'demo', 'tasks.json'), '{"changed":true}');
    const after = await inspectGitContext(root); assert(after.isRepository);
    if (!after.isRepository) return;
    assert.equal(after.tracked.digest, clean.tracked.digest);
    assert.equal(after.untracked.digest, clean.untracked.digest);
    assert.equal(after.dirty, false);
    assert(!JSON.stringify(after).includes('changed'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('returns an explicit non-repository result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-outside-'));
  try { assert.deepEqual(await inspectGitContext(root), { available: true, isRepository: false, reason: 'not_a_repository' }); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('exposes verified tracked paths and changed-path diffs against a commit', async () => {
  const root = await repo();
  try {
    await writeFile(path.join(root, '.env'), 'TRACKED SECRET');
    await run(root, 'add', '.env'); await run(root, 'commit', '-m', 'tracked secret');
    const before = await inspectGitContext(root); assert(before.isRepository);
    const head = before.repository.head as string;
    assert.deepEqual(before.trackedPaths, ['tracked.txt']);
    await writeFile(path.join(root, 'tracked.txt'), 'changed'); await writeFile(path.join(root, 'new.txt'), 'new');
    await writeFile(path.join(root, '.env'), 'TRACKED SECRET 2');
    assert.deepEqual(await changedTrackedPaths(root, head), ['tracked.txt']);
    await run(root, 'add', 'new.txt'); await run(root, 'commit', '-m', 'add new');
    assert.deepEqual(await changedTrackedPaths(root, head), ['new.txt', 'tracked.txt'].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});
