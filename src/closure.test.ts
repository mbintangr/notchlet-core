import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendEvidence, closeChange, initWorkspace, previewCapabilityClose, recoverCapabilityClose, scaffold, type AcceptanceScenario, type CapabilityBaseline, type Change, type Requirement } from './index.js';

const req: Requirement = { id: 'REQ-BASE', title: 'Existing behavior', description: 'Keep this capability.' };
const scenario: AcceptanceScenario = { id: 'SCENARIO-BASE', requirementId: 'REQ-BASE', when: 'The feature is used', then: 'Existing behavior is preserved.' };
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-close-'));
  await initWorkspace(root);
  const git = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  await writeFile(path.join(root, '.gitignore'), '.notchlet/\n');
  spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
  spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root }); spawnSync('git', ['commit', '-m', 'baseline'], { cwd: root, encoding: 'utf8' });
  await mkdir(path.join(root, '.notchlet', 'capabilities'), { recursive: true });
  const baseline: CapabilityBaseline = { schemaVersion: 1, name: 'sample-capability', revision: 0, requirements: [{ value: req, provenance: { changeId: 'prior', revision: 1, acceptedAt: '2026-01-01T00:00:00Z', rationale: 'Initial acceptance' } }], scenarios: [{ value: scenario, provenance: { changeId: 'prior', revision: 1, acceptedAt: '2026-01-01T00:00:00Z', rationale: 'Initial acceptance' } }] };
  await writeFile(path.join(root, '.notchlet', 'capabilities', 'sample-capability.yaml'), JSON.stringify(baseline, null, 2));
  const change = await scaffold(root, 'Closure change', 'quick');
  const value: Change = { ...change, capabilityName: 'sample-capability', baselineRevision: 0, capabilityImpact: 'none', capabilityRationale: 'No durable behavior changed.', intent: 'Maintain behavior', outcome: 'Existing behavior remains', requirements: [req], checks: [{ id: 'CHECK-1', description: 'Run acceptance check' }], tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-BASE'] }], revision: 2 };
  await writeFile(path.join(root, '.notchlet', 'changes', change.id, 'tasks.json'), JSON.stringify(value, null, 2));
  await appendEvidence(root, change.id, { kind: 'check', outcome: 'passed', summary: 'Acceptance check passed', requirementIds: ['REQ-BASE'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
  return { root, id: change.id, baselinePath: path.join(root, '.notchlet', 'capabilities', 'sample-capability.yaml') };
}

test('preview preserves unaffected requirements and close retains their provenance', async () => {
  const { root, id, baselinePath } = await setup();
  try {
    const preview = await previewCapabilityClose(root, id);
    assert.equal(preview.blockers.length, 0);
    assert.deepEqual(preview.preservedRequirementIds, ['REQ-BASE']);
    const closed = await closeChange(root, id, { expectedBaselineRevision: 0 });
    assert.equal(closed.baselineRevision, 1);
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as CapabilityBaseline;
    assert.deepEqual(baseline.requirements[0].value, req);
    assert.equal(baseline.requirements[0].provenance.changeId, 'prior');
    assert.deepEqual(baseline.scenarios[0].value, scenario);
    assert.equal(baseline.scenarios[0].provenance.changeId, 'prior');
    await assert.rejects(readFile(path.join(root, '.notchlet', 'changes', id, 'tasks.json')));
    assert.equal((await readFile(path.join(root, '.notchlet', 'archive', id, 'tasks.json'), 'utf8')).length > 0, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('close blocks a concurrent baseline revision and incomplete required acceptance', async () => {
  const { root, id, baselinePath } = await setup();
  try {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as CapabilityBaseline;
    baseline.revision = 1; await writeFile(baselinePath, JSON.stringify(baseline));
    await assert.rejects(closeChange(root, id, { expectedBaselineRevision: 0 }), (error: unknown) => (error as { code?: string }).code === 'baseline_revision_conflict');
    baseline.revision = 0; await writeFile(baselinePath, JSON.stringify(baseline));
    await rm(path.join(root, '.notchlet', 'changes', id, 'evidence.jsonl'));
    assert((await previewCapabilityClose(root, id)).blockers.some(blocker => blocker.code === 'acceptance_not_current'));
    await appendEvidence(root, id, { kind: 'check', outcome: 'passed', summary: 'CHECK-1 acceptance passed, but not structurally linked', requirementIds: ['REQ-BASE'], taskIds: ['TASK-1'], provenance: 'recorded' });
    assert((await previewCapabilityClose(root, id)).blockers.some(blocker => blocker.code === 'acceptance_not_current'));
    await appendEvidence(root, id, { kind: 'check', outcome: 'passed', summary: 'Acceptance restored', requirementIds: ['REQ-BASE'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const statePath = path.join(root, '.notchlet', 'changes', id, 'tasks.json');
    const change = JSON.parse(await readFile(statePath, 'utf8')); change.tasks[0].status = 'pending'; await writeFile(statePath, JSON.stringify(change));
    const preview = await previewCapabilityClose(root, id);
    assert(preview.blockers.some(blocker => blocker.code === 'tasks_incomplete'));
    await assert.rejects(closeChange(root, id, { expectedBaselineRevision: 0 }), (error: unknown) => (error as { code?: string }).code === 'closure_blocked');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('injected interruption recovers journaled close idempotently without loss or duplication', async () => {
  const { root, id, baselinePath } = await setup();
  try {
    await assert.rejects(closeChange(root, id, { expectedBaselineRevision: 0, injectInterruption(point) { if (point === 'baseline-written') throw new Error('injected interruption'); } }), /injected interruption/);
    const recovered = await recoverCapabilityClose(root, id);
    assert.equal(recovered.archived, true);
    assert.equal(recovered.baselineRevision, 1);
    assert.equal((await recoverCapabilityClose(root, id)).archived, true);
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as CapabilityBaseline;
    assert.equal(baseline.revision, 1);
    assert.equal(baseline.requirements.filter(entry => entry.value.id === 'REQ-BASE').length, 1);
    assert.equal((await readFile(path.join(root, '.notchlet', 'archive', id, 'tasks.json'), 'utf8')).length > 0, true);
    assert.equal((await readFile(path.join(root, '.notchlet', '.local', 'close', `${id}.json`), 'utf8')).includes('complete'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rerunning close resumes the same prepared operation before applying its baseline update', async () => {
  const { root, id, baselinePath } = await setup();
  try {
    await assert.rejects(closeChange(root, id, { expectedBaselineRevision: 0, injectInterruption(point) { if (point === 'journal-prepared') throw new Error('interrupted after journal prepare'); } }), /interrupted after journal prepare/);
    const resumed = await closeChange(root, id, { expectedBaselineRevision: 0 });
    assert.equal(resumed.archived, true);
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as CapabilityBaseline;
    assert.equal(baseline.revision, 1);
    assert.equal(baseline.requirements.filter(entry => entry.value.id === 'REQ-BASE').length, 1);
    assert.equal((await readFile(path.join(root, '.notchlet', 'archive', id, 'tasks.json'), 'utf8')).length > 0, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('quick change cannot close without explicit capability impact and rationale', async () => {
  const { root, id } = await setup();
  try {
    const statePath = path.join(root, '.notchlet', 'changes', id, 'tasks.json');
    const change = JSON.parse(await readFile(statePath, 'utf8')); delete change.capabilityImpact; delete change.capabilityRationale; await writeFile(statePath, JSON.stringify(change));
    assert((await previewCapabilityClose(root, id)).blockers.some(blocker => blocker.code === 'capability_impact_required'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit capability delta is previewed and accepted with change provenance', async () => {
  const { root, id, baselinePath } = await setup();
  try {
    const statePath = path.join(root, '.notchlet', 'changes', id, 'tasks.json');
    const change = JSON.parse(await readFile(statePath, 'utf8')) as Change;
    const added: Requirement = { id: 'REQ-NEW', title: 'New behavior', description: 'Add durable behavior.' };
    const addedScenario: AcceptanceScenario = { id: 'SCENARIO-NEW', requirementId: added.id, when: 'The new capability is used', then: 'The new behavior is available.' };
    change.capabilityImpact = 'delta';
    change.requirements.push(added);
    change.acceptanceScenarios.push(addedScenario);
    change.tasks[0].requirementIds.push(added.id);
    change.capabilityDelta = { operations: [{ operation: 'add', requirementId: added.id, requirement: added, scenarios: [addedScenario], rationale: 'A reviewed durable capability addition.' }] };
    await writeFile(statePath, JSON.stringify(change));
    await appendEvidence(root, id, { kind: 'check', outcome: 'passed', summary: 'Acceptance check passed for explicit delta', requirementIds: ['REQ-BASE', added.id], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const preview = await previewCapabilityClose(root, id);
    assert.deepEqual(preview.additions, [added]);
    assert.equal(preview.blockers.length, 0);
    await closeChange(root, id, { expectedBaselineRevision: 0 });
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as CapabilityBaseline;
    const entry = baseline.requirements.find(item => item.value.id === added.id)!;
    assert.deepEqual(entry.value, added);
    assert.equal(entry.provenance.changeId, id);
    assert.equal(baseline.scenarios.find(item => item.value.id === addedScenario.id)?.provenance.changeId, id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
