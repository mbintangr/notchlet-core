import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendEvidence, assertLeafAuthorable, buildChangeTree, buildNode, closeChange, initWorkspace, nextEligibleLeaf,
  readBacklogSidecar, scaffoldNode, writeChangeArtifacts, type Change,
} from './index.js';

const QUICK_ARTIFACTS = { 'proposal.json': 'proposal.json', 'tasks.json': 'tasks.json' };
const evidence = (id: string, withTask: boolean) => ({ kind: 'check' as const, outcome: 'passed' as const, summary: `${id} passed`, requirementIds: [`REQ-${id}`], taskIds: withTask ? [`TASK-${id}`] : [], checkIds: [`CHECK-${id}`], provenance: 'recorded' as const });

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
  await appendEvidence(root, relativePath, evidence(id, !parent));
}

test('scaffoldNode enforces hierarchy order and scaffolded nodes form a tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-tree-scaffold-'));
  try {
    await initWorkspace(root);
    const epic = await scaffoldNode(root, { name: 'User authentication', itemType: 'EPIC' });
    assert.equal(epic.relativePath, 'user-authentication');
    assert.equal(epic.change.id, 'user-authentication');
    assert.equal(epic.change.capabilityImpact, 'none');
    assert.equal((await readBacklogSidecar(epic.directory))?.node.itemType, 'EPIC');

    await assert.rejects(
      scaffoldNode(root, { name: 'Skipped level', itemType: 'TASK', parent: epic.relativePath }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_node_type',
    );

    const story = await scaffoldNode(root, { name: 'Login', itemType: 'STORY', parent: epic.relativePath });
    const sibling = await scaffoldNode(root, { name: 'Login', itemType: 'STORY', parent: epic.relativePath });
    assert.equal(story.relativePath, 'user-authentication/login');
    assert.equal(sibling.relativePath, 'user-authentication/login-2');

    const task = await scaffoldNode(root, { name: 'Login form', itemType: 'TASK', parent: story.relativePath });
    const subtask = await scaffoldNode(root, { name: 'Remember me', itemType: 'SUBTASK', parent: task.relativePath });
    assert.equal(subtask.relativePath, 'user-authentication/login/login-form/remember-me');

    const tree = await buildChangeTree(root);
    assert.equal(tree.counts.total, 5);
    assert.equal(tree.counts.leaves, 2);
    assert.equal(tree.roots.map(node => node.relativePath).join(','), 'user-authentication');
    const storyNode = tree.byPath.get(story.relativePath)!;
    assert.equal(storyNode.children.length, 1);
    assert.equal((await buildNode(root, 'login-form')).relativePath, task.relativePath);
    assert.equal(nextEligibleLeaf(storyNode)?.relativePath, subtask.relativePath);
    assert.throws(() => assertLeafAuthorable(storyNode), (error: unknown) => (error as { code?: string }).code === 'rollup_node');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parents close only after children and rollup closure skips own-task requirements', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-tree-close-'));
  try {
    await initWorkspace(root);
    const epic = await scaffoldNode(root, { name: 'Epic', itemType: 'EPIC' });
    const story = await scaffoldNode(root, { name: 'Story', itemType: 'STORY', parent: epic.relativePath });
    const task = await scaffoldNode(root, { name: 'Task', itemType: 'TASK', parent: story.relativePath });
    const subtask = await scaffoldNode(root, { name: 'Subtask', itemType: 'SUBTASK', parent: task.relativePath });

    await finishNode(root, subtask.relativePath, subtask.change.id, 'Subtask', false);
    await finishNode(root, task.relativePath, task.change.id, 'Task', true);
    await finishNode(root, story.relativePath, story.change.id, 'Story', true);
    await finishNode(root, epic.relativePath, epic.change.id, 'Epic', true);

    await assert.rejects(closeChange(root, epic.relativePath), (error: unknown) => (error as { code?: string }).code === 'closure_blocked' && /child_open/.test((error as Error).message));

    await closeChange(root, subtask.relativePath);
    let tree = await buildChangeTree(root);
    assert.equal(nextEligibleLeaf(tree.byPath.get(epic.relativePath)!)?.relativePath, task.relativePath);

    await closeChange(root, task.relativePath);
    tree = await buildChangeTree(root);
    assert.equal(nextEligibleLeaf(tree.byPath.get(epic.relativePath)!)?.relativePath, story.relativePath);
    await closeChange(root, story.relativePath);
    await closeChange(root, epic.relativePath);

    tree = await buildChangeTree(root);
    assert.deepEqual(tree.counts, { total: 4, open: 0, inProgress: 0, inReview: 0, done: 4, leaves: 1, archived: 4 });
    assert.equal(nextEligibleLeaf(tree), undefined);
    assert.equal(tree.warnings.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
