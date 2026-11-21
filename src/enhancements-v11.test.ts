import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  executionSha256,
  initWorkspace,
  inspectChangeArtifacts,
  inspectExecutionDrift,
  inspectPlan,
  mutateChange,
  parseChange,
  readChange,
  scaffold,
  type Change,
} from './index.js';

const now = '2026-01-01T00:00:00.000Z';

function baseChange(overrides: Partial<Record<string, unknown>> = {}): Change {
  return parseChange({
    schemaVersion: 1,
    id: 'change-v11',
    name: 'V11 test change',
    createdAt: now,
    mode: 'quick',
    intent: 'Exercise V11 provenance',
    outcome: 'V11 provenance is visible',
    requirements: [],
    checks: [],
    tasks: [],
    artifacts: {},
    ...overrides,
  });
}

async function changeFile(root: string, id: string): Promise<string> {
  return path.join(root, '.notchlet', 'changes', id, 'tasks.json');
}

test('execution metadata is fingerprinted on CLI writes and flags state-only edits without laundering them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-execution-v11-'));
  try {
    await initWorkspace(root);
    const created = await scaffold(root, 'Execution fingerprint', 'quick');
    assert.match(created.executionSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(inspectExecutionDrift(created).status, 'current');

    const updated = await mutateChange(root, created.id, current => ({
      ...current,
      runCommand: 'node server.mjs',
      readinessUrl: 'http://127.0.0.1:3000/health',
      readyTimeoutMs: 20000,
      environment: { PORT: '3000' },
    }));
    assert.equal(updated.revision, 1);
    assert.notEqual(updated.executionSha256, created.executionSha256);
    assert.equal(inspectExecutionDrift(updated).status, 'current');

    const file = await changeFile(root, created.id);
    const edited = JSON.parse(await readFile(file, 'utf8'));
    edited.runCommand = 'node -e "process.exit(0)"';
    edited.readinessUrl = 'http://127.0.0.1:4499/health';
    edited.environment = { PORT: '4499' };
    await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);

    const handEdited = await readChange(root, created.id);
    const drift = inspectExecutionDrift(handEdited);
    assert.equal(drift.status, 'drifted');
    assert.equal(drift.recordedSha256, updated.executionSha256);
    assert.equal(drift.currentSha256, executionSha256(handEdited));
    assert.notEqual(drift.recordedSha256, drift.currentSha256);

    const inspected = await inspectChangeArtifacts(root, created.id);
    assert.equal(inspected.drifted, false, 'metadata edits are not reported as authored artifact drift');
    assert.equal(inspected.executionDrift.status, 'drifted');

    const unrelated = await mutateChange(root, created.id, current => ({ ...current, intent: 'Updated intent only' }));
    assert.equal(unrelated.revision, 2);
    assert.equal(inspectExecutionDrift(unrelated).status, 'drifted', 'an unrelated CLI write does not silently accept the hand edit');

    const accepted = await mutateChange(root, created.id, current => ({
      ...current,
      runCommand: 'node -e "process.exit(0)"',
      readinessUrl: 'http://127.0.0.1:4499/health',
      environment: { PORT: '4499' },
    }), { refreshExecution: true });
    assert.equal(accepted.revision, 3);
    assert.equal(inspectExecutionDrift(accepted).status, 'current');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('execution fingerprint ignores environment ordering but tracks values', () => {
  const first = baseChange({ environment: { PORT: '3000', NODE_ENV: 'test' } });
  const reordered = baseChange({ environment: { NODE_ENV: 'test', PORT: '3000' } });
  const changed = baseChange({ environment: { PORT: '3001', NODE_ENV: 'test' } });
  assert.equal(executionSha256(first), executionSha256(reordered));
  assert.notEqual(executionSha256(first), executionSha256(changed));
});

test('plan inspection exposes the recorded hash alongside the current hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-plan-hash-v11-'));
  try {
    await mkdir(path.join(root, '.notchlet', 'plans'), { recursive: true });
    const planPath = '.notchlet/plans/feature.json';
    const text = JSON.stringify({ intent: 'Plan intent', outcome: 'Plan outcome' }, null, 2);
    await writeFile(path.join(root, planPath), text);
    const recorded = createHash('sha256').update(text).digest('hex');
    const change = baseChange({ sourcePlan: { path: planPath, sha256: recorded, importedAt: now } });

    const clean = await inspectPlan(root, change);
    assert.equal(clean.drift.status, 'none');
    assert.equal(clean.recordedSha256, recorded);
    assert.equal(clean.currentSha256, recorded);

    const changedText = `${text}\n`;
    await writeFile(path.join(root, planPath), changedText);
    const changed = await inspectPlan(root, change);
    assert.equal(changed.drift.status, 'drifted');
    assert.equal(changed.recordedSha256, recorded);
    assert.equal(changed.currentSha256, createHash('sha256').update(changedText).digest('hex'));
    assert.notEqual(changed.recordedSha256, changed.currentSha256);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
