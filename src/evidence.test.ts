import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { appendEvidence, evaluateEvidenceFreshness, parseEvidenceRecord, readEvidence, type EvidenceRecord } from './evidence.js';
import { initWorkspace, scaffold } from './index.js';

const exec = promisify(execFile);
async function git(root: string, ...args: string[]) { await exec('git', args, { cwd: root, windowsHide: true }); }
async function setup(withGit = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-evidence-')); await initWorkspace(root);
  if (withGit) {
    await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.email', 'test@example.invalid'); await git(root, 'config', 'user.name', 'Test');
    await writeFile(path.join(root, '.gitignore'), '.notchlet/\n.env\n'); await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    await git(root, 'add', '.gitignore', 'source.ts'); await git(root, 'commit', '-m', 'initial');
  }
  const change = await scaffold(root, 'Evidence test');
  change.requirements.push({ id: 'req-1', title: 'Requirement', description: 'Desc' });
  change.checks.push({ id: 'check-1', description: 'Run check one' });
  change.tasks.push({ id: 'task-1', title: 'Task', status: 'pending', dependencies: [], requirementIds: ['req-1'] });
  await writeFile(path.join(root, '.notchlet', 'changes', change.id, 'tasks.json'), JSON.stringify(change));
  return { root, id: change.id };
}
const input = (provenance: 'recorded' | 'imported' = 'recorded', checkIds?: string[]) => ({ kind: 'check' as const, outcome: 'passed' as const, summary: 'Check completed', requirementIds: ['req-1'], taskIds: ['task-1'], ...(checkIds === undefined ? {} : { checkIds }), provenance });

test('validates change and requirement/task links and captures evidence', async () => {
  const { root, id } = await setup();
  try {
    await assert.rejects(appendEvidence(root, '../bad', input()), /Invalid change ID/);
    await assert.rejects(appendEvidence(root, id, { ...input(), requirementIds: ['missing'] }), /unknown requirement/);
    await assert.rejects(appendEvidence(root, id, { ...input(), taskIds: ['missing'] }), /unknown task/);
    await assert.rejects(appendEvidence(root, id, input('recorded', ['missing-check'])), /unknown check/);
    const linked = await appendEvidence(root, id, input('recorded', ['check-1']));
    assert.deepEqual(linked.checkIds, ['check-1']);
    const e = await appendEvidence(root, id, input()); assert.match(e.id, /^[0-9a-f-]+$/); assert.equal((await readEvidence(root, id)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v1 evidence parser accepts legacy records without checkIds and validates optional structured check links', async () => {
  const { root, id } = await setup();
  try {
    const legacy = await appendEvidence(root, id, input());
    assert.equal('checkIds' in legacy, false);
    const linked = await appendEvidence(root, id, input('recorded', ['check-1']));
    assert.deepEqual(parseEvidenceRecord(linked).checkIds, ['check-1']);
    const invalid = { ...linked, checkIds: ['unknown'] };
    await writeFile(path.join(root, '.notchlet', 'changes', id, 'evidence.jsonl'), `${JSON.stringify(invalid)}\n`);
    await assert.rejects(readEvidence(root, id), /unknown check ID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('freshness is current on a clean repository and stale after tracked source or change-artifact edits', async () => {
  const { root, id } = await setup(true);
  try {
    const e = await appendEvidence(root, id, input());
    assert.equal((await evaluateEvidenceFreshness(root, id, e)).status, 'fresh');
    await writeFile(path.join(root, '.env'), 'secret');
    assert.equal((await evaluateEvidenceFreshness(root, id, e)).status, 'fresh');
    await writeFile(path.join(root, 'source.ts'), 'export const value = 2;\n');
    assert.equal((await evaluateEvidenceFreshness(root, id, e)).status, 'stale');
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    const fresh = await appendEvidence(root, id, input());
    const dir = path.join(root, '.notchlet', 'changes', id);
    await writeFile(path.join(dir, 'design.md'), '# changed design\n');
    assert.equal((await evaluateEvidenceFreshness(root, id, fresh)).status, 'stale');
    await writeFile(path.join(dir, 'design.md'), '# restored design\n');
    const artifactEvidence = await appendEvidence(root, id, input());
    const tasksFile = path.join(dir, 'tasks.json');
    const change = JSON.parse(await readFile(tasksFile, 'utf8')) as { requirements: { description: string }[] };
    change.requirements[0].description = 'Changed requirement'; await writeFile(tasksFile, JSON.stringify(change));
    assert.equal((await evaluateEvidenceFreshness(root, id, artifactEvidence)).status, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v1 ingestion rejects locally-observed provenance and never marks supplied evidence independently verified', async () => {
  const { root, id } = await setup();
  try {
    await assert.rejects(appendEvidence(root, id, { ...input(), provenance: 'locally-observed' } as never), /only recorded or imported/);
    const evidence = await appendEvidence(root, id, input('recorded'));
    assert.equal((await evaluateEvidenceFreshness(root, id, evidence)).independentlyVerified, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('known artifact edits remain stale without Git while unchanged evidence is unknown', async () => {
  const { root, id } = await setup();
  try {
    const evidence = await appendEvidence(root, id, input());
    assert.equal((await evaluateEvidenceFreshness(root, id, evidence)).status, 'unknown');
    await writeFile(path.join(root, '.notchlet', 'changes', id, 'proposal.md'), '# edited');
    assert.equal((await evaluateEvidenceFreshness(root, id, evidence)).status, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent writes remain complete JSONL and provenance is distinguished', async () => {
  const { root, id } = await setup();
  try {
    const [recorded, imported, ...parallel] = await Promise.all([
      appendEvidence(root, id, input('recorded')), appendEvidence(root, id, input('imported')),
      ...Array.from({ length: 8 }, () => appendEvidence(root, id, input())),
    ]);
    assert.equal((await readEvidence(root, id)).length, 10);
    assert.equal((await evaluateEvidenceFreshness(root, id, recorded)).independentlyVerified, false);
    assert.equal((await evaluateEvidenceFreshness(root, id, imported)).independentlyVerified, false);
    assert.equal((await evaluateEvidenceFreshness(root, id, parallel[0])).independentlyVerified, false);
    assert.equal((await readFile(path.join(root, '.notchlet', 'changes', id, 'evidence.jsonl'), 'utf8')).trim().split('\n').length, 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});
