import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALWAYS_INSTALL_SKILLS,
  ensureAlwaysInstallSkills,
  isAlwaysInstallSkill,
} from '../lib/alwaysInstall.mjs';

test('ALWAYS_INSTALL_SKILLS includes required release companions', () => {
  assert.deepEqual([...ALWAYS_INSTALL_SKILLS], [
    'post-skill-bootstrap',
    'update-changelog',
  ]);
});

test('ensureAlwaysInstallSkills appends missing companions', () => {
  assert.deepEqual(ensureAlwaysInstallSkills(['to-prd']), [
    'to-prd',
    'post-skill-bootstrap',
    'update-changelog',
  ]);
});

test('ensureAlwaysInstallSkills does not duplicate', () => {
  assert.deepEqual(
    ensureAlwaysInstallSkills(['post-skill-bootstrap', 'update-changelog', 'to-prd']),
    ['post-skill-bootstrap', 'update-changelog', 'to-prd'],
  );
});

test('isAlwaysInstallSkill', () => {
  assert.equal(isAlwaysInstallSkill('post-skill-bootstrap'), true);
  assert.equal(isAlwaysInstallSkill('update-changelog'), true);
  assert.equal(isAlwaysInstallSkill('to-prd'), false);
});
