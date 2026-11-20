import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CENTRE_HEAD_WELCOME_VOICES,
  DEFAULT_SIR_WELCOME_AUDIO,
  resolveWelcomeVoiceForUser,
} from './voiceWelcome';

test('resolveWelcomeVoiceForUser maps Nancy Mam, Nishu Mam, Ekram Sir, and Pankaj Sir to their exact audio clips', () => {
  const nancyByName = resolveWelcomeVoiceForUser({
    fullName: 'Nancy Gupta',
    email: 'nancy@visionpoint.edu',
    role: 'centre_head',
    centreId: 'vp_civillines',
  });
  assert.equal(nancyByName.key, 'nancy');
  assert.equal(nancyByName.audioUrl, CENTRE_HEAD_WELCOME_VOICES.nancy.audioUrl);

  const nancyByEmail = resolveWelcomeVoiceForUser({
    fullName: 'Centre Head Civil Lines',
    email: 'visionpointcivillines@gmail.com',
    role: 'centre_head',
    centreId: 'vp_civillines',
  });
  assert.equal(nancyByEmail.key, 'nancy');
  assert.equal(nancyByEmail.audioUrl, CENTRE_HEAD_WELCOME_VOICES.nancy.audioUrl);

  const nishu = resolveWelcomeVoiceForUser({
    fullName: 'Nishu Mam',
    email: 'nishu.head@gmail.com',
    role: 'centre_head',
    centreId: 'vp_lookerganj',
  });
  assert.equal(nishu.key, 'nishu');
  assert.equal(nishu.audioUrl, CENTRE_HEAD_WELCOME_VOICES.nishu.audioUrl);

  const ekram = resolveWelcomeVoiceForUser({
    fullName: 'Mohd Ekram',
    email: 'ekram@axis.edu',
    role: 'centre_head',
    centreId: 'xis_varanasi',
  });
  assert.equal(ekram.key, 'ekram');
  assert.equal(ekram.audioUrl, CENTRE_HEAD_WELCOME_VOICES.ekram.audioUrl);

  const ikramSpelling = resolveWelcomeVoiceForUser({
    fullName: 'Ikram Sir',
    email: 'ikram@axis.edu',
    role: 'centre_head',
    centreId: 'xis_varanasi',
  });
  assert.equal(ikramSpelling.key, 'ekram');
  assert.equal(ikramSpelling.audioUrl, CENTRE_HEAD_WELCOME_VOICES.ekram.audioUrl);

  const pankaj = resolveWelcomeVoiceForUser({
    fullName: 'Pankaj Sir',
    email: 'pankaj@axis.edu',
    role: 'centre_head',
    centreId: 'xis_jaunpur',
  });
  assert.equal(pankaj.key, 'pankaj');
  assert.equal(pankaj.audioUrl, CENTRE_HEAD_WELCOME_VOICES.pankaj.audioUrl);
});

test('resolveWelcomeVoiceForUser keeps default Ashish Sir greeting for Super Admin and other employees', () => {
  const admin = resolveWelcomeVoiceForUser({
    fullName: 'Ashish Pandey',
    email: 'niosvisionpoint9@gmail.com',
    role: 'super_admin',
    centreId: 'vp_lookerganj',
  });
  assert.equal(admin.key, 'default');
  assert.equal(admin.audioUrl, DEFAULT_SIR_WELCOME_AUDIO);

  const emp = resolveWelcomeVoiceForUser({
    fullName: 'Reena Patel',
    email: 'reena@visionpoint.edu',
    role: 'employee',
    centreId: 'vp_lookerganj',
  });
  assert.equal(emp.key, 'default');
  assert.equal(emp.audioUrl, DEFAULT_SIR_WELCOME_AUDIO);
});
