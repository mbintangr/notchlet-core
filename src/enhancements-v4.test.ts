import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyChangeUpdate, coverageReport, initWorkspace, listSchemas, mutateChange, parseChange, previewCapabilityClose, readSchema, renderClosureMarkdown, resolveEvidenceScope, scaffold, validatePlanning, type Change } from './index.js';

const now = '2026-01-01T00:00:00.000Z';

function baseChange(overrides: Partial<Record<string, unknown>> = {}): Change {
  return parseChange({
    schemaVersion: 1,
    id: 'change-v4',
    name: 'V4 test change',
    createdAt: now,
    mode: 'quick',
    intent: 'Exercise V4 fields',
    outcome: 'V4 fields parse',
    requirements: [],
    checks: [],
    tasks: [],
    artifacts: {},
    ...overrides,
  });
}

test('change parsing accepts V4 reproducibility, coverage, and HTTP assertion fields', () => {
  const change = baseChange({
    runCommand: 'node server.js',
    environment: { API_MODE: 'test', STORE: 'sqlite' },
    setupCommand: 'npm run seed',
    teardownCommand: 'npm run clean',
    coveragePolicy: 'strict',
    checks: [{
      id: 'CHECK-1',
      description: 'Catalog responds',
      kind: 'http',
      url: 'http://127.0.0.1:3000/api/catalog',
      expectedStatus: 200,
      expectedJsonContains: { items: [{ sku: 'A-1' }] },
      expectedJsonAt: [{ path: '$.summary.total', gte: 1 }, { path: '$.status', matches: '^ok$' }],
      expectedHeaders: { 'content-type': 'application/json' },
      requirementIds: ['REQ-1'],
      scenarioIds: ['SCN-1'],
    }],
  });
  assert.deepEqual(change.environment, { API_MODE: 'test', STORE: 'sqlite' });
  assert.equal(change.setupCommand, 'npm run seed');
  assert.equal(change.teardownCommand, 'npm run clean');
  assert.equal(change.coveragePolicy, 'strict');
  assert.deepEqual(change.checks[0].scenarioIds, ['SCN-1']);
  assert.deepEqual(change.checks[0].expectedJsonAt, [{ path: '$.summary.total', gte: 1 }, { path: '$.status', matches: '^ok$' }]);
  assert.deepEqual(change.checks[0].expectedHeaders, { 'content-type': 'application/json' });

  assert.throws(() => baseChange({ environment: { '1BAD': 'x' } }), /environment/i);
  assert.throws(() => baseChange({ coveragePolicy: 'sometimes' }), /coveragePolicy/i);
  assert.throws(() => baseChange({ checks: [{ id: 'C', description: 'D', kind: 'http', url: 'http://x.test', expectedJsonAt: [{ path: '$..bad' }] }] }), /json/i);
  assert.throws(() => baseChange({ checks: [{ id: 'C', description: 'D', kind: 'http', url: 'http://x.test', expectedHeaders: { 'bad header': 'x' } }] }), /header/i);
});

test('checks accept rendered UI capture and assertion settings', () => {
  const change = baseChange({
    checks: [{
      id: 'UI-1',
      description: 'Hydrated catalog renders',
      kind: 'ui',
      url: 'http://127.0.0.1:3000/catalog',
      waitFor: '#catalog',
      settleMs: 400,
      expectedSelectors: ['#catalog', '.catalog-item'],
      expectedText: 'Catalog ready',
      expectedNoConsoleErrors: true,
      fullPage: true,
    }],
  });
  const check = change.checks[0];
  assert.equal(check.kind, 'ui');
  assert.equal(check.waitFor, '#catalog');
  assert.equal(check.settleMs, 400);
  assert.deepEqual(check.expectedSelectors, ['#catalog', '.catalog-item']);
  assert.equal(check.expectedText, 'Catalog ready');
  assert.equal(check.expectedNoConsoleErrors, true);
  assert.equal(check.fullPage, true);

  assert.throws(() => baseChange({ checks: [{ id: 'UI-2', description: 'Bad settle', kind: 'ui', url: 'http://x.test', settleMs: -1 }] }), /settleMs/i);
  assert.throws(() => baseChange({ checks: [{ id: 'UI-3', description: 'Bad selectors', kind: 'ui', url: 'http://x.test', expectedSelectors: [''] }] }), /selector/i);
});

test('coverage links tasks and current passing evidence and strict mode covers the task axis', () => {
  const change = baseChange({
    requirements: [
      { id: 'REQ-1', title: 'Catalog', description: 'Catalog opens.' },
      { id: 'REQ-2', title: 'Orders', description: 'Orders open.' },
    ],
    acceptanceScenarios: [
      { id: 'SCN-1', requirementId: 'REQ-1', when: 'catalog opens', then: 'items render' },
      { id: 'SCN-2', requirementId: 'REQ-2', when: 'orders open', then: 'orders render' },
    ],
    tasks: [
      { id: 'TASK-1', title: 'Build catalog', status: 'completed', dependencies: [], requirementIds: ['REQ-1'] },
      { id: 'TASK-2', title: 'Build orders', status: 'completed', dependencies: [], requirementIds: ['REQ-2'] },
    ],
    checks: [{ id: 'CHECK-1', description: 'Catalog task check', command: 'node -v', taskIds: ['TASK-1'] }],
    coveragePolicy: 'strict',
  });
  const indirect = coverageReport(change);
  assert.equal(indirect.complete, false);
  assert.deepEqual(indirect.requirements.uncovered, ['REQ-2']);
  assert.deepEqual(indirect.scenarios.uncovered, ['SCN-2']);
  assert.deepEqual(indirect.tasks.uncovered, ['TASK-2']);
  assert.equal(indirect.requirements.items.find(item => item.requirementId === 'REQ-1')?.direct, false);
  assert.deepEqual(indirect.requirements.items.find(item => item.requirementId === 'REQ-1')?.taskIds, ['TASK-1']);
  assert.deepEqual(indirect.unlinkedChecks, []);

  const strictCodes = validatePlanning(change).map(issue => issue.code);
  assert(strictCodes.includes('uncovered_check_requirement'));
  assert(strictCodes.includes('uncovered_check_scenario'));
  assert(strictCodes.includes('uncovered_check_task'));

  const evidence = [{ evidenceId: 'EV-1', requirementIds: ['REQ-2'], scenarioIds: ['SCN-2'], taskIds: ['TASK-2'] }];
  const covered = coverageReport(change, evidence);
  assert.equal(covered.complete, true);
  assert.deepEqual(covered.tasks.items.find(item => item.taskId === 'TASK-2')?.evidenceIds, ['EV-1']);
  const coveredCodes = validatePlanning(change, {}, evidence).map(issue => issue.code);
  assert.equal(coveredCodes.some(code => code.startsWith('uncovered_check_')), false);

  const advisory = coverageReport({ ...change, coveragePolicy: 'advisory' });
  assert.equal(advisory.complete, false);
  assert.equal(validatePlanning({ ...change, coveragePolicy: 'advisory' }).some(issue => issue.code === 'uncovered_check_task'), false);
});

test('coverage report links requirements and scenarios and strict planning blocks uncovered items', () => {
  const change = baseChange({
    requirements: [
      { id: 'REQ-1', title: 'Catalog', description: 'Catalog is available.' },
      { id: 'REQ-2', title: 'Orders', description: 'Orders are available.' },
    ],
    acceptanceScenarios: [
      { id: 'SCN-1', requirementId: 'REQ-1', when: 'catalog opens', then: 'items render' },
      { id: 'SCN-2', requirementId: 'REQ-2', when: 'order posts', then: 'order is stored' },
    ],
    checks: [
      { id: 'CHECK-1', description: 'Catalog', command: 'node -v', requirementIds: ['REQ-1'], scenarioIds: ['SCN-1'] },
      { id: 'CHECK-2', description: 'Unlinked command', command: 'node -v' },
    ],
    coveragePolicy: 'strict',
  });
  const report = coverageReport(change);
  assert.equal(report.policy, 'strict');
  assert.equal(report.complete, false);
  assert.deepEqual(report.requirements.uncovered, ['REQ-2']);
  assert.deepEqual(report.scenarios.uncovered, ['SCN-2']);
  assert.deepEqual(report.unlinkedChecks, ['CHECK-2']);
  assert.deepEqual(report.requirements.items.find(item => item.requirementId === 'REQ-1')?.checkIds, ['CHECK-1']);
  assert.equal(report.scenarios.items.find(item => item.scenarioId === 'SCN-2')?.covered, false);

  const codes = validatePlanning(change).map(issue => issue.code);
  assert(codes.includes('uncovered_check_requirement'));
  assert(codes.includes('uncovered_check_scenario'));

  const advisory = coverageReport({ ...change, coveragePolicy: 'advisory' });
  assert.equal(advisory.complete, false);
  assert.equal(validatePlanning({ ...change, coveragePolicy: 'advisory' }).some(issue => issue.code.startsWith('uncovered_check_')), false);
});

test('evidence scope derives scenario links and omits an empty scenario list', () => {
  const change = baseChange({
    requirements: [{ id: 'REQ-1', title: 'R', description: 'R.' }],
    acceptanceScenarios: [{ id: 'SCN-1', requirementId: 'REQ-1', when: 'w', then: 't' }],
    checks: [{ id: 'CHECK-1', description: 'C', command: 'node -v', requirementIds: ['REQ-1'], scenarioIds: ['SCN-1'] }],
    tasks: [{ id: 'TASK-1', title: 'T', status: 'completed', dependencies: [], requirementIds: ['REQ-1'] }],
  });
  const scope = resolveEvidenceScope(change, ['CHECK-1'], {});
  assert.deepEqual(scope.scenarioIds, ['SCN-1']);
  const plain = baseChange({
    requirements: [{ id: 'REQ-1', title: 'R', description: 'R.' }],
    checks: [{ id: 'CHECK-1', description: 'C', command: 'node -v', requirementIds: ['REQ-1'] }],
  });
  assert.equal('scenarioIds' in resolveEvidenceScope(plain, ['CHECK-1'], {}), false);
});

test('shipped schemas are listable and readable by short and versioned names', async () => {
  const schemas = await listSchemas();
  const names = schemas.map(schema => schema.name);
  for (const expected of ['change', 'plan.v1', 'closure.v1', 'proposal.v1', 'spec.v1', 'verify-result.v1']) assert(names.includes(expected), `${expected} is shipped`);
  const closure = await readSchema('closure');
  assert.equal(closure.name, 'closure.v1');
  assert.equal(closure.schema.$id, 'https://notchlet.dev/schemas/closure-v1.schema.json');
  const check = await readSchema('check.v1');
  assert.equal(check.file, 'check.v1.schema.json');
  await assert.rejects(readSchema('missing.v9'), /not shipped/i);
});

test('closure preview reports coverage and local remote-delivery vocabulary, and the rendered view carries both', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-v4-closure-'));
  try {
    await initWorkspace(root);
    const initial = await scaffold(root, 'Closure view', 'quick');
    const change = await mutateChange(root, initial.id, current => applyChangeUpdate(current, { capabilityImpact: 'none', capabilityRationale: 'No durable capability changes.' }));
    const preview = await previewCapabilityClose(root, change.id);
    assert.equal(preview.remoteDelivery.status, 'not_configured');
    assert.equal(preview.coverage.policy, 'advisory');
    assert.equal(preview.coverage.requirements.total, 0);

    const markdown = renderClosureMarkdown({
      schemaVersion: 1,
      changeId: change.id,
      changeName: change.name,
      mode: change.mode,
      closedAt: now,
      revision: 3,
      contribution: 'none',
      capability: { name: change.name, deltaOperations: 0, baselineWritten: false },
      verification: { status: 'current', basis: 'artifact', current: [], failed: [], stale: [], unknown: [], missing: [] },
      tasks: { total: 0, completed: 0, ids: [] },
      checks: { total: 0, ids: [] },
      requirements: { total: 0, ids: [] },
      scenarios: 0,
      coverage: preview.coverage,
      artifacts: [],
      evidence: { records: 0, current: 0, superseded: 0, attachments: 0, items: [], logs: [] },
      remoteDelivery: { status: 'not_configured' },
    });
    assert.match(markdown, /Coverage/);
    assert.match(markdown, /Requirements: 0\/0 covered/);
    assert.match(markdown, /Capability baseline: not written/);
    assert.match(markdown, /Remote delivery: not configured/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
