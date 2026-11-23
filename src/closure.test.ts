import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendEvidence, authorCapabilityDeltaOperation, captureCapabilityBaseline, closeChange, deleteCapabilityDeltaOperation, initWorkspace, inspectChangeArtifacts, listArchivedChanges, listChanges, mutateChange, previewCapabilityClose, readArchivedChange, readEvidence, recoverCapabilityClose, restoreChange, scaffold, writeChangeArtifacts, type AcceptanceScenario, type CapabilityBaseline, type Change, type Requirement } from './index.js';

const req: Requirement = { id: 'REQ-BASE', title: 'Existing behavior', description: 'Keep this capability.' };
const scenario: AcceptanceScenario = { id: 'SCENARIO-BASE', requirementId: 'REQ-BASE', when: 'The feature is used', then: 'Existing behavior is preserved.' };
const addedReq: Requirement = { id: 'REQ-ADD', title: 'New behavior', description: 'Add one durable behavior.' };
const addedScenario: AcceptanceScenario = { id: 'SCENARIO-ADD', requirementId: 'REQ-ADD', when: 'The new feature is used', then: 'The new behavior is provided.' };
async function setup(options: { git?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-close-'));
  await initWorkspace(root);
  if (options.git !== false) {
    const git = spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    await writeFile(path.join(root, '.gitignore'), '.notchlet/\n');
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
    spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root }); spawnSync('git', ['commit', '-m', 'baseline'], { cwd: root, encoding: 'utf8' });
  }
  await mkdir(path.join(root, '.notchlet', 'capabilities'), { recursive: true });
  const baseline: CapabilityBaseline = { schemaVersion: 1, name: 'sample-capability', revision: 0, requirements: [{ value: req, provenance: { changeId: 'prior', revision: 1, acceptedAt: '2026-01-01T00:00:00Z', rationale: 'Initial acceptance' } }], scenarios: [{ value: scenario, provenance: { changeId: 'prior', revision: 1, acceptedAt: '2026-01-01T00:00:00Z', rationale: 'Initial acceptance' } }] };
  await writeFile(path.join(root, '.notchlet', 'capabilities', 'sample-capability.yaml'), JSON.stringify(baseline, null, 2));
  const change = await scaffold(root, 'Closure change', 'standard');
  const value: Change = {
    ...change, capabilityName: 'sample-capability', baselineRevision: 0, capabilityImpact: 'delta', capabilityRationale: 'Adds one durable behavior while preserving existing behavior.',
    intent: 'Extend behavior', outcome: 'Existing behavior remains and the new behavior is available',
    requirements: [req, addedReq], acceptanceScenarios: [scenario, addedScenario],
    capabilityDelta: { operations: [{ operation: 'add', requirementId: 'REQ-ADD', requirement: addedReq, scenarios: [addedScenario], rationale: 'Introduce the new behavior.' }] },
    designDecisions: [{ id: 'DECISION-1', decision: 'Add the new behavior', rationale: 'The capability gains one durable requirement.' }],
    checks: [{ id: 'CHECK-1', description: 'Run acceptance check' }],
    tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-BASE', 'REQ-ADD'] }],
    revision: 2,
  };
  const dir = path.join(root, '.notchlet', 'changes', change.id);
  await writeFile(path.join(dir, 'tasks.json'), JSON.stringify(value, null, 2));
  await writeFile(path.join(dir, 'design.md'), '# Design\n\nKeep the existing capability requirements unchanged, add the declared durable behavior, and verify with the declared check.\n');
  await writeChangeArtifacts(root, change.id);
  await appendEvidence(root, change.id, { kind: 'check', outcome: 'passed', summary: 'Acceptance check passed', requirementIds: ['REQ-BASE', 'REQ-ADD'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
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
    const manifest = JSON.parse(await readFile(path.join(root, '.notchlet', 'archive', id, 'closure.json'), 'utf8'));
    await assert.rejects(access(path.join(root, '.notchlet', 'archive', id, 'closure.md')), 'closure.md is opt-in');
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.changeId, id);
    assert.equal(manifest.contribution, 'delta');
    assert.equal(manifest.capability.resultingRevision, 1);
    assert.equal(manifest.verification.status, 'current');
    assert.deepEqual(manifest.verification.current, ['CHECK-1']);
    assert.equal(manifest.tasks.completed, 1);
    assert.equal(manifest.checks.total, 1);
    assert.equal(manifest.artifacts.find((artifact: { artifact: string }) => artifact.artifact === 'proposal.json').status, 'current');
    assert.match(manifest.artifacts.find((artifact: { artifact: string }) => artifact.artifact === 'proposal.json').sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.artifacts.find((artifact: { artifact: string }) => artifact.artifact === 'tasks.json').status, 'present');
    assert.equal(manifest.artifacts.find((artifact: { artifact: string }) => artifact.artifact === 'tasks.json').role, 'state');
    assert.equal(manifest.evidence.records, 1);
    assert.equal(manifest.evidence.current, 1);
    assert.equal(manifest.evidence.superseded, 0);
    assert.equal(manifest.evidence.attachments, 0);
    assert.equal(manifest.evidence.items[0].status, 'current');
    assert.deepEqual(manifest.evidence.items[0].requirementIds.sort(), ['REQ-ADD', 'REQ-BASE']);
    assert.equal(manifest.capability.baselineWritten, true);

    const archived = await listArchivedChanges(root);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].id, id);
    assert.equal(archived[0].closedAt, manifest.closedAt);
    assert.equal(archived[0].resultingRevision, 1);
    assert.equal((await readArchivedChange(root, id)).id, id);
    assert.equal((await readEvidence(root, id)).length, 1);
    assert.equal((await inspectChangeArtifacts(root, id)).drifted, false);

    const restored = await restoreChange(root, id);
    assert.equal(restored.id, id);
    assert.equal((await listChanges(root)).some(change => change.id === id), true);
    assert.equal((await listArchivedChanges(root)).length, 0);
    await access(path.join(root, '.notchlet', 'changes', id, 'tasks.json'));
    await assert.rejects(readArchivedChange(root, id), (error: unknown) => (error as { code?: string }).code === 'change_not_found');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closure preview reports and blocks drifted declared artifacts', async () => {
  const { root, id } = await setup();
  try {
    await mutateChange(root, id, change => ({ ...change, requirements: change.requirements.map(requirement => ({ ...requirement, description: 'Changed after the artifacts were rendered' })) }), {});
    const preview = await previewCapabilityClose(root, id);
    assert.deepEqual(preview.artifacts.map(artifact => [artifact.artifact, artifact.status]), [['proposal.json', 'drifted'], ['spec.json', 'drifted']]);
    const blocker = preview.blockers.find(item => item.code === 'artifact_drifted');
    assert(blocker);
    assert.match(blocker.recovery, new RegExp(`notchlet change render ${id} --write`));
    assert.equal(blocker.recoveryTool?.tool, 'notchlet_change_render');
    await assert.rejects(closeChange(root, id, { expectedBaselineRevision: 0 }), (error: unknown) => (error as { code?: string }).code === 'closure_blocked');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('close blocks a concurrent baseline revision and incomplete required acceptance', async () => {
  const { root, id, baselinePath } = await setup();
  try {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as CapabilityBaseline;
    baseline.revision = 1; await writeFile(baselinePath, JSON.stringify(baseline));
    assert((await previewCapabilityClose(root, id)).blockers.some(blocker => blocker.code === 'baseline_revision_conflict'));
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-quick-impact-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Quick impact', 'quick');
    const change: Change = {
      ...initial, intent: 'Maintain behavior', outcome: 'Behavior remains', requirements: [req],
      checks: [{ id: 'CHECK-1', description: 'Run acceptance check' }],
      tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-BASE'] }],
      revision: 1,
    };
    await writeFile(path.join(root, '.notchlet', 'changes', initial.id, 'tasks.json'), JSON.stringify(change));
    const preview = await previewCapabilityClose(root, initial.id);
    assert(preview.blockers.some(blocker => blocker.code === 'capability_impact_required'));
    assert(preview.blockers.every(blocker => blocker.recovery.length > 0 && blocker.recoveryTool?.tool));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a truncated Git observation makes verification unknown and blocks closure', async () => {
  const { root, id } = await setup();
  try {
    const fresh = await previewCapabilityClose(root, id);
    assert.equal(fresh.verification.status, 'current');
    await writeFile(path.join(root, 'oversized.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
    const preview = await previewCapabilityClose(root, id);
    assert.equal(preview.verification.status, 'unknown');
    assert.deepEqual(preview.verification.unknown, ['CHECK-1']);
    assert(preview.blockers.some(blocker => blocker.code === 'acceptance_not_current'));
    assert.match(preview.blockers.find(blocker => blocker.code === 'acceptance_not_current')?.recovery ?? '', /notchlet verify/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('quick no-impact change closes in a non-Git workspace without a capability baseline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-no-impact-'));
  try {
    await initWorkspace(root);
    const capabilities = path.join(root, '.notchlet', 'capabilities');
    await mkdir(capabilities, { recursive: true });
    const preserved = JSON.stringify({ schemaVersion: 1, name: 'other', revision: 5, requirements: [], scenarios: [] });
    await writeFile(path.join(capabilities, 'other.yaml'), preserved);
    const initial = await scaffold(root, 'No impact', 'quick');
    const change: Change = {
      ...initial, intent: 'Maintain behavior', outcome: 'Behavior remains', capabilityImpact: 'none', capabilityRationale: 'Documentation-only maintenance with no durable behavior change.',
      requirements: [req], checks: [{ id: 'CHECK-1', description: 'Run acceptance check' }],
      tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-BASE'] }],
      revision: 1,
    };
    await writeFile(path.join(root, '.notchlet', 'changes', initial.id, 'tasks.json'), JSON.stringify(change));
    await writeChangeArtifacts(root, initial.id);
    await appendEvidence(root, initial.id, { kind: 'check', outcome: 'passed', summary: 'Acceptance check passed', requirementIds: ['REQ-BASE'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const preview = await previewCapabilityClose(root, initial.id);
    assert.equal(preview.contribution, 'none');
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.verification.basis, 'artifact');
    assert.equal(preview.verification.status, 'current');
    assert.equal(preview.sourceBinding.bound, true);
    assert.equal(preview.sourceBinding.workspaceChecks, 1);
    const closed = await closeChange(root, initial.id, {});
    assert.equal(closed.archived, true);
    assert.equal(closed.baselineRevision, undefined);
    const manifest = JSON.parse(await readFile(path.join(root, '.notchlet', 'archive', initial.id, 'closure.json'), 'utf8'));
    assert.equal(manifest.sourceBinding.bound, true);
    assert.equal(manifest.sourceBinding.acceptedArtifactBasis, false);
    assert.equal(manifest.verification.sourceBound, true);
    await access(path.join(root, '.notchlet', 'archive', initial.id, 'tasks.json'));
    assert.equal(await readFile(path.join(capabilities, 'other.yaml'), 'utf8'), preserved);
    await assert.rejects(access(path.join(capabilities, `${initial.id}.yaml`)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-Git legacy evidence blocks closure until the artifact basis is acknowledged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-unbound-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Unbound evidence', 'quick');
    const change: Change = {
      ...initial, intent: 'Maintain behavior', outcome: 'Behavior remains', capabilityImpact: 'none', capabilityRationale: 'Documentation-only maintenance with no durable behavior change.',
      requirements: [req], checks: [{ id: 'CHECK-1', description: 'Run acceptance check' }],
      tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-BASE'] }],
      revision: 1,
    };
    await writeFile(path.join(root, '.notchlet', 'changes', initial.id, 'tasks.json'), JSON.stringify(change));
    await writeChangeArtifacts(root, initial.id);
    const evidence = await appendEvidence(root, initial.id, { kind: 'check', outcome: 'passed', summary: 'Acceptance check passed', requirementIds: ['REQ-BASE'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const { source: _source, ...legacy } = evidence;
    await writeFile(path.join(root, '.notchlet', 'changes', initial.id, 'evidence.jsonl'), `${JSON.stringify(legacy)}\n`);

    const preview = await previewCapabilityClose(root, initial.id);
    assert.equal(preview.verification.status, 'current');
    assert.equal(preview.sourceBinding.bound, false);
    assert.equal(preview.sourceBinding.unboundChecks, 1);
    const blocker = preview.blockers.find(item => item.code === 'artifact_basis_unacknowledged');
    assert(blocker);
    assert.match(blocker.recovery, /--accept-artifact-basis/);
    await assert.rejects(closeChange(root, initial.id, {}), (error: unknown) => (error as { code?: string }).code === 'closure_blocked');

    const closed = await closeChange(root, initial.id, { acceptArtifactBasis: true });
    assert.equal(closed.archived, true);
    const manifest = JSON.parse(await readFile(path.join(root, '.notchlet', 'archive', initial.id, 'closure.json'), 'utf8'));
    assert.equal(manifest.sourceBinding.bound, false);
    assert.equal(manifest.sourceBinding.acceptedArtifactBasis, true);
    assert.equal(manifest.verification.sourceBound, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('standard change stays blocked in a non-Git workspace until baseline and delta are authored', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-standard-delta-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Standard delta', 'standard');
    const dir = path.join(root, '.notchlet', 'changes', initial.id);
    const requirement: Requirement = { id: 'REQ-NEW', title: 'New behavior', description: 'Add durable behavior.' };
    const addedScenario: AcceptanceScenario = { id: 'SCENARIO-NEW', requirementId: 'REQ-NEW', when: 'The new behavior is used', then: 'The behavior is available.' };
    const change: Change = {
      ...initial, intent: 'Add behavior', outcome: 'Behavior exists', capabilityImpact: 'delta', capabilityRationale: 'Adds durable behavior.',
      requirements: [requirement], acceptanceScenarios: [addedScenario],
      designDecisions: [{ id: 'DECISION-1', decision: 'Snapshot authored content', rationale: 'Closure compares stored delta content.' }],
      checks: [{ id: 'CHECK-1', description: 'Run acceptance check' }],
      tasks: [{ id: 'TASK-1', title: 'Complete work', status: 'completed', dependencies: [], requirementIds: ['REQ-NEW'] }],
      revision: 1,
    };
    await writeFile(path.join(dir, 'tasks.json'), JSON.stringify(change));
    await writeFile(path.join(dir, 'design.md'), '# Design\n\nAuthor the new behavior and verify it with a declared check.\n');
    assert((await previewCapabilityClose(root, initial.id)).blockers.some(blocker => blocker.code === 'baseline_revision_missing'));
    await captureCapabilityBaseline(root, initial.id, { expectedRevision: 1 });
    const afterBaseline = await previewCapabilityClose(root, initial.id);
    assert(afterBaseline.blockers.some(blocker => blocker.code === 'capability_delta_required'));
    assert(afterBaseline.blockers.some(blocker => blocker.code === 'undeclared_capability_delta'));
    assert.equal(afterBaseline.baselineRevision, 0);
    const authored = await mutateChange(root, initial.id, current => authorCapabilityDeltaOperation(current, { operation: 'add', requirementId: 'REQ-NEW', rationale: 'Introduce the new behavior.' }), { expectedRevision: 2 });
    await writeChangeArtifacts(root, initial.id);
    await appendEvidence(root, initial.id, { kind: 'check', outcome: 'passed', summary: 'Acceptance check passed', requirementIds: ['REQ-NEW'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const ready = await previewCapabilityClose(root, initial.id);
    assert.deepEqual(ready.blockers, []);
    assert.equal(ready.additions[0].id, 'REQ-NEW');
    assert.equal(ready.verification.basis, 'artifact');
    const closed = await closeChange(root, initial.id, { expectedBaselineRevision: 0 });
    assert.equal(closed.baselineRevision, 1);
    const baseline = JSON.parse(await readFile(path.join(root, '.notchlet', 'capabilities', `${authored.capabilityName ?? initial.id}.yaml`), 'utf8')) as CapabilityBaseline;
    assert.equal(baseline.requirements[0].value.id, 'REQ-NEW');
    assert.equal(baseline.requirements[0].provenance.changeId, initial.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('baseline capture records new and existing revisions and rejects a stale expected revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-baseline-capture-'));
  try {
    await initWorkspace(root);
    await mkdir(path.join(root, '.notchlet', 'capabilities'), { recursive: true });
    const first = await scaffold(root, 'First capture', 'standard');
    const captured = await captureCapabilityBaseline(root, first.id, { capabilityName: 'capture-target' });
    assert.equal(captured.baselineRevision, 0);
    assert.equal(captured.change.baselineRevision, 0);
    assert.equal(captured.change.capabilityName, 'capture-target');
    assert.equal(captured.change.revision, 1);

    await writeFile(path.join(root, '.notchlet', 'capabilities', 'capture-target.yaml'), JSON.stringify({ schemaVersion: 1, name: 'capture-target', revision: 3, requirements: [], scenarios: [] }));
    const second = await scaffold(root, 'Second capture', 'standard');
    const existing = await captureCapabilityBaseline(root, second.id, { capabilityName: 'capture-target' });
    assert.equal(existing.baselineRevision, 3);
    assert.equal(existing.change.baselineRevision, 3);

    const file = path.join(root, '.notchlet', 'changes', second.id, 'tasks.json');
    const before = await readFile(file, 'utf8');
    await assert.rejects(captureCapabilityBaseline(root, second.id, { capabilityName: 'capture-target', expectedRevision: 0 }), (error: unknown) => (error as { code?: string }).code === 'revision_conflict');
    assert.equal(await readFile(file, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('delta authoring snapshots authored content, rejects duplicates, deletes operations, and detects post-edit mismatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-delta-'));
  try {
    await initWorkspace(root);
    await mkdir(path.join(root, '.notchlet', 'capabilities'), { recursive: true });
    const initial = await scaffold(root, 'Delta authoring', 'standard');
    await writeFile(path.join(root, '.notchlet', 'capabilities', `${initial.id}.yaml`), JSON.stringify({
      schemaVersion: 1, name: initial.id, revision: 0,
      requirements: [{ value: { id: 'REQ-GONE', title: 'Retired behavior', description: 'Removed by this change.' }, provenance: { changeId: 'prior', revision: 1, acceptedAt: '2026-01-01T00:00:00Z', rationale: 'Previously accepted.' } }],
      scenarios: [],
    }));
    const dir = path.join(root, '.notchlet', 'changes', initial.id);
    const requirement: Requirement = { id: 'REQ-D', title: 'Delta behavior', description: 'Declared behavior.' };
    const linked: AcceptanceScenario = { id: 'SCENARIO-D', requirementId: 'REQ-D', when: 'Used', then: 'Provided' };
    const change: Change = {
      ...initial, intent: 'Add behavior', outcome: 'Behavior exists', capabilityImpact: 'delta', capabilityRationale: 'Durable addition.',
      requirements: [requirement], acceptanceScenarios: [linked],
      designDecisions: [{ id: 'DECISION-1', decision: 'Snapshot', rationale: 'Compare exact content.' }],
      checks: [{ id: 'CHECK-1', description: 'Check' }],
      tasks: [{ id: 'TASK-1', title: 'Work', status: 'completed', dependencies: [], requirementIds: ['REQ-D'] }],
      revision: 1,
    };
    await writeFile(path.join(dir, 'tasks.json'), JSON.stringify(change));
    await writeFile(path.join(dir, 'design.md'), '# Design\n\nAuthor the delta and verify behavior.\n');
    const captured = await captureCapabilityBaseline(root, initial.id, { expectedRevision: 1 });
    assert.equal(captured.baselineRevision, 0);

    const added = await mutateChange(root, initial.id, current => authorCapabilityDeltaOperation(current, { operation: 'add', requirementId: 'REQ-D', rationale: 'Accept the new behavior.' }), { expectedRevision: 2 });
    assert.deepEqual(added.capabilityDelta?.operations[0].requirement, requirement);
    assert.deepEqual(added.capabilityDelta?.operations[0].scenarios, [linked]);
    await assert.rejects(mutateChange(root, initial.id, current => authorCapabilityDeltaOperation(current, { operation: 'update', requirementId: 'REQ-D', rationale: 'Duplicate.' })), (error: unknown) => (error as { code?: string }).code === 'duplicate_delta_operation');

    const edited = await mutateChange(root, initial.id, current => ({ ...current, requirements: current.requirements.map(item => item.id === 'REQ-D' ? { ...item, description: 'Edited after authoring.' } : item) }), { expectedRevision: 3 });
    assert(edited.requirements[0].description.includes('Edited'));
    assert((await previewCapabilityClose(root, initial.id)).blockers.some(blocker => blocker.code === 'capability_delta_mismatch'));

    const deleted = await mutateChange(root, initial.id, current => deleteCapabilityDeltaOperation(current, 'REQ-D'), { expectedRevision: 4 });
    assert.deepEqual(deleted.capabilityDelta?.operations, []);
    await assert.rejects(mutateChange(root, initial.id, current => deleteCapabilityDeltaOperation(current, 'REQ-D')), (error: unknown) => (error as { code?: string }).code === 'delta_operation_not_found');

    const restored = await mutateChange(root, initial.id, current => authorCapabilityDeltaOperation(current, { operation: 'add', requirementId: 'REQ-D', rationale: 'Re-author the corrected behavior.' }), { expectedRevision: 5 });
    assert.equal(restored.capabilityDelta?.operations.length, 1);
    const removal = await mutateChange(root, initial.id, current => authorCapabilityDeltaOperation(current, { operation: 'remove', requirementId: 'REQ-GONE', rationale: 'Retire the behavior.' }), { expectedRevision: 6 });
    const removeOperation = removal.capabilityDelta?.operations.find(operation => operation.requirementId === 'REQ-GONE');
    assert.equal(removeOperation?.operation, 'remove');
    assert.equal(removeOperation?.rationale, 'Retire the behavior.');
    assert.equal(removeOperation?.requirement, undefined, 'remove operations carry no replacement content');
    assert.deepEqual(removeOperation?.scenarios, undefined);
    await writeChangeArtifacts(root, initial.id);
    await appendEvidence(root, initial.id, { kind: 'check', outcome: 'passed', summary: 'Acceptance check passed after re-authoring', requirementIds: ['REQ-D'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const finalPreview = await previewCapabilityClose(root, initial.id);
    assert.deepEqual(finalPreview.blockers, []);
    assert.deepEqual(finalPreview.removals, ['REQ-GONE']);
    assert.equal(finalPreview.mergedRequirements.some(entry => entry.value.id === 'REQ-GONE'), false);
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
    change.capabilityDelta!.operations.push({ operation: 'add', requirementId: added.id, requirement: added, scenarios: [addedScenario], rationale: 'A reviewed durable capability addition.' });
    await writeFile(statePath, JSON.stringify(change));
    await writeChangeArtifacts(root, id);
    await appendEvidence(root, id, { kind: 'check', outcome: 'passed', summary: 'Acceptance check passed for explicit delta', requirementIds: ['REQ-BASE', added.id], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded' });
    const preview = await previewCapabilityClose(root, id);
    assert.deepEqual(preview.additions, [addedReq, added]);
    assert.equal(preview.blockers.length, 0);
    await closeChange(root, id, { expectedBaselineRevision: 0 });
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as CapabilityBaseline;
    const entry = baseline.requirements.find(item => item.value.id === added.id)!;
    assert.deepEqual(entry.value, added);
    assert.equal(entry.provenance.changeId, id);
    assert.equal(baseline.scenarios.find(item => item.value.id === addedScenario.id)?.provenance.changeId, id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('close blocks drifted or invalid source plans unless drift is accepted and records provenance', async () => {
  const { root, id } = await setup();
  try {
    const planText = JSON.stringify({ intent: 'Keep behavior', outcome: 'Behavior retained' }, null, 2);
    await mkdir(path.join(root, '.notchlet', 'plans'), { recursive: true });
    const planPath = path.join(root, '.notchlet', 'plans', 'source.json');
    await writeFile(planPath, planText);
    await mutateChange(root, id, current => ({
      ...current,
      sourcePlan: { path: '.notchlet/plans/source.json', sha256: createHash('sha256').update(planText).digest('hex'), importedAt: '2026-01-01T00:00:00.000Z' },
    }));

    await writeFile(planPath, `${planText}\n`);
    await assert.rejects(
      closeChange(root, id, { expectedBaselineRevision: 0 }),
      (error: unknown) => (error as { code?: string }).code === 'plan_drift_unacknowledged',
    );

    await writeFile(planPath, '{"intent": 7}');
    await assert.rejects(
      closeChange(root, id, { expectedBaselineRevision: 0 }),
      (error: unknown) => (error as { code?: string }).code === 'plan_drift_unacknowledged',
    );

    const closed = await closeChange(root, id, { expectedBaselineRevision: 0, acceptPlanDrift: true });
    assert.equal(closed.archived, true);
    const manifest = JSON.parse(await readFile(path.join(root, '.notchlet', 'archive', id, 'closure.json'), 'utf8'));
    assert.equal(manifest.plan.status, 'drifted');
    assert.equal(manifest.plan.validation, 'invalid');
    assert.match(manifest.plan.validationError, /intent/i);
    assert.equal(manifest.plan.acceptedDrift, true);
    assert.equal(manifest.plan.recordedSha256, createHash('sha256').update(planText).digest('hex'));
    assert.equal(manifest.plan.path, '.notchlet/plans/source.json');
  } finally { await rm(root, { recursive: true, force: true }); }
});
