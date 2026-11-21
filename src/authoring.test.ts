import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GENERATED_ARTIFACT_MARKER, addCheckToChange, addDesignDecisionToChange, addRequirementToChange, addScenarioToChange, addTaskToChange,
  applyChangeOperations, applyChangeUpdate, initWorkspace, inspectChangeArtifacts, mutateChange, parseChangeOperations,
  persistChangeOperations, persistConversion, readChange, readiness, removeChangeItem, renderChangeArtifacts, scaffold,
  updateChangeItem, validateChange, validateChangeStructure, validatePlanning, withMarkdownArtifacts, writeChangeArtifacts, type Change,
} from './index.js';

test('in-place item editing updates every authored kind while preserving unrelated fields and task progress', () => {
  const base: Change = {
    schemaVersion: 1, id: 'edit-items', name: 'Edit items', createdAt: new Date().toISOString(), mode: 'standard',
    intent: 'Edit items', outcome: 'Items change safely', revision: 0,
    requirements: [{ id: 'REQ-1', title: 'Original', description: 'Original description' }, { id: 'REQ-2', title: 'Second', description: 'Second description' }],
    acceptanceScenarios: [{ id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'Edit runs', then: 'Fields persist' }],
    designDecisions: [{ id: 'DECISION-1', decision: 'Edit in place', rationale: 'Avoid replacements' }],
    checks: [{ id: 'CHECK-1', description: 'Check description', command: 'node --version', requirementIds: ['REQ-1'], taskIds: ['TASK-1'] }],
    tasks: [{ id: 'TASK-1', title: 'Task', status: 'in_progress', dependencies: [], requirementIds: ['REQ-1'] }],
    artifacts: { 'proposal.md': 'proposal.md' },
  };

  const requirement = updateChangeItem(base, 'requirement', 'REQ-1', { title: 'Renamed' });
  assert.equal(requirement.requirements[0].title, 'Renamed');
  assert.equal(requirement.requirements[0].description, 'Original description');

  const check = updateChangeItem(base, 'check', 'CHECK-1', { command: 'node -e "process.exit(0)"' });
  assert.equal(check.checks[0].command, 'node -e "process.exit(0)"');
  assert.equal(check.checks[0].description, 'Check description');
  assert.deepEqual(check.checks[0].requirementIds, ['REQ-1']);
  assert.deepEqual(check.checks[0].taskIds, ['TASK-1']);
  assert.throws(() => updateChangeItem(base, 'check', 'CHECK-1', { requirementIds: ['REQ-9'] }), (error: unknown) => (error as { code?: string }).code === 'unknown_check_requirement');

  const scenario = updateChangeItem(base, 'scenario', 'SCENARIO-1', { requirementId: 'REQ-2', then: 'Links move' });
  assert.equal(scenario.acceptanceScenarios[0].requirementId, 'REQ-2');
  assert.equal(scenario.acceptanceScenarios[0].when, 'Edit runs');
  assert.throws(() => updateChangeItem(base, 'scenario', 'SCENARIO-1', { requirementId: 'REQ-9' }), (error: unknown) => (error as { code?: string }).code === 'unknown_scenario_requirement');

  const decision = updateChangeItem(base, 'decision', 'DECISION-1', { rationale: 'Updated rationale' });
  assert.equal(decision.designDecisions[0].rationale, 'Updated rationale');
  assert.equal(decision.designDecisions[0].decision, 'Edit in place');

  const task = updateChangeItem(base, 'task', 'TASK-1', { requirementIds: ['REQ-2'] });
  assert.deepEqual(task.tasks[0].requirementIds, ['REQ-2']);
  assert.equal(task.tasks[0].status, 'in_progress');
  assert.throws(() => updateChangeItem(base, 'task', 'TASK-1', { status: 'completed' } as never), (error: unknown) => (error as { code?: string }).code === 'invalid_schema');
  assert.throws(() => updateChangeItem(base, 'requirement', 'REQ-404', { title: 'Missing' }), (error: unknown) => (error as { code?: string }).code === 'item_not_found');
  assert.throws(() => updateChangeItem(base, 'requirement', 'REQ-1', { command: 'node --version' } as never), (error: unknown) => (error as { code?: string }).code === 'invalid_schema');
});

test('structural validation stays separate from planning completeness while readiness reports both', () => {
  const draft: Change = {
    schemaVersion: 1, id: 'draft', name: 'Draft', createdAt: new Date().toISOString(), mode: 'quick',
    intent: '', outcome: '', requirements: [], acceptanceScenarios: [], designDecisions: [], checks: [], tasks: [], artifacts: {},
  };
  assert.deepEqual(validateChangeStructure(draft), []);
  const planning = validatePlanning(draft);
  assert.ok(planning.some(issue => issue.code === 'missing_intent'));
  assert.ok(planning.some(issue => issue.code === 'missing_requirements'));

  const partial = applyChangeUpdate(draft, { intent: 'Incremental', outcome: 'Author in steps' });
  assert.deepEqual(validateChangeStructure(partial), []);
  assert.equal(readiness(partial).ready, false);
  assert.ok(readiness(partial).blockers.some(issue => issue.code === 'missing_requirements'));

  const broken: Change = { ...partial, tasks: [{ id: 'TASK-1', title: 'Links missing', status: 'pending', dependencies: [], requirementIds: ['REQ-9'] }] };
  assert.ok(validateChangeStructure(broken).some(issue => issue.code === 'unknown_requirement'));
  assert.deepEqual(readiness(broken).blockers.map(issue => issue.code), validateChange(broken).map(issue => issue.code));
});

test('expected revisions fail before writing for mutate, remove, and convert operations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-revision-guard-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Revision Guard', 'quick');
    const updated = await mutateChange(root, initial.id, change => applyChangeUpdate(change, { intent: 'Guarded' }), { expectedRevision: 0 });
    assert.equal(updated.revision, 1);
    await assert.rejects(mutateChange(root, initial.id, change => applyChangeUpdate(change, { intent: 'Stale' }), { expectedRevision: 0 }), (error: unknown) => (error as { code?: string }).code === 'revision_conflict');
    assert.equal((await readChange(root, initial.id)).intent, 'Guarded');

    const withCheck = await mutateChange(root, initial.id, change => addCheckToChange(change, { id: 'CHECK-1', description: 'Guard' }), { expectedRevision: 1 });
    assert.equal(withCheck.revision, 2);
    await assert.rejects(removeChangeItem(root, initial.id, 'checks', 'CHECK-1', { expectedRevision: 1 }), (error: unknown) => (error as { code?: string }).code === 'revision_conflict');
    assert.equal((await readChange(root, initial.id)).checks.length, 1);

    await assert.rejects(persistConversion(root, initial.id, 'standard', { expectedRevision: 1 }), (error: unknown) => (error as { code?: string }).code === 'revision_conflict');
    assert.equal((await readChange(root, initial.id)).mode, 'quick');
    const converted = await persistConversion(root, initial.id, 'standard', { expectedRevision: 2 });
    assert.equal(converted.mode, 'standard');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ordered batches validate the final structure, write once, bump once, and roll back on failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-batch-authoring-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Batch Authoring', 'quick');
    const operations = parseChangeOperations([
      { op: 'field', intent: 'Batch intent', outcome: 'Batch outcome' },
      { op: 'add', kind: 'requirement', id: 'REQ-1', title: 'One', description: 'One requirement' },
      { op: 'add', kind: 'check', id: 'CHECK-1', description: 'Check', command: 'node --version', requirementIds: ['REQ-1'], taskIds: ['TASK-1'] },
      { op: 'add', kind: 'task', id: 'TASK-1', title: 'Task', requirementIds: ['REQ-1'] },
      { op: 'add', kind: 'scenario', id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'A batch runs', then: 'Links resolve' },
      { op: 'add', kind: 'decision', id: 'DECISION-1', decision: 'Validate at the end', rationale: 'Order independence' },
    ]);
    const applied = await persistChangeOperations(root, initial.id, operations, { expectedRevision: 0 });
    assert.equal(applied.applied, 6);
    assert.equal(applied.change.revision, 1);
    assert.deepEqual(applied.change.checks[0].taskIds, ['TASK-1']);
    assert.equal((await readChange(root, initial.id)).acceptanceScenarios[0].requirementId, 'REQ-1');

    const beforeFailure = await readChange(root, initial.id);
    await assert.rejects(persistChangeOperations(root, initial.id, parseChangeOperations([
      { op: 'add', kind: 'requirement', id: 'REQ-2', title: 'Two', description: 'Two' },
      { op: 'update', kind: 'requirement', id: 'REQ-404', title: 'Missing' },
    ]), { expectedRevision: 1 }), (error: unknown) => (error as { code?: string }).code === 'item_not_found');
    const afterFailure = await readChange(root, initial.id);
    assert.deepEqual(afterFailure.requirements, beforeFailure.requirements);
    assert.equal(afterFailure.revision, 1);

    await assert.rejects(persistChangeOperations(root, initial.id, parseChangeOperations([
      { op: 'add', kind: 'requirement', id: 'REQ-3', title: 'Three', description: 'Three' },
      { op: 'add', kind: 'scenario', id: 'SCENARIO-2', requirementId: 'REQ-9', when: 'Broken', then: 'Never' },
    ])), (error: unknown) => (error as { code?: string }).code === 'unknown_scenario_requirement');
    assert.equal((await readChange(root, initial.id)).requirements.length, 1);

    await assert.rejects(persistChangeOperations(root, initial.id, parseChangeOperations([{ op: 'field', intent: 'Stale' }]), { expectedRevision: 0 }), (error: unknown) => (error as { code?: string }).code === 'revision_conflict');
    assert.equal((await readChange(root, initial.id)).intent, 'Batch intent');

    assert.throws(() => parseChangeOperations([{ op: 'add', kind: 'task', id: 'TASK-2', title: 'Task', status: 'completed' }]), (error: unknown) => (error as { code?: string }).code === 'invalid_schema');
    assert.throws(() => parseChangeOperations([{ op: 'delta', requirementId: 'REQ-1' }]), (error: unknown) => (error as { code?: string }).code === 'invalid_schema');
    const preview = applyChangeOperations(beforeFailure, parseChangeOperations([
      { op: 'add', kind: 'requirement', id: 'REQ-2', title: 'Two', description: 'Two' },
      { op: 'update', kind: 'requirement', id: 'REQ-1', title: 'Renamed' },
    ]));
    assert.equal(preview.change.requirements.length, 2);
    assert.equal(preview.change.requirements[0].title, 'Renamed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rendered artifacts are deterministic, drift-checked, marker-guarded, and bump the revision once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-render-artifacts-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Render Integrity');
    const withContent = await mutateChange(root, initial.id, change => {
      let next = applyChangeUpdate(change, { intent: 'Render', outcome: 'Artifacts project the model', capabilityImpact: 'none', capabilityRationale: 'No durable capability change.' });
      next = addRequirementToChange(next, { id: 'REQ-1', title: 'Render', description: 'Artifacts render' });
      next = addScenarioToChange(next, { id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'Render runs', then: 'Spec includes the scenario' });
      next = addCheckToChange(next, { id: 'CHECK-1', description: 'Check render', command: 'node --version', requirementIds: ['REQ-1'] });
      next = addTaskToChange(next, { id: 'TASK-1', title: 'Render task', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] });
      return addDesignDecisionToChange(next, { id: 'DECISION-1', decision: 'Render from the model', rationale: 'One source of truth' });
    });
    const rendered = renderChangeArtifacts(withMarkdownArtifacts(withContent));
    assert.deepEqual(rendered.map(item => item.artifact), ['proposal.json', 'proposal.md', 'spec.json', 'spec.md', 'tasks.md']);
    assert.equal(rendered[1].content.split('\n')[0], GENERATED_ARTIFACT_MARKER);
    assert.deepEqual(rendered, renderChangeArtifacts(withMarkdownArtifacts(withContent)));
    assert.match(rendered[3].content, /WHEN Render runs THEN Spec includes the scenario/);
    assert.match(rendered[4].content, /\[ \] \*\*TASK-1\*\* Render task/);

    const drifted = await inspectChangeArtifacts(root, initial.id);
    assert.equal(drifted.drifted, true);
    assert.ok(drifted.artifacts.filter(item => item.role === 'rendered' || item.role === 'canonical').every(item => item.status === 'drifted'));

    const written = await writeChangeArtifacts(root, initial.id);
    assert.deepEqual(written.written, ['proposal.json', 'spec.json']);
    assert.equal(written.change.revision, withContent.revision ? withContent.revision + 1 : 1);
    const current = await inspectChangeArtifacts(root, initial.id);
    assert.equal(current.drifted, false);
    const again = await writeChangeArtifacts(root, initial.id);
    assert.deepEqual(again.written, []);
    assert.deepEqual(again.unchanged, ['proposal.json', 'spec.json']);
    assert.equal(again.change.revision, written.change.revision);

    const withMarkdown = await writeChangeArtifacts(root, initial.id, { markdown: true });
    assert.deepEqual(withMarkdown.written, ['proposal.md', 'spec.md', 'tasks.md']);
    assert.deepEqual(Object.keys(withMarkdown.change.artifacts).filter(name => name.endsWith('.md')).sort(), ['design.md', 'proposal.md', 'spec.md', 'tasks.md']);
    const markdownRevision = withMarkdown.change.revision ?? 0;

    const directory = path.join(root, '.notchlet', 'changes', initial.id);
    await writeFile(path.join(directory, 'proposal.md'), 'hand-authored content\n');
    const refused = await writeChangeArtifacts(root, initial.id);
    assert.deepEqual(refused.written, []);
    assert.equal(refused.refused.length, 1);
    assert.match(refused.refused[0].reason, /generated-content marker/);
    assert.equal(refused.change.revision, markdownRevision);
    const forced = await writeChangeArtifacts(root, initial.id, { force: true });
    assert.deepEqual(forced.written, ['proposal.md']);
    assert.equal(forced.change.revision, markdownRevision + 1);

    const quick = await scaffold(root, 'Quick Render', 'quick');
    const quickWritten = await writeChangeArtifacts(root, quick.id);
    assert.deepEqual(quickWritten.written, []);
    assert.deepEqual(quickWritten.unchanged, ['proposal.json']);
    assert.equal(quickWritten.change.revision, 0);
    assert.deepEqual(quickWritten.refused, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
