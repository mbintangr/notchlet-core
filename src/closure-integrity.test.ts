import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendEvidence, closeChange, initWorkspace, inspectClosureIntegrity, restoreChange, scaffoldNode, writeChangeArtifacts,
  type Change,
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

async function closedTree(prefix: string): Promise<{ root: string; epicPath: string; storyPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await initWorkspace(root);
  const epic = await scaffoldNode(root, { name: 'Epic', itemType: 'EPIC' });
  const story = await scaffoldNode(root, { name: 'Story', itemType: 'STORY', parent: epic.relativePath });
  await finishNode(root, story.relativePath, story.change.id, 'Story', false);
  await finishNode(root, epic.relativePath, epic.change.id, 'Epic', true);
  await closeChange(root, story.relativePath);
  await closeChange(root, epic.relativePath);
  return { root, epicPath: epic.relativePath, storyPath: story.relativePath };
}

test('restore refuses a child while its ancestor change node is still archived', async () => {
  const { root, epicPath, storyPath } = await closedTree('notchlet-closure-restore-');
  try {
    await assert.rejects(
      restoreChange(root, storyPath),
      (error: unknown) => (error as { code?: string }).code === 'parent_restore_required' && /change restore epic/.test((error as { recovery?: string }).recovery ?? ''),
    );
    await restoreChange(root, epicPath);
    const activeEpic = await inspectClosureIntegrity(root, epicPath);
    assert.equal(activeEpic.archived, false);
    assert.equal(activeEpic.authoritative, false);
    assert.equal(activeEpic.manifestPresent, true);
    assert.equal(activeEpic.valid, true);
    const activeStory = await inspectClosureIntegrity(root, storyPath);
    assert.equal(activeStory.archived, false);
    assert.equal(activeStory.valid, true);
    await assert.rejects(
      restoreChange(root, storyPath),
      (error: unknown) => (error as { code?: string }).code === 'change_not_found',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closure integrity detects tampered, missing, invalid, unrecorded, and absent manifests', async () => {
  const { root, epicPath, storyPath } = await closedTree('notchlet-closure-integrity-');
  try {
    const parentClosure = path.join(root, '.notchlet', 'archive', ...epicPath.split('/'), 'closure.json');
    const childClosure = path.join(root, '.notchlet', 'archive', ...storyPath.split('/'), 'closure.json');
    const childDirectory = path.join(root, '.notchlet', 'archive', ...storyPath.split('/'));
    const originalChild = await readFile(childClosure, 'utf8');
    const originalParent = await readFile(parentClosure, 'utf8');
    const parentManifest = JSON.parse(originalParent) as { rollup: { children: Array<{ relativePath: string; closureSha256: string }> } };
    const recorded = parentManifest.rollup.children.find(record => record.relativePath === storyPath)!;
    assert.equal(recorded.closureSha256, createHash('sha256').update(originalChild).digest('hex'));

    const clean = await inspectClosureIntegrity(root, epicPath);
    assert.equal(clean.valid, true);
    assert.equal(clean.authoritative, true);
    assert.equal(clean.checkedChildren, 1);
    assert.deepEqual(clean.issues, []);

    await writeFile(childClosure, `${originalChild}\n`);
    const tampered = await inspectClosureIntegrity(root, epicPath);
    assert.equal(tampered.valid, false);
    const mismatch = tampered.issues.find(issue => issue.code === 'child_closure_hash_mismatch');
    assert.ok(mismatch);
    assert.equal(mismatch.recordedSha256, recorded.closureSha256);
    assert.equal(mismatch.actualSha256, createHash('sha256').update(`${originalChild}\n`).digest('hex'));

    await writeFile(childClosure, originalChild);
    assert.equal((await inspectClosureIntegrity(root, epicPath)).valid, true);

    await rm(childClosure);
    const missing = await inspectClosureIntegrity(root, epicPath);
    assert.ok(missing.issues.some(issue => issue.code === 'child_closure_missing'));

    await writeFile(childClosure, '{not json');
    const invalid = await inspectClosureIntegrity(root, epicPath);
    assert.ok(invalid.issues.some(issue => issue.code === 'child_closure_invalid'));

    await writeFile(childClosure, originalChild);
    const unrecordedManifest = JSON.parse(originalParent) as Record<string, unknown>;
    delete unrecordedManifest.rollup;
    await writeFile(parentClosure, `${JSON.stringify(unrecordedManifest, null, 2)}\n`);
    const unrecorded = await inspectClosureIntegrity(root, epicPath);
    assert.ok(unrecorded.issues.some(issue => issue.code === 'child_closure_unrecorded'));

    await rm(parentClosure);
    const manifestMissing = await inspectClosureIntegrity(root, epicPath);
    assert.ok(manifestMissing.issues.some(issue => issue.code === 'closure_manifest_missing'));

    await writeFile(parentClosure, originalParent);
    await rm(childDirectory, { recursive: true, force: true });
    const childMissing = await inspectClosureIntegrity(root, epicPath);
    assert.ok(childMissing.issues.some(issue => issue.code === 'child_change_missing'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closure integrity reports an active child under an archived parent', async () => {
  const { root, epicPath, storyPath } = await closedTree('notchlet-closure-active-child-');
  try {
    const archivedChild = path.join(root, '.notchlet', 'archive', ...storyPath.split('/'));
    const activeChild = path.join(root, '.notchlet', 'changes', ...storyPath.split('/'));
    await mkdir(path.dirname(activeChild), { recursive: true });
    await rename(archivedChild, activeChild);

    const report = await inspectClosureIntegrity(root, epicPath);
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(issue => issue.code === 'child_not_archived'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
