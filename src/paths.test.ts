import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendEvidence, closeChange, initWorkspace, listArchivedChanges, listChanges, normalizeRelativePath, readArchivedChange, readChange, restoreChange,
  scanChangeDirectories, stableId, validateChange, workspaceRootForChangeFile, writeChangeArtifacts, type Change,
} from './index.js';
import { canParent, deriveLocalNodeStatus, emptyBacklogSidecar, mapLocalToRemoteStatus, parseBacklogSidecar, writeBacklogSidecar, readBacklogSidecar } from './backlog.js';

const QUICK_ARTIFACTS = { 'proposal.json': 'proposal.json', 'tasks.json': 'tasks.json' };
const evidence = (id: string) => ({ kind: 'check' as const, outcome: 'passed' as const, summary: `${id} passed`, requirementIds: [`REQ-${id}`], taskIds: [`TASK-${id}`], checkIds: [`CHECK-${id}`], provenance: 'recorded' as const });

function node(id: string, title: string): Change {
  return {
    schemaVersion: 1, id, name: title, createdAt: new Date().toISOString(), mode: 'quick',
    intent: 'Deliver the node', outcome: `${title} is complete`, capabilityImpact: 'none',
    capabilityRationale: 'Hierarchy plumbing with no durable behavior change.',
    requirements: [{ id: `REQ-${id}`, title, description: title }],
    acceptanceScenarios: [], designDecisions: [],
    checks: [{ id: `CHECK-${id}`, description: `Verify ${title}` }],
    tasks: [{ id: `TASK-${id}`, title, status: 'completed', dependencies: [], requirementIds: [`REQ-${id}`] }],
    artifacts: { ...QUICK_ARTIFACTS }, revision: 1,
  };
}

async function writeNode(root: string, relativePath: string, change: Change): Promise<string> {
  const directory = path.join(root, '.notchlet', 'changes', ...relativePath.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'tasks.json'), JSON.stringify(change, null, 2));
  await writeChangeArtifacts(root, relativePath);
  await appendEvidence(root, relativePath, evidence(change.id));
  return directory;
}

test('nested change locations resolve recursively by path and unique ID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-paths-'));
  try {
    await initWorkspace(root);
    const epic = stableId('epic');
    const story = stableId('story');
    await writeNode(root, `${epic}/${story}/task`, node('task-node', 'Task node'));
    await writeNode(root, `${epic}/${story}/other`, node('other-node', 'Other node'));

    const scanned = await scanChangeDirectories(root);
    assert.deepEqual(scanned.map(entry => entry.relativePath), [`${epic}/${story}/other`, `${epic}/${story}/task`]);
    assert.deepEqual((await listChanges(root)).map(summary => summary.relativePath), [`${epic}/${story}/other`, `${epic}/${story}/task`]);

    const byPath = await readChange(root, `${epic}/${story}/task`);
    assert.equal(byPath.id, 'task-node');
    assert.equal((await readChange(root, 'task-node')).name, 'Task node');

    await assert.rejects(readChange(root, `${epic}/${story}`), (error: unknown) => (error as { code?: string }).code === 'change_not_found');
    assert.equal(await workspaceRootForChangeFile(path.join(root, '.notchlet', 'changes', epic, story, 'task', 'tasks.json')), root);

    const weird = { ...node('dup-node', 'Duplicate'), artifacts: { ...QUICK_ARTIFACTS } };
    await writeNode(root, `${epic}/dup-a`, weird);
    await writeNode(root, `${epic}/dup-b`, weird);
    await assert.rejects(readChange(root, 'dup-node'), (error: unknown) => (error as { code?: string }).code === 'ambiguous_change');
    assert.equal((await readChange(root, `${epic}/dup-b`)).id, 'dup-node');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nested changes close into mirrored archive paths and restore back', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-nested-close-'));
  try {
    await initWorkspace(root);
    const relative = 'epic/story/task-node';
    const directory = await writeNode(root, relative, node('task-node', 'Task node'));
    const closed = await closeChange(root, relative);
    assert.equal(closed.archived, true);
    assert.equal(closed.manifestPath, `.notchlet/archive/${relative}/closure.json`);
    await assert.rejects(access(path.join(directory, 'tasks.json')));
    const archived = await readArchivedChange(root, relative);
    assert.equal(archived.id, 'task-node');
    assert.equal((await listArchivedChanges(root))[0].relativePath, relative);

    const restored = await restoreChange(root, relative);
    assert.equal(restored.id, 'task-node');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'tasks.json'), 'utf8')).id, 'task-node');
    await assert.rejects(access(path.join(root, '.notchlet', 'archive', ...relative.split('/'), 'tasks.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closing a parent merges with an already archived descendant instead of clobbering it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-archive-merge-'));
  try {
    await initWorkspace(root);
    const story = 'epic/story';
    await writeNode(root, `${story}/task-node`, node('task-node', 'Task node'));
    await writeNode(root, story, node('story-node', 'Story node'));
    await closeChange(root, `${story}/task-node`);
    await closeChange(root, story);
    await access(path.join(root, '.notchlet', 'archive', 'epic', 'story', 'tasks.json'));
    await access(path.join(root, '.notchlet', 'archive', 'epic', 'story', 'task-node', 'tasks.json'));
    assert.equal((await listArchivedChanges(root)).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rollup validation delegates leaf planning rules to closed children', () => {
  const parent: Change = { ...node('parent-node', 'Parent'), tasks: [], requirements: [{ id: 'REQ-1', title: 'Parent outcome', description: 'Parent outcome' }] };
  const issues = validateChange(parent, {}, [], { rollup: true });
  assert.equal(issues.some(issue => issue.code === 'missing_tasks'), false);
  assert.equal(issues.some(issue => issue.code === 'uncovered_requirement'), false);
  assert.equal(validateChange(parent).some(issue => issue.code === 'missing_tasks'), true);
  assert.equal(validateChange({ ...parent, checks: [] }, {}, [], { rollup: true }).some(issue => issue.code === 'missing_checks'), false);
  const bare = validateChange({ ...node('bare-rollup', 'Bare rollup'), tasks: [], requirements: [], checks: [] }, {}, [], { rollup: true });
  for (const code of ['missing_intent', 'missing_outcome', 'missing_requirements', 'missing_checks']) {
    assert.equal(bare.some(issue => issue.code === code), false, `${code} is delegated to children`);
  }
  assert.equal(validateChange({ ...node('leaf', 'Leaf'), tasks: [], requirements: [], checks: [] }).some(issue => issue.code === 'missing_checks'), true);
});

test('change paths enforce segment, depth, reserved-name, and length budgets', () => {
  const code = (reference: string) => {
    try { normalizeRelativePath(reference); return null; }
    catch (error) { return (error as { code?: string }).code; }
  };
  assert.equal(code('a/../b'), 'invalid_change_path');
  assert.equal(code('/absolute'), 'invalid_change_path');
  assert.equal(code('C:/drive'), 'invalid_change_path');
  assert.equal(code('a\\b'), null, 'backslashes normalize to separators');
  assert.equal(code('con'), 'invalid_change_path');
  assert.equal(code('a'.repeat(65)), 'invalid_change_path');
  assert.equal(code(Array.from({ length: 9 }, () => 'a').join('/')), 'path_budget_exceeded');
  assert.equal(code([ 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64) ].join('/')), 'path_budget_exceeded');
});

test('deeply nested work resolves and closes under a long workspace root', async () => {
  let root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-long-root-'));
  while (root.length < 110) { root = path.join(root, 'r'); await mkdir(root); }
  try {
    await initWorkspace(root);
    const relative = 'epic-node/story-node/task-node/subtask-node';
    await writeNode(root, relative, node('subtask-node', 'Subtask node'));
    assert.equal((await readChange(root, relative)).id, 'subtask-node');
    assert.equal((await listChanges(root))[0].relativePath, relative);
    const closed = await closeChange(root, relative);
    assert.equal(closed.manifestPath, `.notchlet/archive/${relative}/closure.json`);
    assert.equal((await listArchivedChanges(root))[0].relativePath, relative);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backlog sidecar round-trips and enforces link invariants', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notchlet-backlog-'));
  try {
    const directory = path.join(root, 'node');
    await mkdir(directory, { recursive: true });
    const sidecar = emptyBacklogSidecar({ itemType: 'STORY', title: 'User login', productId: 'product-1' });
    await writeBacklogSidecar(directory, sidecar);
    assert.deepEqual(await readBacklogSidecar(directory), sidecar);

    assert.equal(canParent('EPIC', 'STORY'), true);
    assert.equal(canParent('EPIC', 'TASK'), false);
    assert.equal(deriveLocalNodeStatus({ closed: false, ownTasks: [{ status: 'pending' }], children: [] }), 'open');
    assert.equal(deriveLocalNodeStatus({ closed: false, ownTasks: [], children: ['done', 'done'] }), 'in_review');
    assert.equal(mapLocalToRemoteStatus('in_review'), 'IN_REVIEW');

    const parsed = parseBacklogSidecar({
      ...sidecar,
      platform: { productId: 'product-1', itemId: 12, key: 'NA-12', parentItemId: 3, remoteStatus: 'TODO' },
      sync: { state: 'linked', remoteChangeId: 'develop-1' },
    });
    assert.equal(parsed.platform.key, 'NA-12');
    assert.throws(() => parseBacklogSidecar({ ...sidecar, platform: { itemId: 12 }, sync: { state: 'linked' } }), /productId is required/);
    assert.throws(() => parseBacklogSidecar({ ...sidecar, platform: { productId: 'p', itemId: 12 }, sync: { state: 'unlinked' } }), /must be absent/);
    assert.throws(() => parseBacklogSidecar({ ...sidecar, sync: { state: 'linked' } }), /itemId is required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
