import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateState, parseChange } from './index.js';

const now = '2026-01-01T00:00:00.000Z';

function emptyChange() {
  return parseChange({
    schemaVersion: 1,
    id: 'change-v10',
    name: 'V10 test change',
    createdAt: now,
    mode: 'quick',
    intent: 'Exercise V10 state',
    outcome: 'State reports one entry per problem',
    requirements: [],
    checks: [],
    tasks: [],
    artifacts: {},
  });
}

test('state blockers dedupe closure readiness copies by message while keeping closure-only issues', () => {
  const change = emptyChange();
  const planning = evaluateState(change).planning.blockers;
  assert.ok(planning.length > 0);
  const closure = {
    ready: false,
    blockers: [
      ...planning.map(blocker => ({ code: `readiness_${blocker.code}`, message: blocker.message, recovery: 'Fix planning.' })),
      { code: 'tasks_incomplete', message: 'All change tasks must be completed before local closure.', recovery: 'Complete tasks.' },
      { code: 'acceptance_missing', message: 'At least one required acceptance check must be declared and current.', recovery: 'Add checks.' },
    ],
  };
  const state = evaluateState(change, undefined, {}, closure);
  assert.equal(state.blockers.length, planning.length + 2);
  assert.equal(new Set(state.blockers.map(blocker => blocker.message)).size, state.blockers.length);
  assert.ok(state.blockers.some(blocker => blocker.code === 'tasks_incomplete'));
  assert.ok(state.blockers.some(blocker => blocker.code === 'acceptance_missing'));
  assert.equal(state.closure.blockerCount, closure.blockers.length);
});
