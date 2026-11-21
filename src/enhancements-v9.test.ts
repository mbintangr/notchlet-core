import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendEvidence,
  classifyArtifactDrift,
  closeChange,
  completeTasks,
  contractSha256,
  initWorkspace,
  inspectChangeArtifacts,
  inspectPlan,
  mutateChange,
  parseChange,
  readChange,
  renderChangeArtifacts,
  scaffold,
  transitionTask,
  writeChangeArtifacts,
  type Change,
  type EvidencePolicy,
} from './index.js';

const now = '2026-01-01T00:00:00.000Z';

function baseChange(overrides: Partial<Record<string, unknown>> = {}): Change {
  return parseChange({
    schemaVersion: 1,
    id: 'change-v9',
    name: 'V9 test change',
    createdAt: now,
    mode: 'quick',
    intent: 'Exercise V9 fields',
    outcome: 'V9 fields behave',
    requirements: [],
    checks: [],
    tasks: [],
    artifacts: {},
    ...overrides,
  });
}

function structuredChange(overrides: Partial<Record<string, unknown>> = {}): Change {
  return baseChange({
    requirements: [
      { id: 'REQ-2', title: 'Second', description: 'Second behavior.' },
      { id: 'REQ-1', title: 'First', description: 'First behavior.' },
    ],
    acceptanceScenarios: [{ id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'Contract runs', then: 'Structure compares.' }],
    tasks: [
      { id: 'TASK-2', title: 'Follow-up', status: 'pending', dependencies: [], requirementIds: ['REQ-2'] },
      { id: 'TASK-1', title: 'Initial', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] },
    ],
    checks: [{
      id: 'CHECK-HTTP',
      description: 'Health route responds',
      kind: 'http',
      url: 'http://127.0.0.1:4331/app',
      expectedStatus: 200,
      expectedJson: { status: 'ok' },
      requirementIds: ['REQ-1'],
      scenarioIds: ['SCENARIO-1'],
      taskIds: ['TASK-1'],
    }],
    environment: { SERVICE_TOKEN: 'alpha-secret' },
    runCommand: 'node server.mjs --port 4331',
    coveragePolicy: 'advisory',
    ...overrides,
  });
}

async function seededChange(root: string, name: string, options: { tasksView?: boolean; policy?: EvidencePolicy } = {}): Promise<Change> {
  const scaffolded = await scaffold(root, name, 'quick');
  const next = await mutateChange(root, scaffolded.id, current => ({
    ...current,
    intent: 'Exercise V9 lifecycle',
    outcome: 'Lifecycle behavior holds',
    capabilityImpact: 'none',
    capabilityRationale: 'No durable capability change.',
    ...(options.policy === undefined ? {} : { evidencePolicy: options.policy }),
    requirements: [{ id: 'REQ-1', title: 'Requirement', description: 'Behavior remains.' }],
    acceptanceScenarios: [{ id: 'SCENARIO-1', requirementId: 'REQ-1', when: 'Verification runs', then: 'Evidence is current.' }],
    checks: [{ id: 'CHECK-1', description: 'Manual review', requirementIds: ['REQ-1'], scenarioIds: ['SCENARIO-1'] }],
    tasks: [{ id: 'TASK-1', title: 'Do work', status: 'pending', dependencies: [], requirementIds: ['REQ-1'] }],
    artifacts: options.tasksView ? { ...current.artifacts, 'tasks.md': 'tasks.md' } : current.artifacts,
  }));
  await writeChangeArtifacts(root, next.id);
  return readChange(root, next.id);
}

test('contractSha256 ignores prose, ports, and environment values but tracks contract structure', async () => {
  const baseline = structuredChange();
  const renamed = structuredChange({
    id: 'change-v9-other',
    name: 'Different name',
    createdAt: '2026-02-02T00:00:00.000Z',
    intent: 'Shortened intent',
    outcome: 'Reworded outcome',
    requirements: [
      { id: 'REQ-2', title: 'Changed second', description: 'Reworded second behavior.' },
      { id: 'REQ-1', title: 'Changed first', description: 'Reworded first behavior.' },
    ],
    environment: { SERVICE_TOKEN: 'beta-secret' },
    runCommand: 'node server.mjs --port 5555',
    checks: [{
      id: 'CHECK-HTTP',
      description: 'Reworded health route',
      kind: 'http',
      url: 'http://127.0.0.1:5555/app',
      expectedStatus: 200,
      expectedJson: { status: 'ok' },
      requirementIds: ['REQ-1'],
      scenarioIds: ['SCENARIO-1'],
      taskIds: ['TASK-1'],
    }],
  });
  assert.equal(contractSha256(baseline), contractSha256(renamed));
  assert.notEqual(JSON.stringify(baseline), JSON.stringify(renamed));

  const changedUrl = structuredChange({ checks: [{ ...baseline.checks[0], url: 'http://127.0.0.1:4331/other' }] });
  const changedExpectation = structuredChange({ checks: [{ ...baseline.checks[0], expectedStatus: 201 }] });
  const changedDependency = structuredChange({ tasks: [{ ...baseline.tasks[0], dependencies: ['TASK-1'] }, baseline.tasks[1]] });
  const changedCoverage = structuredChange({ coveragePolicy: 'strict' });
  for (const [label, candidate] of Object.entries({ changedUrl, changedExpectation, changedDependency, changedCoverage })) {
    assert.notEqual(contractSha256(candidate), contractSha256(baseline), `${label} must change the structural contract hash`);
  }
  const changedTimeout = structuredChange({ readyTimeoutMs: 21000, readyIntervalMs: 50 });
  assert.equal(contractSha256(changedTimeout), contractSha256(baseline), 'readiness polling tuning is not behavioral contract');
  const changedEnvironmentKey = structuredChange({ environment: { SERVICE_TOKEN: 'alpha-secret', EXTRA_KEY: 'value' } });
  assert.notEqual(contractSha256(changedEnvironmentKey), contractSha256(baseline), 'environment key sets remain structural');

  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-contract-v9-'));
  try {
    await mkdir(path.join(root, '.notchlet', 'plans'), { recursive: true });
    const textA = JSON.stringify({ intent: 'Alpha prose', outcome: 'Same contract' }, null, 2);
    const textB = JSON.stringify({ intent: 'Beta prose', outcome: 'Same contract' }, null, 2);
    await writeFile(path.join(root, '.notchlet', 'plans', 'a.json'), textA);
    await writeFile(path.join(root, '.notchlet', 'plans', 'b.json'), textB);
    const linked = (planPath: string, text: string) => ({ ...baseline, sourcePlan: { path: planPath, sha256: createHash('sha256').update(text).digest('hex'), importedAt: now } });
    const planA = await inspectPlan(root, linked('.notchlet/plans/a.json', textA));
    const planB = await inspectPlan(root, linked('.notchlet/plans/b.json', textB));
    assert.equal(planA.currentSha256, createHash('sha256').update(textA).digest('hex'));
    assert.equal(planB.currentSha256, createHash('sha256').update(textB).digest('hex'));
    assert.notEqual(planA.currentSha256, planB.currentSha256);
    assert.equal(planA.contractSha256, planB.contractSha256);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('canonical drift ignores formatting but treats nested status changes as authored', () => {
  const change = baseChange({
    artifacts: { 'proposal.json': 'proposal.json' },
    checks: [{ id: 'CHECK-HTTP', description: 'Health route responds', kind: 'http', url: 'http://127.0.0.1:1/app', expectedJson: { status: 'ok' } }],
  });
  const rendered = renderChangeArtifacts(change)[0];
  const formatted = `${JSON.stringify(JSON.parse(rendered.content), null, 4)}\n`;
  assert.equal(classifyArtifactDrift(rendered, formatted), 'generated-state');
  const tampered = JSON.parse(rendered.content);
  tampered.checks[0].expectedJson.status = 'error';
  assert.equal(classifyArtifactDrift(rendered, JSON.stringify(tampered)), 'authored');
});

test('lifecycle-only artifact drift is classified and refreshed at close while authored drift still blocks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-refresh-v9-'));
  try {
    await initWorkspace(root);
    const seeded = await seededChange(root, 'Lifecycle refresh', { tasksView: true });
    const file = path.join(root, '.notchlet', 'changes', seeded.id, 'tasks.json');
    const clean = await inspectChangeArtifacts(root, seeded.id);
    assert.equal(clean.drifted, false);
    assert.ok(clean.artifacts.every(artifact => artifact.drift === 'none'), 'clean artifacts expose an explicit drift value');

    const started = await transitionTask(file, 'TASK-1', 'in_progress', seeded.revision ?? 0);
    await transitionTask(file, 'TASK-1', 'completed', started.revision ?? 0);

    const drifted = await inspectChangeArtifacts(root, seeded.id);
    const tasksView = drifted.artifacts.find(artifact => artifact.artifact === 'tasks.md');
    assert.equal(tasksView?.status, 'drifted');
    assert.equal(tasksView?.drift, 'generated-state');
    assert.equal(drifted.artifacts.find(artifact => artifact.artifact === 'proposal.json')?.status, 'current');

    await appendEvidence(root, seeded.id, {
      kind: 'check', outcome: 'passed', summary: 'Manual acceptance verified',
      requirementIds: ['REQ-1'], scenarioIds: ['SCENARIO-1'], taskIds: ['TASK-1'], checkIds: ['CHECK-1'], provenance: 'recorded',
    });
    const closed = await closeChange(root, seeded.id);
    assert.equal(closed.artifactRefresh, 'generated-state');
    const manifest = JSON.parse(await readFile(path.join(root, '.notchlet', 'archive', seeded.id, 'closure.json'), 'utf8'));
    assert.equal(manifest.artifactRefresh, 'generated-state');
    assert.equal(manifest.artifacts.find((artifact: { artifact: string }) => artifact.artifact === 'tasks.md')?.status, 'current');
    assert.match(manifest.plan.contractSha256, /^[a-f0-9]{64}$/);

    const authored = await seededChange(root, 'Authored drift', { tasksView: true });
    const authoredFile = path.join(root, '.notchlet', 'changes', authored.id, 'proposal.json');
    const proposal = JSON.parse(await readFile(authoredFile, 'utf8'));
    proposal.change.intent = 'Hand-edited intent that the model does not contain';
    await writeFile(authoredFile, `${JSON.stringify(proposal, null, 2)}\n`);
    const inspected = await inspectChangeArtifacts(root, authored.id);
    const proposalStatus = inspected.artifacts.find(artifact => artifact.artifact === 'proposal.json');
    assert.equal(proposalStatus?.status, 'drifted');
    assert.equal(proposalStatus?.drift, 'authored');
    await assert.rejects(
      () => closeChange(root, authored.id),
      (error: unknown) => {
        const failure = error as { code?: string; message?: string };
        assert.equal(failure.code, 'closure_blocked');
        assert.match(failure.message ?? '', /artifact_drifted/);
        return true;
      },
    );
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test('evidence policy warnings name per-task policy and disappear for end-of-change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-policy-v9-'));
  try {
    await initWorkspace(root);
    const perTask = await scaffold(root, 'Per task policy', 'quick');
    const perTaskFile = path.join(root, '.notchlet', 'changes', perTask.id, 'tasks.json');
    const perTaskNext = await mutateChange(root, perTask.id, current => ({
      ...current,
      tasks: [
        { id: 'TASK-1', title: 'First', status: 'pending', dependencies: [], requirementIds: [] },
        { id: 'TASK-2', title: 'Second', status: 'pending', dependencies: ['TASK-1'], requirementIds: [] },
      ],
    }));
    const defaultCompletion = await completeTasks(perTaskFile, perTaskNext.revision ?? 0);
    assert.equal(defaultCompletion.warnings.length, 2);
    for (const warning of defaultCompletion.warnings) {
      assert.equal(warning.policy, 'per-task');
      assert.match(warning.message, /per-task/);
      assert.match(warning.recovery, /--evidence-policy end-of-change/);
    }

    const endOfChange = await scaffold(root, 'End of change policy', 'quick');
    const endFile = path.join(root, '.notchlet', 'changes', endOfChange.id, 'tasks.json');
    const endNext = await mutateChange(root, endOfChange.id, current => ({
      ...current,
      evidencePolicy: 'end-of-change',
      tasks: [
        { id: 'TASK-1', title: 'First', status: 'pending', dependencies: [], requirementIds: [] },
        { id: 'TASK-2', title: 'Second', status: 'pending', dependencies: ['TASK-1'], requirementIds: [] },
      ],
    }));
    const quiet = await completeTasks(endFile, endNext.revision ?? 0);
    assert.deepEqual(quiet.warnings, []);
    assert.deepEqual(quiet.completed.sort(), ['TASK-1', 'TASK-2']);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
