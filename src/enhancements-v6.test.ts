import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  coverageReport,
  importChangePlan,
  initWorkspace,
  inspectPlanDrift,
  parseChange,
  parseChangePlan,
  parseJsonPath,
  readChange,
  renderClosureMarkdown,
  resolveJsonPath,
  scaffold,
  validateChangeStructure,
  type Change,
  type ClosureManifest,
} from './index.js';
import type { ClosureEvidenceItem } from './closure.js';

const now = '2026-01-01T00:00:00.000Z';

function baseChange(overrides: Partial<Record<string, unknown>> = {}): Change {
  return parseChange({
    schemaVersion: 1,
    id: 'change-v6',
    name: 'V6 test change',
    createdAt: now,
    mode: 'quick',
    intent: 'Exercise V6 fields',
    outcome: 'V6 fields parse',
    requirements: [],
    checks: [],
    tasks: [],
    artifacts: {},
    ...overrides,
  });
}

test('JSON path grammar rejects malformed expressions and resolves indexed and length paths', () => {
  assert.deepEqual(parseJsonPath('$.items[0].sku'), [
    { type: 'key', key: 'items' },
    { type: 'index', index: 0 },
    { type: 'key', key: 'sku' },
  ]);
  assert.deepEqual(parseJsonPath('summary.count'), [{ type: 'key', key: 'summary' }, { type: 'key', key: 'count' }]);
  assert.deepEqual(parseJsonPath('$.items.length'), [{ type: 'key', key: 'items' }, { type: 'key', key: 'length' }]);

  assert.deepEqual(parseJsonPath('$'), []);
  for (const expression of ['', '$.items[]', '$.items[abc]', '$.items[0', '$..items', 'items.', '$[0]x']) {
    assert.throws(() => parseJsonPath(expression), /Invalid JSON path/i, `expected ${JSON.stringify(expression)} to be rejected`);
  }

  const document = { items: [{ sku: 'A-1' }, { sku: 'B-2' }], summary: { count: 2 }, empty: [] };
  assert.deepEqual(resolveJsonPath(document, '$.items[1].sku'), { found: true, value: 'B-2' });
  assert.deepEqual(resolveJsonPath(document, 'items.length'), { found: true, value: 2 });
  assert.deepEqual(resolveJsonPath(document, '$.empty.length'), { found: true, value: 0 });
  assert.deepEqual(resolveJsonPath(document, '$.items[9].sku'), { found: false });
  assert.deepEqual(resolveJsonPath(document, '$.items.length.deeper'), { found: false });
  assert.deepEqual(resolveJsonPath(document, 'summary.missing'), { found: false });
});

test('plan checks reject malformed JSON paths and accept length assertions', () => {
  const check = (jsonPath: string) => ({
    id: 'CHECK-PATH',
    description: 'Path assertion',
    kind: 'http',
    url: 'http://127.0.0.1:1/api',
    expectedJsonAt: [{ path: jsonPath, gte: 1 }],
  });
  assert.throws(
    () => parseChangePlan({ intent: 'i', outcome: 'o', checks: [check('$.items[]')] }),
    /dot\/bracket path/i,
  );
  const plan = parseChangePlan({ intent: 'i', outcome: 'o', checks: [check('items.length')] });
  assert.equal(plan.checks[0].expectedJsonAt?.[0].path, 'items.length');
});

test('UI-only fields require a ui kind and interaction steps validate their shape', () => {
  const uiFieldChange = baseChange({
    checks: [{ id: 'CHECK-UI', description: 'Hidden form', kind: 'http', url: 'http://127.0.0.1:1/', expectedVisibleSelectors: ['#save'] }],
  });
  const issues = validateChangeStructure(uiFieldChange);
  assert.equal(issues.some(issue => issue.code === 'check_ui_field_mismatch'), true, JSON.stringify(issues));

  const uiChange = baseChange({
    checks: [{
      id: 'CHECK-UI', description: 'Form flow', kind: 'ui', url: 'http://127.0.0.1:1/',
      expectedVisibleSelectors: ['#save'], expectedEnabledSelectors: ['#save'], expectedTitle: 'Form',
      expectedScopedText: [{ selector: '#result', contains: 'Saved' }],
      steps: [{ action: 'fill', selector: '#name', value: 'Widget' }, { action: 'click', selector: '#save' }, { action: 'settle', ms: 10 }],
      captureArtifacts: 'on-failure',
    }],
  });
  assert.equal(validateChangeStructure(uiChange).some(issue => issue.code === 'check_ui_field_mismatch'), false);

  assert.throws(() => baseChange({ checks: [{ id: 'C', description: 'D', kind: 'ui', url: 'http://127.0.0.1:1/', steps: [{ action: 'fill' }] }] }), /selector is required/i);
  assert.throws(() => baseChange({ checks: [{ id: 'C', description: 'D', kind: 'ui', url: 'http://127.0.0.1:1/', steps: [{ action: 'fill', selector: '#a' }] }] }), /value is required/i);
  assert.throws(() => baseChange({ checks: [{ id: 'C', description: 'D', kind: 'ui', url: 'http://127.0.0.1:1/', steps: [{ action: 'press', selector: '#a' }] }] }), /key is required/i);
  assert.throws(() => baseChange({ checks: [{ id: 'C', description: 'D', kind: 'ui', url: 'http://127.0.0.1:1/', steps: [{ action: 'settle' }] }] }), /ms is required/i);
  assert.throws(() => baseChange({ checks: [{ id: 'C', description: 'D', kind: 'ui', url: 'http://127.0.0.1:1/', steps: [{ action: 'jump' }] }] }), /action must be one of/i);
  assert.throws(() => baseChange({ checks: [{ id: 'C', description: 'D', kind: 'ui', url: 'http://127.0.0.1:1/', steps: Array.from({ length: 26 }, () => ({ action: 'settle', ms: 1 })) }] }), /at most 25 steps/i);
});

test('change parsing validates plan linkage and readiness expectations', () => {
  const linked = baseChange({
    readinessExpectedStatus: 204,
    readinessBodyContains: 'ready',
    sourcePlan: { path: '.notchlet/plans/feature.json', sha256: 'a'.repeat(64), importedAt: now },
  });
  assert.equal(linked.readinessExpectedStatus, 204);
  assert.equal(linked.readinessBodyContains, 'ready');
  assert.equal(linked.sourcePlan?.path, '.notchlet/plans/feature.json');

  assert.throws(() => baseChange({ readinessExpectedStatus: 99 }), /readinessExpectedStatus/i);
  assert.throws(() => baseChange({ sourcePlan: { path: 'plan.json', sha256: 'abc', importedAt: now } }), /sha256/i);
  assert.throws(() => baseChange({ sourcePlan: { path: 'plan.json', sha256: 'A'.repeat(64), importedAt: now } }), /sha256/i);
  assert.throws(() => baseChange({ sourcePlan: { path: path.join(os.tmpdir(), 'plan.json'), sha256: 'a'.repeat(64), importedAt: now } }), /source plan|path/i);
});

test('plan drift reports current, drifted, and missing sources from the recorded hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-drift-v6-'));
  try {
    await initWorkspace(root);
    await mkdir(path.join(root, '.notchlet', 'plans'), { recursive: true });
    const planPath = path.join(root, '.notchlet', 'plans', 'feature.json');
    const planText = JSON.stringify({ intent: 'Ship the feature', outcome: 'Feature works' }, null, 2);
    await writeFile(planPath, planText);
    const change = await scaffold(root, 'Drift change', 'quick');
    const imported = await importChangePlan(root, change.id, parseChangePlan(JSON.parse(planText)), {
      sourcePlan: { path: '.notchlet/plans/feature.json', sha256: createHash('sha256').update(planText).digest('hex'), importedAt: now },
    });
    const linked = await readChange(root, imported.change.id);
    assert.equal((await inspectPlanDrift(root, linked)).status, 'none');

    await writeFile(planPath, `${planText}\n`);
    const drifted = await inspectPlanDrift(root, linked);
    assert.equal(drifted.status, 'drifted');
    assert.match(drifted.reason ?? '', /changed since import/i);

    await rm(planPath);
    assert.equal((await inspectPlanDrift(root, linked)).status, 'missing');
    assert.equal((await inspectPlanDrift(root, baseChange())).status, 'unlinked');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('closure Markdown leads with current evidence and keeps multiline detail nested', () => {
  const change = baseChange();
  const item = (overrides: Partial<ClosureEvidenceItem>): ClosureEvidenceItem => ({
    evidenceId: 'EV-1',
    status: 'current',
    outcome: 'passed',
    summary: 'Summary',
    capturedAt: now,
    provenance: 'recorded',
    requirementIds: [],
    scenarioIds: [],
    taskIds: [],
    checkIds: [],
    attachments: [],
    ...overrides,
  });
  const manifest: ClosureManifest = {
    schemaVersion: 1,
    changeId: change.id,
    changeName: change.name,
    mode: change.mode,
    closedAt: now,
    revision: 1,
    contribution: 'standard',
    capability: { name: 'sample', baselineWritten: true, baselineRevision: 0, resultingRevision: 1, deltaOperations: 0 },
    verification: { status: 'current', basis: 'artifact', current: ['CHECK-1'], failed: [], stale: [], unknown: [], missing: [] },
    tasks: { total: 0, completed: 0, ids: [] },
    checks: { total: 1, ids: ['CHECK-1'] },
    requirements: { total: 0, ids: [] },
    scenarios: 0,
    coverage: coverageReport(change),
    artifacts: [],
    evidence: {
      records: 2,
      current: 1,
      superseded: 1,
      attachments: 1,
      items: [
        item({ evidenceId: 'EV-OLD', status: 'superseded', capturedAt: '2026-01-01T00:00:00.000Z', summary: 'Old run\nsuperseded detail' }),
        item({
          evidenceId: 'EV-NEW',
          status: 'current',
          capturedAt: '2026-01-02T00:00:00.000Z',
          summary: 'Fresh run\nfirst detail\n- bullet detail',
          attachments: [{ name: 'screen.png', path: 'evidence/screen.png', sha256: 'b'.repeat(64), bytes: 12, kind: 'screenshot' }],
        }),
      ],
      logs: [],
    },
    remoteDelivery: { status: 'not_configured' },
  };

  const markdown = renderClosureMarkdown(manifest);
  const currentIndex = markdown.indexOf('- EV-NEW [current]');
  const supersededIndex = markdown.indexOf('- EV-OLD [superseded]');
  assert.notEqual(currentIndex, -1);
  assert.notEqual(supersededIndex, -1);
  assert.ok(currentIndex < supersededIndex, 'current records should render before superseded records');
  assert.match(markdown, /\n  first detail\n/);
  assert.match(markdown, /\n  - bullet detail\n/);
  assert.match(markdown, /- Attachment screen\.png \[screenshot\]/);
});
