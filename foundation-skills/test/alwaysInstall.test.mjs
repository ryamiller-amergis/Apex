import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALWAYS_INSTALL_SKILLS,
  ensureAlwaysInstallSkills,
  isAlwaysInstallSkill,
} from '../lib/alwaysInstall.mjs';

test('ALWAYS_INSTALL_SKILLS includes post-skill-bootstrap', () => {
  assert.ok(ALWAYS_INSTALL_SKILLS.includes('post-skill-bootstrap'));
});

test('ensureAlwaysInstallSkills appends missing companions', () => {
  assert.deepEqual(ensureAlwaysInstallSkills(['to-prd']), [
    'to-prd',
    'post-skill-bootstrap',
  ]);
});

test('ensureAlwaysInstallSkills does not duplicate', () => {
  assert.deepEqual(
    ensureAlwaysInstallSkills(['post-skill-bootstrap', 'to-prd']),
    ['post-skill-bootstrap', 'to-prd'],
  );
});

test('isAlwaysInstallSkill', () => {
  assert.equal(isAlwaysInstallSkill('post-skill-bootstrap'), true);
  assert.equal(isAlwaysInstallSkill('to-prd'), false);
});
