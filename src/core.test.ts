import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION, deriveState, evaluateState, findWorkspace, initWorkspace, instructions, listChanges, parseAcceptanceScenario, parseChange, parseCliJsonEnvelope, parseDesignDecision, parseEvidence, parseInstruction, parseTask, persistConversion, readChange, readiness, scaffold, stableId, transitionTask, validateChange, type Change } from './index.js';

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
    const next = await transitionTask(file, 'a', 'completed', 0);
    assert.equal(next.revision, 1);
    await assert.rejects(transitionTask(file, 'a', 'pending', 0), /Revision conflict/);
    assert.match(deriveState(next), /does not imply verification/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).tasks[0].status, 'completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scaffolds stable quick/standard change artifacts without overwriting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-scaffold-'));
  try {
    await initWorkspace(root);
    const change = await scaffold(root, 'A Useful Change', 'quick');
    assert.equal(change.id, 'a-useful-change');
    assert.deepEqual(Object.keys(change.artifacts).sort(), ['proposal.md', 'tasks.json']);
    assert.equal(readiness(change).ready, false);
    assert(readiness(change).blockers.some(issue => issue.code === 'missing_requirements'));
    await assert.rejects(scaffold(root, 'A Useful Change', 'standard'));
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
  assert.equal(evaluateState(ready).verification.status, 'missing');
  const blocked = parseChange({ ...ready, intent: '', tasks: ready.tasks.map(task => ({ ...task, status: 'pending' })) });
  assert.equal(evaluateState(blocked).planning.status, 'blocked');
  assert.deepEqual(evaluateState(blocked).eligibleTasks, ['a']);
  for (const action of ['plan', 'revise', 'implement', 'verify', 'resume'] as const) assert.match(instructions(ready, action), new RegExp(`\\(${action}\\)`));
  assert.match(instructions(ready, 'implement'), /dependency-eligible tasks \(b\)/);
  const pendingReview = { ...ready, tasks: ready.tasks.map(task => ({ ...task, status: 'completed' as const })) };
  assert.equal(evaluateState(pendingReview).localClosure.status, 'pending_review');
  assert.equal(evaluateState(ready, { missing: [], remoteDelivery: { status: 'delivered', evidence: ['release-1'] } }).remoteDelivery.status, 'delivered');
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
