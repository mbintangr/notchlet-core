import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKLOG_SCHEMA_VERSION, emptyBacklogSidecar, parseBacklogSidecar, withBaselines, withLinkedItem, withObservedPlatform, withPlanning,
} from './backlog.js';

const now = '2026-01-01T00:00:00.000Z';

function v1() {
  return {
    schemaVersion: 1,
    node: { itemType: 'STORY', title: 'Login flow', slug: 'login-flow', origin: 'local' },
    platform: { productId: 'product-1', itemId: 2, key: 'NT-2', parentItemId: 1, remoteStatus: 'TODO', remoteUpdatedAt: now },
    sync: { state: 'linked', remoteChangeId: 'change-1', snapshotRevision: 1 },
    meta: { createdAt: now, updatedAt: now },
  };
}

const codeOf = (fn: () => unknown) => {
  try { fn(); return null; } catch (error) { return (error as { code?: string }).code; }
};

test('v1 sidecars read into the v2 shape without inventing planning data', () => {
  const parsed = parseBacklogSidecar(v1());
  assert.equal(parsed.schemaVersion, BACKLOG_SCHEMA_VERSION);
  assert.equal(parsed.planning, undefined);
  assert.equal(parsed.platform.remoteTitle, undefined);
  assert.equal(parsed.sync.lastPushedTitle, undefined);
  assert.equal(parsed.platform.key, 'NT-2');
  assert.equal(parsed.platform.parentItemId, 1);
  assert.equal(parsed.sync.state, 'linked');
});

test('new sidecars are written as version 2 with no optional blocks', () => {
  const sidecar = emptyBacklogSidecar({ itemType: 'EPIC', title: 'Auth', productId: 'p' });
  assert.equal(sidecar.schemaVersion, 2);
  assert.equal(sidecar.planning, undefined);
  assert.deepEqual(sidecar.sync, { state: 'unlinked' });
  assert.deepEqual(sidecar.platform, { productId: 'p' });
  assert.deepEqual(parseBacklogSidecar(sidecar), sidecar);
});

test('planning, observations, and baselines round-trip through v2', () => {
  const linked = withLinkedItem(emptyBacklogSidecar({ itemType: 'STORY', title: 'Login', productId: 'p' }), {
    productId: 'p', itemId: 5, key: 'NT-5', parentItemId: 1, remoteStatus: 'IN_PROGRESS', remoteUpdatedAt: now,
    remoteTitle: 'Login rev', remoteDescriptionSha256: 'a'.repeat(64), descriptionRevision: 3,
    priorityLevel: 'HIGH', storyPoints: 5, startDate: '2026-01-02T00:00:00.000Z', dueDate: '2026-01-09T00:00:00.000Z',
    remoteChangeId: 'change-5',
  });
  const planned = withBaselines(withPlanning(linked, { priorityLevel: 'HIGH', storyPoints: 5, startDate: '2026-01-02T00:00:00.000Z', dueDate: '2026-01-09T00:00:00.000Z', description: 'Authored' }), {
    lastPushedTitle: 'Login', lastPushedDescriptionSha256: 'b'.repeat(64), lastPushedPriorityLevel: 'HIGH', lastPushedStoryPoints: 5,
    lastPushedStartDate: '2026-01-02T00:00:00.000Z', lastPushedDueDate: '2026-01-09T00:00:00.000Z',
  });
  const parsed = parseBacklogSidecar(JSON.parse(JSON.stringify(planned)));
  assert.deepEqual(parsed, planned);
  assert.equal(parsed.planning?.description, 'Authored');
  assert.equal(parsed.platform.descriptionRevision, 3);
  assert.equal(parsed.sync.lastPushedStoryPoints, 5);

  const observed = withObservedPlatform(parsed, { remoteTitle: 'Login further', priorityLevel: 'LOW', storyPoints: 8, descriptionRevision: 4 });
  assert.equal(observed.platform.remoteTitle, 'Login further');
  assert.equal(observed.platform.priorityLevel, 'LOW');
  assert.equal(observed.planning?.priorityLevel, 'HIGH', 'observations never rewrite authored planning');
});

test('v1 rejects v2-only fields and keeps rejecting its own unknown keys', () => {
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), planning: {} })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), platform: { ...v1().platform, remoteTitle: 'x' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), extra: true })), 'invalid_schema');
  const v2 = { ...v1(), schemaVersion: 2 };
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v2, platform: { ...v2.platform, colour: 'red' } })), 'invalid_schema');
});

test('schema versions other than 1 and 2 fail as unsupported', () => {
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), schemaVersion: 3 })), 'unsupported_version');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), schemaVersion: '2' })), 'unsupported_version');
});

test('planning values are validated', () => {
  const base = { ...v1(), schemaVersion: 2 };
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, planning: { priorityLevel: 'CRITICAL' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, planning: { storyPoints: -1 } })), 'invalid_schema');
  assert.equal(parseBacklogSidecar({ ...base, planning: { storyPoints: 1.5 } }).planning?.storyPoints, 1.5);
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, planning: { startDate: 'not-a-date' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, planning: { description: 'x'.repeat(4001) } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, planning: { color: 'red' } })), 'invalid_schema');
  assert.equal(parseBacklogSidecar({ ...base, planning: { storyPoints: 0, priorityLevel: 'URGENT' } }).planning?.storyPoints, 0);
});

test('platform and sync observations are validated', () => {
  const base = { ...v1(), schemaVersion: 2 };
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, platform: { ...base.platform, remoteDescriptionSha256: 'XYZ' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, platform: { ...base.platform, descriptionRevision: -1 } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, platform: { ...base.platform, priorityLevel: 'NOW' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, platform: { ...base.platform, dueDate: 'soon' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, sync: { ...base.sync, lastPushedDescriptionSha256: 'xyz' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, sync: { ...base.sync, lastPushedStoryPoints: -2 } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...base, sync: { ...base.sync, lastPushedDueDate: 'later' } })), 'invalid_schema');
});

test('link invariants hold for both schema versions', () => {
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), platform: { itemId: 2 } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), sync: { state: 'unlinked' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), sync: { state: 'linked' }, platform: { productId: 'p' } })), 'invalid_schema');
  assert.equal(codeOf(() => parseBacklogSidecar({ ...v1(), platform: { ...v1().platform, key: 'nope' } })), 'invalid_schema');
  assert.equal(parseBacklogSidecar({ ...v1(), schemaVersion: 2, platform: { ...v1().platform, parentItemId: null } }).platform.parentItemId, null);
});
