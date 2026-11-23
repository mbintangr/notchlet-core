import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completeTasks, deriveState, evaluateState, initWorkspace, instructions, parseChange, persistChangeOperations, previewPlanReadiness, scaffold, seedCapabilityDeltaOperations, validateChangeStructure, type AcceptanceScenario, type Change, type Requirement } from './index.js';

const requirement: Requirement = { id: 'REQ-1', title: 'Behavior', description: 'Provide the behavior.' };
const scenario: AcceptanceScenario = { id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'It is used', then: 'It works.' };

function standardChange(initial: Change): Change {
  return {
    ...initial,
    mode: 'standard',
    intent: 'Add behavior',
    outcome: 'Behavior is available',
    capabilityImpact: 'delta',
    capabilityRationale: 'Adds one durable behavior.',
    requirements: [requirement],
    acceptanceScenarios: [scenario],
    designDecisions: [{ id: 'DECISION-1', decision: 'Add the behavior', rationale: 'It is required.' }],
    checks: [{ id: 'CHECK-1', description: 'Run acceptance', command: 'node --version', requirementIds: ['REQ-1'] }],
    tasks: [{ id: 'TASK-1', title: 'Implement', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] }],
    revision: 1,
  };
}

test('plan readiness preview separates post-import setup from unresolved blockers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-preflight-'));
  try {
    await initWorkspace(root);
    const change = standardChange(await scaffold(root, 'Preflight', 'standard'));
    const preview = previewPlanReadiness(change, {});
    assert.equal(preview.contribution, 'delta');
    assert(preview.readiness.blockers.some(blocker => blocker.code === 'missing_baseline_revision' || blocker.code === 'missing_capability_delta'));
    assert.deepEqual(preview.blockingNow, []);
    assert.deepEqual(preview.setup.map(step => step.code), ['design_content_required', 'baseline_capture_required', 'capability_delta_required', 'render_required']);
    assert.deepEqual(preview.remainingBlockers, []);
    assert.equal(preview.readyAfterSetup, true);
    assert.match(preview.setup.find(step => step.code === 'baseline_capture_required')!.command, /change baseline/);

    const seeded = seedCapabilityDeltaOperations(change, 'Accept the authored behavior.');
    assert.deepEqual(seeded.capabilityDelta?.operations[0].requirement, requirement);
    assert.deepEqual(seeded.capabilityDelta?.operations[0].scenarios, [scenario]);
    const afterSeed = previewPlanReadiness(seeded, {});
    assert.equal(afterSeed.setup.some(step => step.code === 'capability_delta_required'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('completeTasks honours dependency order, one revision bump, and end-of-change evidence policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-complete-all-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Batch tasks', 'quick');
    const change: Change = {
      ...initial,
      intent: 'Complete work',
      outcome: 'Work is complete',
      capabilityImpact: 'none',
      capabilityRationale: 'Documentation-only maintenance.',
      evidencePolicy: 'end-of-change',
      requirements: [requirement],
      checks: [{ id: 'CHECK-1', description: 'Manual acceptance', kind: 'manual' }],
      tasks: [
        { id: 'TASK-2', title: 'Second', status: 'pending', dependencies: ['TASK-1'], requirementIds: ['REQ-1'] },
        { id: 'TASK-1', title: 'First', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] },
      ],
      revision: 1,
    };
    const file = path.join(root, '.notchlet', 'changes', initial.id, 'tasks.json');
    await writeFile(file, JSON.stringify(change, null, 2));
    const result = await completeTasks(file, 1);
    assert.deepEqual(result.completed, ['TASK-1', 'TASK-2']);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.change.revision, 2);
    assert(result.change.tasks.every(task => task.status === 'completed'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('state evaluation merges closure blockers and archived instructions report closure facts', async () => {
  const change: Change = {
    schemaVersion: 1,
    id: 'sample',
    name: 'Sample',
    createdAt: new Date(0).toISOString(),
    mode: 'quick',
    intent: 'Do work',
    outcome: 'Work is done',
    requirements: [],
    acceptanceScenarios: [],
    designDecisions: [],
    checks: [],
    tasks: [],
    artifacts: {},
    revision: 1,
  };
  const state = evaluateState(change, { missing: [], failed: [], stale: [], unknown: [], current: [] }, {}, {
    ready: false,
    blockers: [{ code: 'acceptance_not_current', message: 'Acceptance is stale.', recovery: 'notchlet verify sample' }],
  });
  assert.equal(state.closure.evaluated, true);
  assert.equal(state.closure.ready, false);
  assert(state.blockers.some(blocker => blocker.code === 'acceptance_not_current'));

  const text = instructions(change, 'resume', {
    archived: { closedAt: '2026-01-01T00:00:00.000Z', contribution: 'delta', resultingRevision: 3, verificationStatus: 'current', manifestPath: '.notchlet/archive/sample/closure.json' },
  });
  assert.match(text, /archived review/);
  assert.match(text, /Capability contribution: delta/);
  assert.match(text, /Resulting capability revision: 3/);
  assert.match(text, /\.notchlet\/archive\/sample\/closure\.json/);

  const checkText = instructions({
    ...change,
    checks: [
      { id: 'CHECK-CMD', description: 'Command check', kind: 'command', command: 'npm test' },
      { id: 'CHECK-URL', description: 'Browser check', kind: 'browser', url: 'https://example.com/health', expectedStatus: 204 },
      { id: 'CHECK-MANUAL', description: 'Manual check', kind: 'manual' },
    ],
  }, 'implement');
  assert.match(checkText, /CHECK-CMD[\s\S]*Command: `npm test`/);
  assert.match(checkText, /CHECK-URL[\s\S]*URL: https:\/\/example\.com\/health \(expect HTTP 204\)/);
  assert.match(checkText, /CHECK-MANUAL[\s\S]*Manual check: record evidence/);
});

test('rollup instruction context reports parent readiness without leaf content', () => {
  const change: Change = {
    schemaVersion: 1,
    id: 'rollup-epic',
    name: 'Rollup epic',
    createdAt: new Date(0).toISOString(),
    mode: 'quick',
    capabilityImpact: 'none',
    capabilityRationale: 'Parent backlog item; children declare capability deltas.',
    intent: 'Coordinate the epic through its children.',
    outcome: 'The epic is complete when its child changes are closed.',
    requirements: [],
    acceptanceScenarios: [],
    designDecisions: [],
    checks: [],
    tasks: [],
    artifacts: { 'proposal.json': 'proposal.json' },
    revision: 1,
  };
  const leaf = instructions(change, 'resume');
  assert.match(leaf, /Planning blockers: missing_requirements, missing_checks, missing_tasks/);
  assert.match(leaf, /Planning readiness: blocked/);
  assert.match(deriveState(change), /Planning readiness: blocked/);

  const parent = instructions(change, 'resume', { rollup: true });
  assert.match(parent, /Planning blockers: none\./);
  assert.match(parent, /Planning readiness: ready/);
  assert.match(deriveState(change, { rollup: true }), /Planning readiness: ready/);
});

test('check kinds require their matching transport fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-check-kinds-'));
  try {
    await initWorkspace(root);
    const base = await scaffold(root, 'Check kinds', 'quick');
    const value = { ...base, checks: [
      { id: 'CHECK-CMD', description: 'Command', kind: 'command', command: 'node --version' },
      { id: 'CHECK-BROWSER', description: 'Browser', kind: 'browser', url: 'https://example.com', expectedStatus: 200 },
      { id: 'CHECK-MANUAL', description: 'Manual', kind: 'manual' },
    ] };
    const parsed = parseChange(value);
    assert.equal(parsed.checks[1].url, 'https://example.com');
    const invalidUrl = validateChangeStructure(parseChange({ ...value, checks: [{ id: 'CHECK-BAD', description: 'Bad', kind: 'browser', url: 'ftp://example.com' }] }));
    assert(invalidUrl.some(issue => issue.code === 'invalid_check_url'));
    const missingCommand = validateChangeStructure(parseChange({ ...value, checks: [{ id: 'CHECK-BAD', description: 'Bad', kind: 'command' }] }));
    assert(missingCommand.some(issue => issue.code === 'check_command_missing'));
    assert.throws(() => parseChange({ ...value, checks: [{ id: 'CHECK-BAD', description: 'Bad', kind: 'browser', url: 'https://example.com', expectedStatus: 99 }] }), /expectedStatus/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('batch operations disambiguate item kind from browser check kind', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-batch-check-kind-'));
  try {
    await initWorkspace(root);
    const base = await scaffold(root, 'Batch check kind', 'quick');
    const result = await persistChangeOperations(root, base.id, [
      { op: 'add', kind: 'check', item: { id: 'CHECK-B', description: 'Browser', kind: 'browser', url: 'https://example.com', expectedStatus: 204 } },
      { op: 'update', kind: 'check', id: 'CHECK-B', patch: { expectedStatus: 200 } },
    ]);
    assert.equal(result.change.checks[0].kind, 'browser');
    assert.equal(result.change.checks[0].expectedStatus, 200);
    assert.equal(result.change.revision, 1);
    assert.equal((JSON.parse(await readFile(path.join(root, '.notchlet', 'changes', base.id, 'tasks.json'), 'utf8')) as Change).checks[0].url, 'https://example.com');
  } finally { await rm(root, { recursive: true, force: true }); }
});
