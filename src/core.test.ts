import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION, addCheckToChange, addRequirementToChange, addScenarioToChange, addTaskToChange, appendEvidence, applyChangeUpdate, capabilityContribution, deriveState, evaluateState, evaluateVerificationFacets, findWorkspace, importChangePlan, initWorkspace, inspectChangeArtifacts, instructions, listChanges, mutateChange, parseAcceptanceScenario, parseChange, parseChangePlan, parseCliJsonEnvelope, parseDesignDecision, parseEvidence, parseInstruction, parseTask, persistConversion, projectChangePlan, readChange, readiness, removeChangeItem, scaffold, stableId, transitionTask, validateChange, type Change } from './index.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

test('shared core exposes the version recorded in its package manifest', async () => {
  const manifest = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
  assert.equal(CORE_VERSION, manifest.version);
});

test('stable IDs normalize names and validators find unresolved dependencies', () => {
  assert.equal(stableId('Hello, World!'), 'hello-world');
  const c: Change = { schemaVersion: 1, id: 'x', name: 'x', createdAt: new Date().toISOString(), mode: 'quick', intent: 'Do work', outcome: 'Improve it', requirements: [{ id: 'r1', title: 'One', description: 'One requirement' }], acceptanceScenarios: [], designDecisions: [], checks: [{ id: 'check', description: 'Run a check' }], tasks: [{ id: 'a', title: 'A', status: 'pending', dependencies: ['missing'], requirementIds: ['r1'] }], artifacts: { 'proposal.md': 'proposal.md' } };
  assert.equal(validateChange(c).find(i => i.code === 'unknown_dependency')?.code, 'unknown_dependency');
});

test('workspace discovery is read-only and task updates require expected revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-'));
  try {
    assert.equal(await findWorkspace(root), null);
    await initWorkspace(root);
    const metadata = await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8');
    await initWorkspace(root);
    assert.equal(await readFile(path.join(root, '.notchlet', 'workspace.json'), 'utf8'), metadata);
    assert.equal(await findWorkspace(path.join(root, 'nested')), root);
    const file = path.join(root, '.notchlet', 'state.json');
    await import('node:fs/promises').then(fs => fs.writeFile(file, JSON.stringify({ schemaVersion: 1, id: 'x', name: 'x', createdAt: new Date().toISOString(), mode: 'quick', intent: 'Test task transition', outcome: 'Task status changes', requirements: [], checks: [], tasks: [{ id: 'a', title: 'A', status: 'pending', dependencies: [], requirementIds: [] }], artifacts: {}, revision: 0 })));
    await assert.rejects(transitionTask(file, 'a', 'completed', 0), (error: unknown) => (error as { code?: string }).code === 'invalid_transition');
    const started = await transitionTask(file, 'a', 'in_progress', 0);
    assert.equal(started.revision, 1);
    const next = await transitionTask(file, 'a', 'completed', 1);
    assert.equal(next.revision, 2);
    await assert.rejects(transitionTask(file, 'a', 'pending', 0), /Revision conflict/);
    assert.match(deriveState(next), /does not imply verification/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).tasks[0].status, 'completed');
    const forced = await transitionTask(file, 'a', 'pending', 2, { force: true });
    assert.equal(forced.tasks[0].status, 'pending');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('check links are optional, validated against authored items, and legacy changes still parse', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-check-links-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Check Link Test', 'quick');
    const legacy = parseChange({ ...initial, checks: [{ id: 'CHK-OLD', description: 'Legacy check' }] });
    assert.equal(legacy.checks[0].requirementIds, undefined);
    assert.equal(legacy.checks[0].taskIds, undefined);
    const linked = parseChange({ ...initial, requirements: [{ id: 'REQ-1', title: 'One', description: 'One' }], checks: [{ id: 'CHK-1', description: 'Linked', requirementIds: ['REQ-1'], taskIds: ['TASK-1'] }], tasks: [{ id: 'TASK-1', title: 'One', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] }] });
    assert.deepEqual(linked.checks[0].requirementIds, ['REQ-1']);
    assert.deepEqual(linked.checks[0].taskIds, ['TASK-1']);
    assert.throws(() => parseChange({ ...initial, checks: [{ id: 'CHK-2', description: 'Duplicate', taskIds: ['TASK-1', 'TASK-1'] }] }), (error: unknown) => (error as { code?: string }).code === 'invalid_schema');

    await mutateChange(root, initial.id, current => addRequirementToChange(current, { id: 'REQ-1', title: 'One', description: 'One' }));
    await mutateChange(root, initial.id, current => addTaskToChange(current, { id: 'TASK-1', title: 'One', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] }));
    const authored = await mutateChange(root, initial.id, current => addCheckToChange(current, { id: 'CHK-1', description: 'Linked', command: 'node --version', requirementIds: ['REQ-1'], taskIds: ['TASK-1'] }));
    assert.deepEqual(authored.checks[0].requirementIds, ['REQ-1']);
    assert.deepEqual(authored.checks[0].taskIds, ['TASK-1']);
    await assert.rejects(mutateChange(root, initial.id, current => addCheckToChange(current, { id: 'CHK-2', description: 'Bad requirement', requirementIds: ['REQ-9'] })), /unknown requirement/);
    await assert.rejects(mutateChange(root, initial.id, current => addCheckToChange(current, { id: 'CHK-3', description: 'Bad task', taskIds: ['TASK-9'] })), /unknown task/);
    await assert.rejects(removeChangeItem(root, initial.id, 'tasks', 'TASK-1'), /linked by check/);
    await assert.rejects(removeChangeItem(root, initial.id, 'requirements', 'REQ-1'), /still referenced/);
    const validated = await readChange(root, initial.id);
    const issues = validateChange({ ...validated, checks: [...validated.checks, { id: 'CHK-BAD', description: 'Broken', requirementIds: ['REQ-9'], taskIds: ['TASK-9'] }] }).map(issue => issue.code);
    assert.ok(issues.includes('unknown_check_requirement'));
    assert.ok(issues.includes('unknown_check_task'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scaffolds stable quick/standard change artifacts without overwriting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-scaffold-'));
  try {
    await initWorkspace(root);
    const change = await scaffold(root, 'A Useful Change', 'quick');
    assert.equal(change.id, 'a-useful-change');
    assert.deepEqual(Object.keys(change.artifacts).sort(), ['proposal.json', 'tasks.json']);
    assert.equal((await inspectChangeArtifacts(root, change.id)).drifted, false);
    assert.equal(readiness(change).ready, false);
    assert(readiness(change).blockers.some(issue => issue.code === 'missing_requirements'));
    await assert.rejects(scaffold(root, 'A Useful Change', 'standard'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scaffold persists revision 0 and the first mutation advances it to 1', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-scaffold-revision-'));
  try {
    await initWorkspace(root);
    const change = await scaffold(root, 'Revision Zero', 'quick');
    assert.equal(change.revision, 0);
    const file = path.join(root, '.notchlet', 'changes', change.id, 'tasks.json');
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as Change).revision, 0);
    assert.equal((await readChange(root, change.id)).revision, 0);

    const mutated = await mutateChange(root, change.id, value => applyChangeUpdate(value, { intent: 'First mutation' }));
    assert.equal(mutated.revision, 1);

    const legacy = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    delete legacy.revision;
    await writeFile(file, JSON.stringify(legacy));
    assert.equal((await readChange(root, change.id)).revision ?? 0, 0);
    const advanced = await mutateChange(root, change.id, value => applyChangeUpdate(value, { outcome: 'Advance from a legacy file' }));
    assert.equal(advanced.revision, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('declarative plans project and import with one revision bump and resolved forward references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-plan-import-'));
  try {
    await initWorkspace(root);
    const plan = parseChangePlan({
      name: 'Plan Import', mode: 'quick', intent: 'Create a change from a plan.', outcome: 'Plan fields are authored in one import.',
      capabilityImpact: 'none', capabilityRationale: 'No capability contract is affected.',
      requirements: [{ id: 'REQ-1', title: 'Plan import', description: 'Import authored collections from JSON.' }],
      acceptanceScenarios: [{ id: 'SCN-1', requirementId: 'REQ-1', when: 'a plan is imported', then: 'the change is ready' }],
      checks: [{ id: 'CHK-1', description: 'Plan readiness', command: 'node --version', requirementIds: ['REQ-1'], taskIds: ['TASK-2'] }],
      tasks: [
        { id: 'TASK-2', title: 'Render artifacts', dependencies: ['TASK-1'], requirementIds: ['REQ-1'] },
        { id: 'TASK-1', title: 'Author metadata', requirementIds: ['REQ-1'] },
      ],
      artifactContents: { 'notes.md': '# Notes\n\nImported with the plan.\n' },
    });
    const projected = projectChangePlan('Plan Import', plan);
    assert.equal(projected.change.revision, 1);
    assert.deepEqual(projected.change.tasks.map(task => task.status), ['pending', 'pending']);
    assert.equal(projected.rendered[0].artifact, 'proposal.json');

    const scaffolded = await scaffold(root, 'Plan Import', 'quick');
    const imported = await importChangePlan(root, scaffolded.id, plan, { render: true });
    assert.equal(imported.change.revision, 1);
    assert.equal(imported.change.contentRevision, 1);
    assert.deepEqual(imported.change.requirements.map(item => item.id), ['REQ-1']);
    assert.deepEqual(imported.change.tasks.map(item => item.id), ['TASK-2', 'TASK-1']);
    assert.deepEqual(imported.written.sort(), ['notes.md', 'proposal.json']);
    assert.equal((await inspectChangeArtifacts(root, imported.change.id)).drifted, false);
    assert.equal(await readFile(path.join(root, '.notchlet', 'changes', imported.change.id, 'notes.md'), 'utf8'), '# Notes\n\nImported with the plan.\n');
    const projectedReadiness = readiness(imported.change, Object.fromEntries(projected.rendered.map(artifact => [artifact.path, artifact.content])));
    assert.equal(projectedReadiness.ready, true, projectedReadiness.blockers.map(blocker => blocker.code).join(', '));

    assert.throws(() => parseChangePlan({ intent: 'x', outcome: 'y', artifactContents: { 'tasks.json': '{}' } }), (error: unknown) => (error as { code?: string }).code === 'invalid_plan_artifact');
    assert.throws(() => projectChangePlan('Broken', parseChangePlan({ intent: 'x', outcome: 'y', scenarios: [] })), (error: unknown) => (error as { code?: string }).code === 'invalid_schema');
    assert.throws(() => projectChangePlan('Broken', parseChangePlan({ intent: 'x', outcome: 'y', checks: [{ id: 'CHK-1', description: 'Check', requirementIds: ['MISSING'] }] })), (error: unknown) => (error as { code?: string }).code === 'unknown_check_requirement');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('readiness finds dependency cycles and uncovered requirements', () => {
  const change: Change = { schemaVersion: 1, id: 'x', name: 'x', createdAt: '', mode: 'standard', intent: 'intent', outcome: 'outcome', requirements: [{ id: 'r1', title: 'Req', description: 'Desc' }], acceptanceScenarios: [], designDecisions: [], checks: [{ id: 'c1', description: 'Check' }], tasks: [{ id: 'a', title: 'A', status: 'pending', dependencies: ['b'], requirementIds: [] }, { id: 'b', title: 'B', status: 'pending', dependencies: ['a'], requirementIds: [] }], artifacts: { 'proposal.md': 'proposal.md', 'design.md': 'design.md' } };
  const codes = readiness(change).blockers.map(item => item.code);
  assert(codes.includes('dependency_cycle'));
  assert(codes.includes('uncovered_requirement'));
});

test('versioned v1 schemas accept valid fixtures and reject malformed metadata with stable recovery codes', async () => {
  const valid = parseChange(await readFile(path.join(fixtures, 'change-v1.json'), 'utf8'));
  assert.equal(valid.schemaVersion, 1);
  assert.deepEqual(valid.acceptanceScenarios, []);
  assert.deepEqual(valid.designDecisions, []);
  assert.equal(readiness(valid).ready, true, 'quick changes do not require standard-only scenarios or decisions');
  const legacy = JSON.parse(await readFile(path.join(fixtures, 'change-v1.json'), 'utf8')) as Record<string, unknown>;
  delete legacy.acceptanceScenarios;
  delete legacy.designDecisions;
  assert.deepEqual(parseChange(legacy).acceptanceScenarios, [], 'older v1 documents normalize missing fields to empty arrays');
  assert.equal(parseTask(JSON.parse(await readFile(path.join(fixtures, 'task-v1.json'), 'utf8'))).id, 'TASK-1');
  assert.equal(parseAcceptanceScenario(JSON.parse(await readFile(path.join(fixtures, 'acceptance-scenario-v1.json'), 'utf8'))).requirementId, 'REQ-1');
  assert.equal(parseDesignDecision(JSON.parse(await readFile(path.join(fixtures, 'design-decision-v1.json'), 'utf8'))).rationale.length > 0, true);
  const fixtureEvidence = parseEvidence(JSON.parse(await readFile(path.join(fixtures, 'evidence-v1.json'), 'utf8')));
  assert.equal(fixtureEvidence.schemaVersion, 1);
  assert.deepEqual(fixtureEvidence.checkIds, ['CHECK-1']);
  const legacyEvidence = { ...fixtureEvidence } as Record<string, unknown>;
  delete legacyEvidence.checkIds;
  assert.equal(parseEvidence(legacyEvidence).checkIds, undefined, 'legacy evidence without checkIds remains valid');
  for (const checkIds of [[''], ['CHECK-1', 'CHECK-1'], ['CHECK-1', 1], 'CHECK-1']) {
    assert.throws(() => parseEvidence({ ...fixtureEvidence, checkIds }), (error: unknown) => (error as { code?: string }).code === 'invalid_schema');
  }
  assert.equal(parseInstruction(JSON.parse(await readFile(path.join(fixtures, 'instruction-v1.json'), 'utf8'))).schemaVersion, 1);
  const envelope = parseCliJsonEnvelope(JSON.parse(await readFile(path.join(fixtures, 'cli-envelope-v1.json'), 'utf8')));
  assert.equal(envelope.protocolVersion, 1);

  const invalid = async (filename: string, expectedCode: string) => {
    await assert.rejects(readFile(path.join(fixtures, 'invalid', filename), 'utf8').then(parseChange), (error: unknown) => {
      assert.equal((error as { code?: string }).code, expectedCode);
      assert.match((error as { recovery: string }).recovery, /schema|JSON|version/i);
      return true;
    });
  };
  await invalid('change-unsupported-major.json', 'unsupported_version');
  await invalid('change-missing-required.json', 'invalid_schema');
  await invalid('change-malformed.json', 'malformed_json');
});

test('standard readiness requires requirement-linked scenarios and populated design decisions', async () => {
  const ready = parseChange(await readFile(path.join(fixtures, 'change-standard-ready-v1.json'), 'utf8'));
  assert.equal(readiness(ready).ready, true);
  const missingBaseline = { ...ready, baselineRevision: undefined, capabilityImpact: undefined, capabilityRationale: undefined };
  assert(readiness(missingBaseline).blockers.some(issue => issue.code === 'missing_baseline_revision'));
  assert(readiness(missingBaseline).blockers.some(issue => issue.code === 'missing_capability_delta'));
  for (const [filename, blocker] of [
    ['standard-empty-design-decisions.json', 'missing_design_decisions'],
    ['standard-missing-scenarios.json', 'missing_acceptance_scenarios'],
  ] as const) {
    const candidate = parseChange(await readFile(path.join(fixtures, 'invalid', filename), 'utf8'));
    const result = readiness(candidate);
    assert.equal(result.ready, false, filename);
    assert(result.blockers.some(issue => issue.code === blocker), filename);
  }
});

test('state evaluation is deterministic and exposes independent planning, execution, verification, closure, delivery, and eligibility facets', () => {
  const ready = parseChange({ schemaVersion: 1, id: 'ready', name: 'Ready', createdAt: new Date().toISOString(), mode: 'quick', intent: 'Implement behavior', outcome: 'Behavior works', capabilityImpact: 'none', capabilityRationale: 'No durable capability changed.', requirements: [{ id: 'r', title: 'Requirement', description: 'Required behavior' }], checks: [{ id: 'c', description: 'Run tests' }], tasks: [{ id: 'a', title: 'First', status: 'completed', dependencies: [], requirementIds: ['r'] }, { id: 'b', title: 'Second', status: 'pending', dependencies: ['a'], requirementIds: ['r'] }], artifacts: { 'proposal.md': 'proposal.md' } });
  const first = evaluateState(ready, { current: ['c'], missing: [], independentlyVerified: true });
  assert.deepEqual(evaluateState(ready, { current: ['c'], missing: [], independentlyVerified: true }), first);
  assert.equal(first.planning.status, 'ready');
  assert.equal(first.execution.status, 'pending');
  assert.equal(first.verification.status, 'current');
  assert.equal(first.localClosure.status, 'open');
  assert.equal(first.remoteDelivery.status, 'unknown');
  assert.deepEqual(first.eligibleTasks, ['b']);
  assert(first.blockers.every(item => item.source === 'engine'));
  assert.equal(evaluateState(ready, { failed: ['c'], missing: [] }).verification.status, 'failed');
  assert.equal(evaluateState(ready, { stale: ['c'], missing: [] }).verification.status, 'stale');
  assert.equal(evaluateState(ready, { unknown: ['c'], missing: [] }).verification.status, 'unknown');
  const unchecked = { ...ready, checks: [] };
  assert.equal(evaluateState(unchecked).verification.status, 'not_applicable');
  assert.equal(evaluateState(unchecked).localClosure.status, 'open');
  assert.deepEqual(evaluateState(ready, { unknown: ['c'], missing: [] }).verification.unknown, ['c']);
  assert.equal(evaluateState(ready).verification.status, 'missing');
  const blocked = parseChange({ ...ready, intent: '', tasks: ready.tasks.map(task => ({ ...task, status: 'pending' })) });
  assert.equal(evaluateState(blocked).planning.status, 'blocked');
  assert.deepEqual(evaluateState(blocked).eligibleTasks, ['a']);
  for (const action of ['plan', 'revise', 'implement', 'verify', 'resume'] as const) assert.match(instructions(ready, action), new RegExp(`\\(${action}\\)`));
  assert.match(instructions(ready, 'implement'), /dependency-eligible tasks \(b\)/);
  const runbook = instructions(ready, 'verify', {
    artifacts: [
      { artifact: 'proposal.md', path: 'proposal.md', role: 'rendered', status: 'drifted', drift: 'authored' },
      { artifact: 'spec.md', path: 'spec.md', role: 'rendered', status: 'current', drift: 'none' },
    ],
    verification: { missing: ['c'] },
  });
  assert.match(runbook, /## Intent\n\nImplement behavior/);
  assert.match(runbook, /- proposal\.md \[rendered\]: drifted \(proposal\.md\)/);
  assert.match(runbook, /`notchlet verify ready --check c --record`/);
  assert.match(runbook, /Evidence attention required for: c/);
  assert.match(runbook, /`notchlet change render ready --write`/);
  const notApplicableRunbook = instructions(unchecked, 'verify');
  assert.match(notApplicableRunbook, /Verification is not applicable until checks are declared/);
  const pendingReview = { ...ready, tasks: ready.tasks.map(task => ({ ...task, status: 'completed' as const })) };
  assert.equal(evaluateState(pendingReview).localClosure.status, 'pending_review');
  assert.equal(evaluateState(ready, { missing: [], remoteDelivery: { status: 'delivered', evidence: ['release-1'] } }).remoteDelivery.status, 'delivered');
});

test('capability contribution classifies no-impact, delta, and standard changes', () => {
  const base = { schemaVersion: 1 as const, id: 'x', name: 'x', createdAt: '', mode: 'quick' as const, intent: 'i', outcome: 'o', requirements: [], acceptanceScenarios: [], designDecisions: [], checks: [], tasks: [], artifacts: {} } satisfies Change;
  assert.equal(capabilityContribution({ ...base, capabilityImpact: 'none', capabilityRationale: 'Documentation-only maintenance.' }), 'none');
  assert.equal(capabilityContribution({ ...base, capabilityImpact: 'none' }), 'standard');
  assert.equal(capabilityContribution({ ...base, capabilityImpact: 'none', capabilityRationale: '   ' }), 'standard');
  assert.equal(capabilityContribution({ ...base, mode: 'standard', capabilityImpact: 'none', capabilityRationale: 'Documentation-only maintenance.' }), 'none');
  assert.equal(capabilityContribution({ ...base, capabilityImpact: 'delta', capabilityRationale: 'Adds behavior.' }), 'delta');
  assert.equal(capabilityContribution({ ...base, mode: 'standard' }), 'standard');
});

test('shared verification facets classify latest records across missing, failed, stale, unknown, and current', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-facets-'));
  try {
    await initWorkspace(root);
    const change = await scaffold(root, 'Facets', 'quick');
    const checks = ['c-current', 'c-failed', 'c-stale', 'c-unknown', 'c-missing', 'c-latest'].map(id => ({ id, description: `Run ${id}` }));
    const value: Change = {
      ...change, intent: 'Check facets', outcome: 'Facets classified consistently', revision: 1,
      requirements: [{ id: 'r1', title: 'Requirement', description: 'Desc' }],
      checks, tasks: [{ id: 't1', title: 'Task', status: 'completed', dependencies: [], requirementIds: ['r1'] }],
    };
    const file = path.join(root, '.notchlet', 'changes', change.id, 'tasks.json');
    await writeFile(file, JSON.stringify(value));
    const input = { kind: 'check' as const, requirementIds: ['r1'], taskIds: ['t1'], provenance: 'recorded' as const };
    await appendEvidence(root, change.id, { ...input, outcome: 'passed', summary: 'Old stale pass', checkIds: ['c-stale'] });
    const revised: Change = { ...value, requirements: [{ id: 'r1', title: 'Requirement', description: 'Changed description' }], revision: 2, contentRevision: 1 };
    await writeFile(file, JSON.stringify(revised));
    const unknownEvidence = await appendEvidence(root, change.id, { ...input, outcome: 'passed', summary: 'Recorded outside Git', checkIds: ['c-unknown'] });
    assert.equal((await import('./evidence.js').then(module => module.evaluateEvidenceFreshness(root, change.id, unknownEvidence))).status, 'fresh');

    spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await writeFile(path.join(root, '.gitignore'), '.notchlet/\n');
    await writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
    spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root });
    spawnSync('git', ['commit', '-m', 'baseline'], { cwd: root, encoding: 'utf8' });

    await appendEvidence(root, change.id, { ...input, outcome: 'passed', summary: 'Current pass', checkIds: ['c-current'] });
    await appendEvidence(root, change.id, { ...input, outcome: 'failed', summary: 'Failed check', checkIds: ['c-failed'] });
    await appendEvidence(root, change.id, { ...input, outcome: 'passed', summary: 'Older latest pass', checkIds: ['c-latest'] });
    await appendEvidence(root, change.id, { ...input, outcome: 'failed', summary: 'Newer latest failure', checkIds: ['c-latest'] });

    const evaluated: Change = revised;
    const facets = await evaluateVerificationFacets(root, change.id, evaluated);
    assert.deepEqual(facets.current, ['c-current']);
    assert.deepEqual(facets.failed, ['c-failed', 'c-latest']);
    assert.deepEqual(facets.stale, ['c-stale']);
    assert.deepEqual(facets.unknown, ['c-unknown']);
    assert.deepEqual(facets.missing, ['c-missing']);
    assert.equal(facets.checks.find(facet => facet.checkId === 'c-current')?.freshness?.basis, 'git');
    assert.equal(facets.checks.find(facet => facet.checkId === 'c-stale')?.freshness?.status, 'stale');
    assert.match(facets.checks.find(facet => facet.checkId === 'c-stale')?.freshness?.reasons.join(' ') ?? '', /Relevant change content/);
    assert.equal(facets.checks.find(facet => facet.checkId === 'c-unknown')?.freshness?.status, 'unknown');
    assert.equal(facets.records.length, 6);
    const state = evaluateState(evaluated, { ...facets, independentlyVerified: false });
    assert.equal(state.verification.status, 'failed');
    assert.equal(state.localClosure.status, 'pending_review');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('engine blockers distinguish readiness from human-review approval', async () => {
  const ready = parseChange(await readFile(path.join(fixtures, 'change-standard-ready-v1.json'), 'utf8'));
  const incomplete = parseChange(await readFile(path.join(fixtures, 'invalid', 'standard-empty-design-decisions.json'), 'utf8'));
  const blocked = parseChange({ ...ready, intent: '', tasks: ready.tasks.map(task => ({ ...task, status: 'pending' as const })) });
  const pendingReview = { ...ready, tasks: ready.tasks.map(task => ({ ...task, status: 'completed' as const })) };

  assert.ok(readiness(ready).ready);
  assert.equal(evaluateState(incomplete).planning.status, 'blocked');
  assert.ok(evaluateState(incomplete).blockers.some(issue => issue.code === 'missing_design_decisions'));
  assert.equal(evaluateState(blocked).planning.status, 'blocked');
  assert.deepEqual(evaluateState(blocked).eligibleTasks, ['TASK-1']);
  const reviewState = evaluateState(pendingReview);
  assert.equal(reviewState.execution.status, 'completed');
  assert.equal(reviewState.verification.status, 'missing');
  assert.equal(reviewState.localClosure.status, 'pending_review');
  assert.equal(reviewState.remoteDelivery.status, 'unknown');
  assert.equal('review' in reviewState, false);
});

test('standard empty scaffold design artifact is not ready', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-empty-design-'));
  try {
    await initWorkspace(root);
    const change = await scaffold(root, 'Empty Design', 'standard');
    const dir = path.join(root, '.notchlet', 'changes', change.id);
    const contents = Object.fromEntries(await Promise.all(Object.values(change.artifacts).map(async file => [file, await readFile(path.join(dir, file), 'utf8')])));
    assert(readiness(change, contents).blockers.some(issue => issue.code === 'empty_design'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependency transitions and concurrent expected-revision races are atomic', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-transition-race-'));
  try {
    const file = path.join(root, 'tasks.json');
    const data: Change = { schemaVersion: 1, id: 'race', name: 'Race', createdAt: new Date().toISOString(), mode: 'quick', intent: 'Test', outcome: 'Atomic', requirements: [], acceptanceScenarios: [], designDecisions: [], checks: [], tasks: [{ id: 'base', title: 'Base', status: 'pending', dependencies: [], requirementIds: [] }, { id: 'dependent', title: 'Dependent', status: 'pending', dependencies: ['base'], requirementIds: [] }, { id: 'other', title: 'Other', status: 'pending', dependencies: [], requirementIds: [] }], artifacts: {}, revision: 0 };
    await writeFile(file, JSON.stringify(data));
    await assert.rejects(transitionTask(file, 'dependent', 'in_progress', 0), (error: unknown) => (error as { code?: string }).code === 'dependencies_incomplete');
    const outcomes = await Promise.allSettled([transitionTask(file, 'base', 'in_progress', 0), transitionTask(file, 'other', 'in_progress', 0)]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as { code?: string }).code, 'revision_conflict');
    const saved = parseChange(await readFile(file, 'utf8'));
    assert.equal(saved.revision, 1);
    assert.equal(saved.tasks.filter(task => task.status === 'in_progress').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authoring mutations validate references, bump revisions, and preserve progress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-authoring-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Authoring Test', 'quick');
    let change = await mutateChange(root, initial.id, current => applyChangeUpdate(addRequirementToChange(current, { id: 'REQ-1', title: 'Notes CRUD', description: 'Create, read, update, and delete notes' }), { intent: 'Ship notes CRUD', outcome: 'All CRUD operations persist locally' }));
    assert.equal(change.revision, 1);
    assert.equal(change.intent, 'Ship notes CRUD');
    change = await mutateChange(root, initial.id, current => addCheckToChange(current, { id: 'CHK-1', description: 'CRUD API responds correctly', command: 'npm test' }));
    assert.equal(change.checks[0].command, 'npm test');
    change = await mutateChange(root, initial.id, current => addScenarioToChange(current, { id: 'SCN-1', requirementId: 'REQ-1', when: 'A note is submitted', then: 'It appears in the list' }));
    change = await mutateChange(root, initial.id, current => addTaskToChange(current, { id: 'TASK-1', title: 'Build API', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] }));
    assert.equal(change.revision, 4);
    await assert.rejects(mutateChange(root, initial.id, current => addRequirementToChange(current, { id: 'REQ-1', title: 'Duplicate', description: 'Duplicate' })), /already exists/);
    await assert.rejects(mutateChange(root, initial.id, current => addTaskToChange(current, { id: 'TASK-2', title: 'Bad ref', status: 'pending', dependencies: [], requirementIds: ['REQ-MISSING'] })), /unknown requirement/);
    await assert.rejects(removeChangeItem(root, initial.id, 'requirements', 'REQ-1'), /still referenced/);
    const read = await readChange(root, initial.id);
    assert.equal(read.revision, 4);
    assert.deepEqual(read.requirements.map(item => item.id), ['REQ-1']);
    assert.equal(read.checks[0].command, 'npm test');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('all published v1 schemas are valid JSON Schema documents', async () => {
  const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schemas');
  const files = await readdir(schemaDir);
  for (const filename of files.filter(name => name.endsWith('.schema.json'))) {
    const schema = JSON.parse(await readFile(path.join(schemaDir, filename), 'utf8')) as { $schema?: string; $id?: string; type?: string };
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', filename);
    assert.match(schema.$id ?? '', /-v1\.schema\.json$/, filename);
    assert.equal(schema.type, 'object', filename);
  }
  assert(files.length >= 6);
});

test('workspace discovery resolves nearest and explicit roots without initializing missing paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet nested root '));
  const nested = path.join(root, 'nested', 'deeper');
  try {
    await mkdir(nested, { recursive: true });
    assert.equal(await findWorkspace(nested), null);
    await initWorkspace(root);
    assert.equal(await findWorkspace(nested), root);
    await initWorkspace(path.join(root, 'nested'));
    assert.equal(await findWorkspace(nested), path.join(root, 'nested'));
    assert.equal(await findWorkspace(nested, root), root);
    assert.equal(await findWorkspace(nested, path.join(root, 'missing')), null);
    assert.equal(await findWorkspace(nested), path.join(root, 'nested'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('persisted schema conversion round-trips identities, metadata, progress, scenarios, decisions, and user artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet conversion '));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Preserve Work', 'quick');
    const directory = path.join(root, '.notchlet', 'changes', initial.id);
    const metadata: Change = {
      ...initial, intent: 'Preserve identity', outcome: 'Keep all metadata', revision: 7, capabilityImpact: 'none', capabilityRationale: 'Preserve existing behavior.', baselineRevision: 0,
      requirements: [{ id: 'REQ-X', title: 'Requirement', description: 'Must survive conversions' }],
      acceptanceScenarios: [{ id: 'SCENARIO-X', requirementId: 'REQ-X', when: 'When conversion runs', then: 'Then identity is retained' }],
      designDecisions: [{ id: 'DECISION-X', decision: 'Keep stable IDs', rationale: 'References must continue to resolve' }],
      checks: [{ id: 'CHECK-X', description: 'Verify content' }],
      tasks: [{ id: 'TASK-X', title: 'Done task', status: 'completed', dependencies: [], requirementIds: ['REQ-X'] }],
      artifacts: { ...initial.artifacts, 'notes.md': 'notes.md' },
    };
    await writeFile(path.join(directory, 'tasks.json'), JSON.stringify(metadata, null, 2));
    await writeFile(path.join(directory, 'notes.md'), 'user-authored content\n');
    await writeFile(path.join(directory, 'design.md'), 'user-authored design\n');
    const standard = await persistConversion(root, initial.id, 'standard');
    assert.equal(standard.mode, 'standard');
    assert.equal(standard.id, metadata.id);
    assert.equal(standard.name, metadata.name);
    assert.equal(standard.createdAt, metadata.createdAt);
    assert.equal(standard.intent, metadata.intent);
    assert.equal(standard.outcome, metadata.outcome);
    assert.equal(standard.revision, 7);
    assert.deepEqual(standard.tasks, metadata.tasks);
    assert.deepEqual(standard.requirements, metadata.requirements);
    assert.deepEqual(standard.acceptanceScenarios, metadata.acceptanceScenarios);
    assert.deepEqual(standard.designDecisions, metadata.designDecisions);
    assert.deepEqual(standard.checks, metadata.checks);
    assert.equal(standard.artifacts['notes.md'], 'notes.md');
    assert.equal(await readFile(path.join(directory, 'notes.md'), 'utf8'), 'user-authored content\n');
    assert.equal(await readFile(path.join(directory, 'design.md'), 'utf8'), 'user-authored design\n');
    assert.equal((await readChange(root, initial.id)).mode, 'standard');
    const quick = await persistConversion(root, initial.id, 'quick');
    assert.equal(quick.mode, 'quick');
    assert.deepEqual(quick.tasks, metadata.tasks);
    assert.deepEqual(quick.requirements, metadata.requirements);
    assert.deepEqual(quick.acceptanceScenarios, metadata.acceptanceScenarios);
    assert.deepEqual(quick.designDecisions, metadata.designDecisions);
    assert.deepEqual(quick.artifacts, standard.artifacts);
    assert.equal(await readFile(path.join(directory, 'notes.md'), 'utf8'), 'user-authored content\n');
    assert.equal(await readFile(path.join(directory, 'design.md'), 'utf8'), 'user-authored design\n');
    const listed = await listChanges(root);
    assert.equal(listed[0].ready, true);
    assert.equal(listed[0].completedTaskCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
