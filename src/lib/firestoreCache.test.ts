import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CACHE_TTL_MS,
  expandMutatedCollections,
  isCacheEntryFresh,
} from './firestoreCache';

test('isCacheEntryFresh validates cache timestamps accurately within and beyond TTL', () => {
  const now = 1_700_000_000_000;
  assert.equal(isCacheEntryFresh(now - 5_000, CACHE_TTL_MS.BULK_DATA, now), true);
  assert.equal(isCacheEntryFresh(now - (CACHE_TTL_MS.BULK_DATA - 1), CACHE_TTL_MS.BULK_DATA, now), true);
  assert.equal(isCacheEntryFresh(now - CACHE_TTL_MS.BULK_DATA, CACHE_TTL_MS.BULK_DATA, now), false);
  assert.equal(isCacheEntryFresh(now - (CACHE_TTL_MS.BULK_DATA + 60_000), CACHE_TTL_MS.BULK_DATA, now), false);
  assert.equal(isCacheEntryFresh(null, CACHE_TTL_MS.STATIC, now), false);
  assert.equal(isCacheEntryFresh(0, CACHE_TTL_MS.STATIC, now), false);
});

test('expandMutatedCollections propagates invalidation across coupled institutional collections', () => {
  const studentExpanded = expandMutatedCollections(['students']);
  assert.ok(studentExpanded.includes('students'));
  assert.ok(studentExpanded.includes('fee_recovery'));
  assert.ok(studentExpanded.includes('practical_records'));
  assert.ok(studentExpanded.includes('tma_records'));
  assert.ok(studentExpanded.includes('online_class_records'));
  assert.ok(studentExpanded.includes('admission_records'));

  const taskExpanded = expandMutatedCollections(['work_assignment_tasks']);
  assert.ok(taskExpanded.includes('work_assignment_tasks'));
  assert.ok(taskExpanded.includes('work_assignments'));
  assert.ok(taskExpanded.includes('fee_recovery'));

  const feeOnly = expandMutatedCollections(['fee_recovery']);
  assert.deepEqual(feeOnly, ['fee_recovery']);
});
