import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendEvidence, closeChange, hiddenOnlySoleCheckAdvisory, importChangeTree, initWorkspace, inspectPlan, mutateChange,
  parseChange, parseChangeTreePlan, presenceOnlyUiChecks, previewCapabilityClose, projectChangeTreePlan, readChange,
  scaffoldNode, taskLinkAdvisory, validateChangeStructure, writeChangeArtifacts, type Change,
} from './index.js';

const now = '2026-01-01T00:00:00.000Z';

function baseChange(overrides: Partial<Record<string, unknown>> = {}): Change {
  return parseChange({
    schemaVersion: 1,
    id: 'change-v12',
    name: 'V12 test change',
    createdAt: now,
    mode: 'quick',
    intent: 'Exercise V12 authoring',
    outcome: 'V12 authoring is verifiable',
    requirements: [],
    checks: [],
    tasks: [],
    artifacts: {},
    ...overrides,
  });
}

function workflowCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

const QUICK_ARTIFACTS = { 'proposal.json': 'proposal.json', 'tasks.json': 'tasks.json' };

function completeChange(id: string, title: string, parent: boolean): Change {
  return {
    schemaVersion: 1, id, name: title, createdAt: new Date().toISOString(), mode: 'quick',
    intent: 'Deliver the node', outcome: `${title} is complete`, capabilityImpact: 'none',
    capabilityRationale: 'Hierarchy plumbing with no durable behavior change.',
    requirements: [{ id: `REQ-${id}`, title, description: title }],
    acceptanceScenarios: [], designDecisions: [],
    checks: [{ id: `CHECK-${id}`, description: `Verify ${title}` }],
    tasks: parent ? [] : [{ id: `TASK-${id}`, title, status: 'completed', dependencies: [], requirementIds: [`REQ-${id}`] }],
    artifacts: { ...QUICK_ARTIFACTS }, revision: 1,
  };
}

async function finishNode(root: string, relativePath: string, id: string, title: string, parent: boolean): Promise<void> {
  const directory = path.join(root, '.notchlet', 'changes', ...relativePath.split('/'));
  await writeFile(path.join(directory, 'tasks.json'), JSON.stringify(completeChange(id, title, parent), null, 2));
  await writeChangeArtifacts(root, relativePath);
  await appendEvidence(root, relativePath, { kind: 'check', outcome: 'passed', summary: `${id} passed`, requirementIds: [`REQ-${id}`], taskIds: parent ? [] : [`TASK-${id}`], checkIds: [`CHECK-${id}`], provenance: 'recorded' });
}

function treePlan(input: unknown) {
  return parseChangeTreePlan(input);
}

test('expectedAbsentSelectors round-trip, reject duplicates, and require UI assertions with a URL', () => {
  const parsed = baseChange({
    checks: [{ id: 'CHECK-ABSENT', description: 'Dialog stays closed', kind: 'ui', url: 'http://127.0.0.1:1/', expectedAbsentSelectors: ['#b', '#a'] }],
  });
  assert.deepEqual(parsed.checks[0].expectedAbsentSelectors, ['#b', '#a']);

  assert.throws(
    () => baseChange({ checks: [{ id: 'CHECK-DUP', description: 'Duplicate', expectedAbsentSelectors: ['#a', '#a'] }] }),
    (error: unknown) => workflowCode(error) === 'invalid_schema',
  );

  const missingUrl = baseChange({ checks: [{ id: 'CHECK-NO-URL', description: 'No URL', expectedAbsentSelectors: ['#a'] }] });
  assert.ok(validateChangeStructure(missingUrl).some(issue => issue.code === 'check_url_missing'));

  const commandCheck = baseChange({
    checks: [{ id: 'CHECK-COMMAND', description: 'Command with UI field', kind: 'command', command: 'true', expectedAbsentSelectors: ['#a'] }],
  });
  assert.ok(validateChangeStructure(commandCheck).some(issue => issue.code === 'check_ui_field_mismatch'));
});

test('absent selectors count as a state assertion and hidden-only advisories only flag sole negative checks', () => {
  const mixed = baseChange({
    checks: [{ id: 'CHECK-MIXED', description: 'Root visible, dialog absent', kind: 'ui', expectedSelectors: ['#root'], expectedAbsentSelectors: ['#dialog'] }],
  });
  assert.deepEqual(presenceOnlyUiChecks(mixed), []);
  assert.equal(hiddenOnlySoleCheckAdvisory(mixed), undefined);

  const hiddenOnly = baseChange({
    checks: [{ id: 'CHECK-HIDDEN', description: 'Dialog hidden', kind: 'ui', expectedHiddenSelectors: ['#dialog'] }],
  });
  const advisory = hiddenOnlySoleCheckAdvisory(hiddenOnly);
  assert.equal(advisory?.code, 'hidden_only_sole_check');
  assert.deepEqual(advisory?.checkIds, ['CHECK-HIDDEN']);

  const absentOnly = baseChange({
    checks: [{ id: 'CHECK-ABSENT', description: 'Dialog absent', kind: 'ui', expectedAbsentSelectors: ['#dialog'] }],
  });
  assert.equal(hiddenOnlySoleCheckAdvisory(absentOnly)?.code, 'hidden_only_sole_check');

  const twoChecks = baseChange({
    checks: [
      { id: 'CHECK-ABSENT', description: 'Dialog absent', kind: 'ui', expectedAbsentSelectors: ['#dialog'] },
      { id: 'CHECK-ROOT', description: 'Root visible', kind: 'ui', expectedVisibleSelectors: ['#root'] },
    ],
  });
  assert.equal(hiddenOnlySoleCheckAdvisory(twoChecks), undefined);

  const positiveStep = baseChange({
    checks: [{ id: 'CHECK-STEP', description: 'Wait then assert hidden', kind: 'ui', expectedHiddenSelectors: ['#dialog'], steps: [{ action: 'waitForVisible', selector: '#root' }] }],
  });
  assert.equal(hiddenOnlySoleCheckAdvisory(positiveStep), undefined);
});

test('taskLinkAdvisory flags unlinked checks and recovery names the task link pass', () => {
  const tasks = [{ id: 'TASK-1', title: 'Work', status: 'pending', dependencies: [], requirementIds: [] }];
  const unlinked = baseChange({
    tasks,
    checks: [{ id: 'CHECK-1', description: 'Verify work', command: 'true' }],
  });
  const advisory = taskLinkAdvisory(unlinked);
  assert.equal(advisory?.code, 'task_links_missing');
  assert.deepEqual(advisory?.checkIds, ['CHECK-1']);
  assert.deepEqual(advisory?.taskIds, ['TASK-1']);
  assert.match(advisory!.recovery, /--task TASK-1/);

  const linked = baseChange({
    tasks,
    checks: [{ id: 'CHECK-1', description: 'Verify work', command: 'true', taskIds: ['TASK-1'] }],
  });
  assert.equal(taskLinkAdvisory(linked), undefined);
  assert.equal(taskLinkAdvisory(baseChange({ checks: [{ id: 'CHECK-1', description: 'No tasks', command: 'true' }] })), undefined);
});

test('tree plans validate type order, sibling slugs, and unknown fields before any writes', () => {
  const valid = treePlan({
    schemaVersion: 1,
    tree: {
      itemType: 'epic', title: 'Delivery', children: [
        { itemType: 'story', name: 'Checkout', children: [{ itemType: 'task', title: 'Receipt', plan: { intent: 'Show receipt', outcome: 'Receipt is visible', capabilityImpact: 'none', capabilityRationale: 'No durable change.' } }] },
      ],
    },
  });
  assert.equal(valid.tree.title, 'Delivery');
  assert.equal(valid.tree.children[0].children[0].itemType, 'TASK');
  assert.equal(valid.tree.children[0].plan.mode, 'quick', 'nodes without a plan inherit a quick rollup plan');

  const projected = projectChangeTreePlan(valid);
  assert.equal(projected.relativePath, 'delivery');
  assert.equal(projected.children[0].relativePath, 'delivery/checkout');
  assert.equal(projected.children[0].children[0].relativePath, 'delivery/checkout/receipt');
  assert.equal(projected.children[0].children[0].change.id, 'receipt');

  assert.throws(
    () => treePlan({ tree: { itemType: 'epic', title: 'Skipped', children: [{ itemType: 'task', title: 'Too deep' }] } }),
    (error: unknown) => workflowCode(error) === 'child_type_invalid',
  );
  assert.throws(
    () => treePlan({ tree: { itemType: 'epic', title: 'Siblings', children: [{ itemType: 'story', title: 'Same' }, { itemType: 'story', title: 'Same' }] } }),
    (error: unknown) => workflowCode(error) === 'duplicate_plan_path',
  );
  assert.throws(
    () => treePlan({ tree: { itemType: 'epic', title: 'Typo', type: 'story' } }),
    (error: unknown) => workflowCode(error) === 'invalid_schema',
  );
  assert.throws(
    () => treePlan({ tree: { itemType: 'milestone', title: 'Unknown type' } }),
    (error: unknown) => workflowCode(error) === 'invalid_node_type',
  );
});

test('importChangeTree creates every node, reruns idempotently, and writes nothing when preflight conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-tree-plan-v12-'));
  try {
    await initWorkspace(root);
    const plan = treePlan({
      schemaVersion: 1,
      tree: {
        itemType: 'epic', title: 'Delivery', children: [
          { itemType: 'story', title: 'Checkout', children: [{ itemType: 'task', title: 'Receipt' }] },
        ],
      },
    });

    const first = await importChangeTree(root, plan, { render: false });
    assert.equal(first.root, 'delivery');
    assert.deepEqual(first.nodes.map(node => [node.relativePath, node.status]), [
      ['delivery', 'created'],
      ['delivery/checkout', 'created'],
      ['delivery/checkout/receipt', 'created'],
    ]);
    for (const relative of ['delivery', 'delivery/checkout', 'delivery/checkout/receipt']) {
      await access(path.join(root, '.notchlet', 'changes', ...relative.split('/'), 'tasks.json'));
    }
    const epic = await readChange(root, 'delivery');
    assert.equal(epic.intent, 'Coordinate Delivery: deliver this epic backlog node as one unit of work.');
    assert.equal(epic.capabilityImpact, 'none');

    const rerun = await importChangeTree(root, plan, { render: false });
    assert.deepEqual(rerun.nodes.map(node => node.status), ['reused', 'reused', 'reused']);

    const conflicting = treePlan({
      schemaVersion: 1,
      tree: {
        itemType: 'epic', title: 'Delivery', children: [
          { itemType: 'story', title: 'Checkout renamed', slug: 'checkout' },
          { itemType: 'story', title: 'Other story' },
        ],
      },
    });
    await assert.rejects(
      importChangeTree(root, conflicting, { render: false }),
      (error: unknown) => workflowCode(error) === 'plan_path_conflict',
    );
    await assert.rejects(access(path.join(root, '.notchlet', 'changes', 'delivery', 'other-story')), 'preflight conflict creates nothing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('importChangeTree rolls back already-created nodes when a later node fails to import', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-tree-rollback-v12-'));
  try {
    await initWorkspace(root);
    const plan = treePlan({
      tree: {
        itemType: 'epic', title: 'Rollback', children: [
          { itemType: 'story', title: 'Broken', plan: { intent: 'Break import', outcome: 'Import must fail', capabilityImpact: 'none', capabilityRationale: 'No durable change.', checks: [{ id: 'CHECK-BROKEN', description: 'HTTP check with a UI assertion', kind: 'http', url: 'http://127.0.0.1:1/', expectedVisibleSelectors: ['#root'] }] } },
        ],
      },
    });
    await assert.rejects(
      importChangeTree(root, plan, { render: false }),
      (error: unknown) => workflowCode(error) === 'check_ui_field_mismatch',
    );
    await assert.rejects(access(path.join(root, '.notchlet', 'changes', 'rollback', 'tasks.json')), 'created root is removed on failure');
    await assert.rejects(access(path.join(root, '.notchlet', 'changes', 'rollback', 'broken', 'tasks.json')), 'created child is removed on failure');

    const repaired = treePlan({ tree: { itemType: 'epic', title: 'Rollback', children: [{ itemType: 'story', title: 'Broken' }] } });
    const imported = await importChangeTree(root, repaired, { render: false });
    assert.deepEqual(imported.nodes.map(node => node.status), ['created', 'created'], 'a clean retry succeeds after rollback');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tree plan provenance validates as a tree and flags a removed node', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-tree-provenance-v12-'));
  try {
    await initWorkspace(root);
    const tree = { schemaVersion: 1, tree: { itemType: 'epic', title: 'Delivery', children: [{ itemType: 'story', title: 'Checkout' }] } };
    const text = JSON.stringify(tree, null, 2);
    const relative = 'plans/delivery-tree.json';
    await mkdir(path.join(root, 'plans'), { recursive: true });
    await writeFile(path.join(root, ...relative.split('/')), text);
    const sourcePlan = { path: relative, sha256: createHash('sha256').update(text).digest('hex'), importedAt: new Date().toISOString() };

    const imported = await importChangeTree(root, parseChangeTreePlan(tree), { render: false, sourcePlan });
    assert.deepEqual(imported.nodes.map(node => node.status), ['created', 'created']);
    for (const id of ['delivery', 'checkout']) {
      const inspection = await inspectPlan(root, await readChange(root, id));
      assert.equal(inspection.drift.status, 'none');
      assert.equal(inspection.validation.status, 'ok', `tree plan provenance validates for ${id}`);
    }

    await writeFile(path.join(root, ...relative.split('/')), JSON.stringify({ schemaVersion: 1, tree: { itemType: 'epic', title: 'Delivery' } }, null, 2));
    const removed = await inspectPlan(root, await readChange(root, 'checkout'));
    assert.equal(removed.drift.status, 'drifted');
    assert.equal(removed.validation.status, 'invalid');
    assert.match(removed.validation.error ?? '', /no longer contains a node/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rollup closure records descendant aggregates and warns when a rollup narrative is blank', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-rollup-v12-'));
  try {
    await initWorkspace(root);
    const epic = await scaffoldNode(root, { name: 'Epic', itemType: 'EPIC' });
    const story = await scaffoldNode(root, { name: 'Story', itemType: 'STORY', parent: epic.relativePath });
    const task = await scaffoldNode(root, { name: 'Task', itemType: 'TASK', parent: story.relativePath });
    const secondTask = await scaffoldNode(root, { name: 'Task two', itemType: 'TASK', parent: story.relativePath });

    const seeded = await previewCapabilityClose(root, epic.relativePath);
    assert.equal(seeded.narrative, undefined, 'scaffolded rollups carry a seeded narrative');

    await mutateChange(root, epic.relativePath, current => ({ ...current, intent: ' ', outcome: '' }));
    const blank = await previewCapabilityClose(root, epic.relativePath);
    assert.equal(blank.narrative?.status, 'blank');
    const restored = await mutateChange(root, epic.relativePath, current => ({ ...current, intent: 'Deliver the epic', outcome: 'Epic is complete' }));
    assert.equal(restored.intent, 'Deliver the epic');

    await finishNode(root, task.relativePath, task.change.id, 'Task', false);
    await finishNode(root, secondTask.relativePath, secondTask.change.id, 'Task two', false);
    await finishNode(root, story.relativePath, story.change.id, 'Story', true);
    await finishNode(root, epic.relativePath, epic.change.id, 'Epic', true);

    await closeChange(root, task.relativePath);
    await closeChange(root, secondTask.relativePath);
    await closeChange(root, story.relativePath, { renderMarkdown: true });
    const storyManifest = JSON.parse(await readFile(path.join(root, '.notchlet', 'archive', 'epic', 'story', 'closure.json'), 'utf8'));
    assert.deepEqual(storyManifest.rollup.descendants, { nodes: 2, leaves: 2, requirements: 2, checks: 2, currentEvidence: 2, tasks: { total: 2, completed: 2 } });
    assert.deepEqual(storyManifest.narrative, { intent: 'Deliver the node', outcome: 'Story is complete' });
    const storyMarkdown = await readFile(path.join(root, '.notchlet', 'archive', 'epic', 'story', 'closure.md'), 'utf8');
    assert.match(storyMarkdown, /Descendants: 2 nodes \(2 leaves\)/);
    assert.doesNotMatch(storyMarkdown, /leafleaves/);
    assert.match(storyMarkdown, /- Intent: Deliver the node/);
    assert.match(storyMarkdown, /- Outcome: Story is complete/);

    await closeChange(root, epic.relativePath, { renderMarkdown: true });
    const epicManifest = JSON.parse(await readFile(path.join(root, '.notchlet', 'archive', 'epic', 'closure.json'), 'utf8'));
    assert.deepEqual(epicManifest.rollup.descendants, { nodes: 3, leaves: 2, requirements: 3, checks: 3, currentEvidence: 3, tasks: { total: 2, completed: 2 } });
    assert.deepEqual(epicManifest.narrative, { intent: 'Deliver the node', outcome: 'Epic is complete' });
    const epicMarkdown = await readFile(path.join(root, '.notchlet', 'archive', 'epic', 'closure.md'), 'utf8');
    assert.match(epicMarkdown, /Descendants: 3 nodes \(2 leaves\)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
