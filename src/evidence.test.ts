import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { inspectEvidence, appendEvidence, evaluateEvidenceFreshness, evidenceFingerprint, parseEvidenceRecord, readEvidence, resolveEvidenceScope, taskEvidenceStatus, type EvidenceRecord } from './evidence.js';
import { initWorkspace, parseChange, scaffold, transitionTask, writeChangeArtifacts } from './index.js';

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
    const artifact = await appendEvidence(root, id, { ...input('recorded', ['check-1']), kind: 'artifact', outcome: 'informational', summary: 'Artifact and checks captured together' });
    assert.deepEqual(artifact.checkIds, ['check-1']);
    const e = await appendEvidence(root, id, input()); assert.match(e.id, /^[0-9a-f-]+$/); assert.equal((await readEvidence(root, id)).length, 3);
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

test('without Git, workspace source and authored artifacts both stale evidence', async () => {
  const { root, id } = await setup();
  try {
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    const evidence = await appendEvidence(root, id, input());
    const unchanged = await evaluateEvidenceFreshness(root, id, evidence);
    assert.equal(unchanged.status, 'fresh');
    assert.equal(unchanged.basis, 'artifact');
    assert.equal(unchanged.sourceBound, true);
    assert.deepEqual(unchanged.reasons, []);
    await writeFile(path.join(root, '.notchlet', 'changes', id, 'proposal.md'), '# edited derived view');
    assert.equal((await evaluateEvidenceFreshness(root, id, evidence)).status, 'fresh');
    await writeFile(path.join(root, 'source.ts'), 'export const value = 2;\n');
    const sourceEdited = await evaluateEvidenceFreshness(root, id, evidence);
    assert.equal(sourceEdited.status, 'stale');
    assert.equal(sourceEdited.sourceBound, true);
    assert.match(sourceEdited.reasons.join(' '), /Workspace source fingerprint changed/);
    await writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
    await writeFile(path.join(root, '.notchlet', 'changes', id, 'design.md'), '# edited design');
    const edited = await evaluateEvidenceFreshness(root, id, evidence);
    assert.equal(edited.status, 'stale');
    assert.equal(edited.basis, 'artifact');
    assert.match(edited.reasons.join(' '), /Relevant change content/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy non-Git evidence without a source fingerprint stays fresh but source-unbound', async () => {
  const { root, id } = await setup();
  try {
    const evidence = await appendEvidence(root, id, input());
    const { source: _source, ...legacy } = evidence;
    const result = await evaluateEvidenceFreshness(root, id, legacy);
    assert.equal(result.status, 'fresh');
    assert.equal(result.sourceBound, false);
    assert.match(result.reasons.join(' '), /Recorded source fingerprint is unavailable/);
    assert.match(result.reasons.join(' '), /application source is unbound/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('oversized files keep new evidence fresh while legacy truncated observations stay unknown', async () => {
  const { root, id } = await setup(true);
  try {
    const evidence = await appendEvidence(root, id, input());
    const fresh = await evaluateEvidenceFreshness(root, id, evidence);
    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.basis, 'git');
    await writeFile(path.join(root, 'oversized.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
    const current = await evaluateEvidenceFreshness(root, id, evidence);
    assert.equal(current.status, 'fresh');
    const legacy = { ...evidence, fingerprintVersion: 2, git: { ...evidence.git, trackedPaths: undefined } } as unknown as EvidenceRecord;
    const truncated = await evaluateEvidenceFreshness(root, id, legacy);
    assert.equal(truncated.status, 'unknown');
    assert.equal(truncated.basis, 'git');
    assert.match(truncated.reasons.join(' '), /truncated/);
  } finally { await rm(root, { recursive: true, force: true }); }

  const nonGit = await setup();
  try {
    const evidence = await appendEvidence(nonGit.root, nonGit.id, input());
    await git(nonGit.root, 'init', '-b', 'main');
    await git(nonGit.root, 'config', 'user.email', 'test@example.invalid');
    await git(nonGit.root, 'config', 'user.name', 'Test');
    await writeFile(path.join(nonGit.root, '.gitignore'), '.notchlet/\n');
    await git(nonGit.root, 'add', '.gitignore');
    await git(nonGit.root, 'commit', '-m', 'initial');
    const unknown = await evaluateEvidenceFreshness(nonGit.root, nonGit.id, evidence);
    assert.equal(unknown.status, 'unknown');
    assert.match(unknown.reasons.join(' '), /Recorded Git observation is unavailable/);
  } finally { await rm(nonGit.root, { recursive: true, force: true }); }
});

test('verified-path evidence survives fast-forward and merge-commit integration', async () => {
  const { root, id } = await setup(true);
  try {
    await git(root, 'checkout', '-b', 'feature');
    await writeFile(path.join(root, 'feature.txt'), 'feature\n');
    await git(root, 'add', 'feature.txt');
    await git(root, 'commit', '-m', 'feature work');
    const fastForwardEvidence = await appendEvidence(root, id, input());
    await git(root, 'checkout', 'main');
    await git(root, 'merge', '--ff-only', 'feature');
    const fastForwarded = await evaluateEvidenceFreshness(root, id, fastForwardEvidence);
    assert.equal(fastForwarded.status, 'fresh', JSON.stringify(fastForwarded.reasons));
    assert.equal(fastForwarded.basis, 'git');
    assert.equal(fastForwarded.sourceBound, true);

    await git(root, 'checkout', '-b', 'feature-2');
    await writeFile(path.join(root, 'feature2.txt'), 'two\n');
    await git(root, 'add', 'feature2.txt');
    await git(root, 'commit', '-m', 'feature 2 work');
    const mergeEvidence = await appendEvidence(root, id, input());
    await git(root, 'checkout', 'main');
    await writeFile(path.join(root, 'main-only.txt'), 'main\n');
    await git(root, 'add', 'main-only.txt');
    await git(root, 'commit', '-m', 'main advanced');
    await git(root, 'merge', '--no-ff', 'feature-2', '-m', 'merge feature 2');
    const merged = await evaluateEvidenceFreshness(root, id, mergeEvidence);
    assert.equal(merged.status, 'fresh', JSON.stringify(merged.reasons));

    await writeFile(path.join(root, 'later.txt'), 'later\n');
    await git(root, 'add', 'later.txt');
    await git(root, 'commit', '-m', 'unrelated later commit');
    assert.equal((await evaluateEvidenceFreshness(root, id, mergeEvidence)).status, 'fresh');

    await writeFile(path.join(root, 'source.ts'), 'export const value = 9;\n');
    const stale = await evaluateEvidenceFreshness(root, id, mergeEvidence);
    assert.equal(stale.status, 'stale');
    assert.match(stale.reasons.join(' '), /Verified source changed after verification: source\.ts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('oversized tracked files leave new evidence fresh', async () => {
  const { root, id } = await setup(true);
  try {
    await writeFile(path.join(root, 'asset.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    await git(root, 'add', 'asset.bin');
    await git(root, 'commit', '-m', 'oversized asset');
    const evidence = await appendEvidence(root, id, input());
    assert.equal((await evaluateEvidenceFreshness(root, id, evidence)).status, 'fresh');
    await git(root, 'commit', '--allow-empty', '-m', 'later');
    assert.equal((await evaluateEvidenceFreshness(root, id, evidence)).status, 'fresh');
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

test('concurrent appends stress lock hand-off without transient EPERM failures', async () => {
  const { root, id } = await setup();
  try {
    const rounds = 5; const writers = 10;
    const ids: string[] = [];
    for (let round = 0; round < rounds; round++) {
      const records = await Promise.all(Array.from({ length: writers }, (_, index) => appendEvidence(root, id, { ...input(), summary: `Round ${round} writer ${index}` })));
      ids.push(...records.map(record => record.id));
    }
    const expected = rounds * writers;
    assert.equal(ids.length, expected);
    assert.equal(new Set(ids).size, expected);
    const lines = (await readFile(path.join(root, '.notchlet', 'changes', id, 'evidence.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, expected);
    for (const line of lines) parseEvidenceRecord(JSON.parse(line));
    assert.equal((await readEvidence(root, id)).length, expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task progress and rendered artifacts keep evidence current while authored edits stale it', async () => {
  const { root, id } = await setup();
  const file = path.join(root, '.notchlet', 'changes', id, 'tasks.json');
  try {
    let change = parseChange(await readFile(file, 'utf8'));
    change = { ...change, checks: [{ id: 'check-1', description: 'Run check one', taskIds: ['task-1'] }], tasks: [{ ...change.tasks[0], status: 'in_progress' }] };
    await writeFile(file, JSON.stringify(change, null, 2));
    const revision = change.revision ?? 0;
    const evidence = await appendEvidence(root, id, input('recorded', ['check-1']));
    assert.equal((await taskEvidenceStatus(root, change, 'task-1')).status, 'current');

    await transitionTask(file, 'task-1', 'completed', revision, { requireEvidence: true });
    await writeChangeArtifacts(root, id);
    assert.equal((await evaluateEvidenceFreshness(root, id, evidence)).status, 'fresh');
    assert.equal((await taskEvidenceStatus(root, parseChange(await readFile(file, 'utf8')), 'task-1')).status, 'current');

    change = parseChange(await readFile(file, 'utf8'));
    change.requirements[0].description = 'Changed requirement';
    await writeFile(file, JSON.stringify(change, null, 2));
    assert.equal((await evaluateEvidenceFreshness(root, id, evidence)).status, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('evidence scope links only executed checks plus their declared and explicitly selected items', () => {
  const change = parseChange({ schemaVersion: 1, id: 'scope', name: 'Scope', createdAt: new Date().toISOString(), mode: 'quick', intent: 'Intent', outcome: 'Outcome', requirements: [{ id: 'REQ-1', title: 'One', description: 'One' }, { id: 'REQ-2', title: 'Two', description: 'Two' }], checks: [{ id: 'CHECK-1', description: 'One', requirementIds: ['REQ-1'], taskIds: ['TASK-1'] }, { id: 'CHECK-2', description: 'Two' }], tasks: [{ id: 'TASK-1', title: 'One', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] }, { id: 'TASK-2', title: 'Two', status: 'pending', dependencies: [], requirementIds: ['REQ-2'] }], artifacts: {} });
  assert.deepEqual(resolveEvidenceScope(change, ['CHECK-1', 'NOT-DECLARED']), { checkIds: ['CHECK-1'], requirementIds: ['REQ-1'], taskIds: ['TASK-1'] });
  assert.deepEqual(resolveEvidenceScope(change, ['CHECK-2'], { requirementIds: ['REQ-1', 'REQ-1'], taskIds: ['TASK-1', 'TASK-2'] }), { checkIds: ['CHECK-2'], requirementIds: ['REQ-1'], taskIds: ['TASK-1', 'TASK-2'] });
  assert.deepEqual(resolveEvidenceScope(change, []), { checkIds: [], requirementIds: [], taskIds: [] });
  assert.throws(() => resolveEvidenceScope(change, [], { requirementIds: ['REQ-9'] }), (error: unknown) => (error as { code?: string }).code === 'unknown_requirement');
  assert.throws(() => resolveEvidenceScope(change, [], { taskIds: ['TASK-9'] }), (error: unknown) => (error as { code?: string }).code === 'unknown_task');
});

test('evidence inspection exposes links, freshness reasons, recovery, and every filter', async () => {
  const { root, id } = await setup();
  const changeFile = path.join(root, '.notchlet', 'changes', id, 'tasks.json');
  try {
    const change = JSON.parse(await readFile(changeFile, 'utf8'));
    change.checks[0].requirementIds = ['req-1'];
    change.checks[0].taskIds = ['task-1'];
    await writeFile(changeFile, JSON.stringify(change));
    const staleRecord = await appendEvidence(root, id, input('recorded', ['check-1']));
    await writeFile(path.join(root, '.notchlet', 'changes', id, 'design.md'), '# edited design\n');
    const failedRecord = await appendEvidence(root, id, { ...input('recorded', ['check-1']), outcome: 'failed', summary: 'Check failed' });

    const all = await inspectEvidence(root, id);
    assert.deepEqual(all.map(item => item.record.id), [staleRecord.id, failedRecord.id]);
    assert.equal(all[0].freshness.status, 'stale');
    assert.match(all[0].freshness.reasons.join(' '), /Relevant change content/);
    assert.match(all[0].recovery ?? '', new RegExp(`notchlet verify ${id} --check check-1 --record`));
    assert.equal(all[1].freshness.status, 'fresh');
    assert.match(all[1].recovery ?? '', new RegExp(`notchlet verify ${id} --check check-1 --record`));
    assert.deepEqual((await inspectEvidence(root, id, { checkId: 'check-1' })).map(item => item.record.id), [staleRecord.id, failedRecord.id]);
    assert.deepEqual((await inspectEvidence(root, id, { requirementId: 'req-1' })).map(item => item.record.id), [staleRecord.id, failedRecord.id]);
    assert.deepEqual((await inspectEvidence(root, id, { taskId: 'task-1' })).map(item => item.record.id), [staleRecord.id, failedRecord.id]);
    assert.deepEqual((await inspectEvidence(root, id, { requirementId: 'req-missing' })), []);
    assert.deepEqual((await inspectEvidence(root, id, { stale: true })).map(item => item.record.id), [staleRecord.id]);
    assert.deepEqual((await inspectEvidence(root, id, { failed: true })).map(item => item.record.id), [failedRecord.id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task completion warns or blocks without current passed evidence and reopening stays ungated', async () => {
  const { root, id } = await setup();
  const file = path.join(root, '.notchlet', 'changes', id, 'tasks.json');
  try {
    let change = parseChange(await readFile(file, 'utf8'));
    change = { ...change, checks: [{ id: 'check-1', description: 'Run check one', taskIds: ['task-1'] }], tasks: [{ ...change.tasks[0], status: 'in_progress' }] };
    await writeFile(file, JSON.stringify(change, null, 2));
    const revision = change.revision ?? 0;

    const missing = await taskEvidenceStatus(root, change, 'task-1');
    assert.equal(missing.status, 'missing');
    assert.deepEqual(missing.checkIds, ['check-1']);
    assert.match(missing.recovery, /--check check-1 --record --task task-1/);

    await assert.rejects(transitionTask(file, 'task-1', 'completed', revision, { requireEvidence: true }), (error: unknown) => (error as { code?: string }).code === 'evidence_required');
    const blocked = parseChange(await readFile(file, 'utf8'));
    assert.equal(blocked.revision ?? 0, revision);
    assert.equal(blocked.tasks[0].status, 'in_progress');

    const warned = await transitionTask(file, 'task-1', 'completed', revision);
    assert.equal(warned.warnings?.[0]?.code, 'evidence_missing');
    assert.equal(warned.warnings?.[0]?.evidenceStatus, 'missing');
    assert.match(warned.warnings?.[0]?.recovery ?? '', /--task task-1/);

    const reopened = await transitionTask(file, 'task-1', 'in_progress', revision + 1);
    assert.equal(reopened.warnings, undefined);
    assert.equal(reopened.tasks[0].status, 'in_progress');

    await appendEvidence(root, id, input('recorded', ['check-1']));
    const current = await taskEvidenceStatus(root, reopened, 'task-1');
    assert.equal(current.status, 'current');
    const completed = await transitionTask(file, 'task-1', 'completed', revision + 2, { requireEvidence: true });
    assert.equal(completed.warnings, undefined);
    assert.equal((await taskEvidenceStatus(root, completed, 'task-1')).status, 'current');

    const afterTransitions = await transitionTask(file, 'task-1', 'in_progress', revision + 3).then(() => transitionTask(file, 'task-1', 'completed', revision + 4));
    assert.equal(afterTransitions.warnings, undefined);
    assert.equal((await taskEvidenceStatus(root, afterTransitions, 'task-1')).status, 'current');

    const changedCheck = parseChange(await readFile(file, 'utf8'));
    changedCheck.checks[0].description = 'Changed acceptance check';
    await writeFile(file, JSON.stringify(changedCheck, null, 2));
    assert.equal((await taskEvidenceStatus(root, changedCheck, 'task-1')).status, 'stale');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('evidenceFingerprint reproduces the recorded v2 fingerprint from package contents', async () => {
  const { root, id } = await setup();
  try {
    const dir = path.join(root, '.notchlet', 'changes', id);
    const change = parseChange(await readFile(path.join(dir, 'tasks.json'), 'utf8'));
    const artifacts: Record<string, string> = {};
    for (const relative of Object.values(change.artifacts)) {
      try { artifacts[relative] = await readFile(path.join(dir, relative), 'utf8'); } catch { /* ENOENT stays missing */ }
    }
    const record = await appendEvidence(root, id, input());
    assert.equal(evidenceFingerprint(change, artifacts), record.artifactHash);
    const progressed = { ...change, tasks: change.tasks.map(task => ({ ...task, status: 'completed' as const })) };
    assert.equal(evidenceFingerprint(progressed, artifacts), record.artifactHash);
    assert.notEqual(evidenceFingerprint({ ...change, intent: 'Changed intent' }, artifacts), record.artifactHash);
    const withNote = { ...change, artifacts: { ...change.artifacts, 'notes.txt': 'notes.txt' } };
    assert.notEqual(evidenceFingerprint(withNote, artifacts), evidenceFingerprint(withNote, { ...artifacts, 'notes.txt': 'note' }));
    assert.equal(evidenceFingerprint(withNote, { ...artifacts, 'notes.txt': 'note' }), evidenceFingerprint(withNote, { ...artifacts, 'notes.txt': 'note' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
