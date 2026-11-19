import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canDeleteStaffMember,
  canManageStaffMember,
  DELETE_SECURITY_PASSWORD,
  DELETE_WARNING_AUDIO,
  DELETE_WARNING_MESSAGE,
  verifyDeletePassword,
} from './deleteSecurity';

test('verifyDeletePassword enforces exact 177177 security password', () => {
  assert.equal(DELETE_SECURITY_PASSWORD, '177177');
  assert.equal(verifyDeletePassword('177177'), true);
  assert.equal(verifyDeletePassword(' 177177 '), true);
  assert.equal(verifyDeletePassword(''), false);
  assert.equal(verifyDeletePassword('177176'), false);
  assert.equal(verifyDeletePassword('123456'), false);
  assert.equal(verifyDeletePassword('000000'), false);
  assert.ok(DELETE_WARNING_AUDIO.endsWith('cartesia_2026-11-18T08_05_19Z_ASHISH-SSIR_sonic-3.6_hi-IN_speed-1.2_sr-24000_a29a8fa5.wav'));
  assert.ok(DELETE_WARNING_MESSAGE.includes('बिना पूछे ये सब क्यों डिलीट कर रहे हो'));
});

test('canDeleteStaffMember enforces strict role and centre boundaries', () => {
  const superAdmin = { uid: 'sa-1', role: 'super_admin' as const, centreId: 'vp_lookerganj' };
  const otherSuperAdmin = { uid: 'sa-2', role: 'super_admin' as const, centreId: 'vp_lookerganj' };
  const headLkg = { uid: 'ch-lkg', role: 'centre_head' as const, centreId: 'vp_lookerganj' };
  const headCln = { uid: 'ch-cln', role: 'centre_head' as const, centreId: 'vp_civillines' };
  const empLkg = { uid: 'emp-lkg', role: 'employee' as const, centreId: 'vp_lookerganj' };
  const empCln = { uid: 'emp-cln', role: 'employee' as const, centreId: 'vp_civillines' };

  // Super Admin can delete Centre Heads & Employees across all centres, but never self or another super_admin
  assert.equal(canDeleteStaffMember(superAdmin, superAdmin), false);
  assert.equal(canDeleteStaffMember(superAdmin, otherSuperAdmin), false);
  assert.equal(canDeleteStaffMember(superAdmin, headLkg), true);
  assert.equal(canDeleteStaffMember(superAdmin, headCln), true);
  assert.equal(canDeleteStaffMember(superAdmin, empLkg), true);
  assert.equal(canDeleteStaffMember(superAdmin, empCln), true);

  // Centre Head can delete Employees in their own centre only
  assert.equal(canDeleteStaffMember(headLkg, empLkg), true);
  assert.equal(canDeleteStaffMember(headLkg, empCln), false);
  assert.equal(canDeleteStaffMember(headLkg, headLkg), false);
  assert.equal(canDeleteStaffMember(headLkg, headCln), false);
  assert.equal(canDeleteStaffMember(headLkg, superAdmin), false);

  // Employees cannot manage or delete anyone
  assert.equal(canManageStaffMember(empLkg, empLkg), false);
  assert.equal(canDeleteStaffMember(empLkg, empLkg), false);
  assert.equal(canDeleteStaffMember(empLkg, empCln), false);
});
