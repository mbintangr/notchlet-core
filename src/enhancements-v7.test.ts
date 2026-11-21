import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyChangeUpdate,
  importChangePlan,
  initWorkspace,
  inspectPlan,
  mutateChange,
  parseChange,
  parseChangePlan,
  presenceOnlyUiChecks,
  scaffold,
  setupAdvisory,
  type Change,
} from './index.js';

const now = '2026-01-01T00:00:00.000Z';

function baseChange(overrides: Partial<Record<string, unknown>> = {}): Change {
  return parseChange({
    schemaVersion: 1,
    id: 'change-v7',
    name: 'V7 test change',
    createdAt: now,
    mode: 'quick',
    intent: 'Exercise V7 fields',
    outcome: 'V7 fields behave',
    requirements: [],
    checks: [],
    tasks: [],
    artifacts: {},
    ...overrides,
  });
}

function plan(checks: unknown[] = [], overrides: Partial<Record<string, unknown>> = {}) {
  return parseChangePlan({
    schemaVersion: 1,
    name: 'V7 plan',
    intent: 'Exercise plan import',
    outcome: 'Plan imports losslessly',
    requirements: [],
    acceptanceScenarios: [],
    designDecisions: [],
    checks,
    tasks: [],
    artifactContents: {},
    ...overrides,
  });
}

function uiCheck(steps: unknown[], overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'CHECK-UI', description: 'UI flow', kind: 'ui', url: 'http://127.0.0.1:1/', ...overrides, steps };
}

test('step grammar preserves assertText selectors and rejects fields that do not apply to the action', () => {
  const parsed = plan([uiCheck([
    { action: 'assertText', selector: '#result', text: 'Saved Widget', timeoutMs: 500 },
    { action: 'waitForText', text: 'Ready' },
    { action: 'waitForText', selector: '#status', text: 'Ready' },
    { action: 'waitForVisible', selector: '#app' },
  ])]);
  assert.deepEqual(parsed.checks[0].steps?.[0], { action: 'assertText', text: 'Saved Widget', selector: '#result', timeoutMs: 500 });
  assert.deepEqual(parsed.checks[0].steps?.[1], { action: 'waitForText', text: 'Ready' });
  assert.deepEqual(parsed.checks[0].steps?.[2], { action: 'waitForText', text: 'Ready', selector: '#status' });
  assert.deepEqual(parsed.checks[0].steps?.[3], { action: 'waitForVisible', selector: '#app' });

  const reject = (steps: unknown[], message: RegExp) => assert.throws(
    () => plan([uiCheck(steps)]),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid_step_field');
      assert.match((error as Error).message, message);
      return true;
    },
  );
  reject([{ action: 'assertText', text: 'Saved', contains: 'Saved' }], /contains/);
  reject([{ action: 'assertText', text: 'Saved', value: 'Saved' }], /value/);
  reject([{ action: 'click', selector: '#save', value: 'Save' }], /value/);
  reject([{ action: 'waitFor', selector: '#app', ms: 50 }], /ms/);
  reject([{ action: 'settle', ms: 50, selector: '#app' }], /selector/);
  reject([{ action: 'assertUrl', contains: '/done', text: 'done' }], /text/);
  assert.throws(() => plan([uiCheck([{ action: 'waitForVisible' }])]), /selector is required/i);
});

test('import keeps scoped text steps and plan validation surfaces the step error', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-steps-v7-'));
  try {
    await initWorkspace(root);
    const change = await scaffold(root, 'Imported steps', 'quick');
    const imported = await importChangePlan(root, change.id, plan([uiCheck([{ action: 'assertText', selector: '#result', text: 'Saved Widget' }])]));
    assert.deepEqual(imported.change.checks[0].steps?.[0], { action: 'assertText', text: 'Saved Widget', selector: '#result' });
    assert.deepEqual(parseChange(JSON.parse(JSON.stringify(imported.change))).checks[0].steps?.[0], { action: 'assertText', text: 'Saved Widget', selector: '#result' });

    const invalid = { ...plan().checks, checks: [uiCheck([{ action: 'assertText', text: 'Saved', contains: 'Saved' }])] };
    assert.throws(() => parseChangePlan({ ...JSON.parse(JSON.stringify(invalid)) }), /invalid_step_field|contains/i);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('top-level updates preserve imported plan provenance', () => {
  const change = baseChange({ sourcePlan: { path: '.notchlet/plans/feature.json', sha256: 'a'.repeat(64), importedAt: now } });
  const updated = applyChangeUpdate(change, { intent: 'Updated intent', setupCommand: 'npm run seed' });
  assert.equal(updated.sourcePlan?.path, '.notchlet/plans/feature.json');
  assert.equal(updated.sourcePlan?.sha256, 'a'.repeat(64));
  assert.equal(updated.setupCommand, 'npm run seed');
});

test('plan inspection distinguishes current, drifted, invalid, and missing sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-inspect-v7-'));
  try {
    await initWorkspace(root);
    await mkdir(path.join(root, '.notchlet', 'plans'), { recursive: true });
    const planText = JSON.stringify({ intent: 'Ship the feature', outcome: 'Feature works' }, null, 2);
    await writeFile(path.join(root, '.notchlet', 'plans', 'feature.json'), planText);
    const change = await scaffold(root, 'Plan inspection', 'quick');
    const { createHash } = await import('node:crypto');
    const linked = await mutateChange(root, change.id, current => ({ ...current, sourcePlan: { path: '.notchlet/plans/feature.json', sha256: createHash('sha256').update(planText).digest('hex'), importedAt: now } }));
    const inspection = await inspectPlan(root, linked);
    assert.deepEqual({ drift: inspection.drift, validation: inspection.validation, currentSha256: inspection.currentSha256 }, { drift: { status: 'none', path: '.notchlet/plans/feature.json' }, validation: { status: 'ok' }, currentSha256: createHash('sha256').update(planText).digest('hex') });
    assert.match(inspection.contractSha256, /^[a-f0-9]{64}$/);

    const invalidText = '{"intent": 5}';
    await writeFile(path.join(root, '.notchlet', 'plans', 'feature.json'), invalidText);
    const invalid = await inspectPlan(root, linked);
    assert.equal(invalid.drift.status, 'drifted');
    assert.equal(invalid.validation.status, 'invalid');
    assert.match(invalid.validation.error ?? '', /intent/i);

    await rm(path.join(root, '.notchlet', 'plans', 'feature.json'));
    const missing = await inspectPlan(root, linked);
    assert.equal(missing.drift.status, 'missing');
    assert.equal(missing.validation.status, 'not_applicable');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('presence-only checks and mutating UI checks produce advisories', () => {
  const presence = baseChange({ checks: [{ id: 'CHECK-ONLY', description: 'Presence only', kind: 'ui', url: 'http://127.0.0.1:1/', expectedSelectors: ['#app'] }] });
  assert.deepEqual(presenceOnlyUiChecks(presence).map(check => check.id), ['CHECK-ONLY']);
  const stateful = baseChange({ checks: [{ id: 'CHECK-TEXT', description: 'Text', kind: 'ui', url: 'http://127.0.0.1:1/', expectedText: 'Ready' }] });
  assert.deepEqual(presenceOnlyUiChecks(stateful), []);

  const mutating = baseChange({ checks: [{ id: 'CHECK-FORM', description: 'Form', kind: 'ui', url: 'http://127.0.0.1:1/', steps: [{ action: 'fill', selector: '#name', value: 'Widget' }, { action: 'click', selector: '#save' }] }] });
  const advisory = setupAdvisory(mutating);
  assert.equal(advisory?.code, 'setup_missing_for_mutating_ui');
  assert.deepEqual(advisory?.checkIds, ['CHECK-FORM']);
  assert.match(advisory?.message ?? '', /save-setup/);
  assert.equal(setupAdvisory(baseChange({ setupCommand: 'npm run seed', checks: mutating.checks })), undefined);
});
