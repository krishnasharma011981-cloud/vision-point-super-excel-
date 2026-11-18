import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
