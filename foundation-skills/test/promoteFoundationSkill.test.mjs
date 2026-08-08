import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const SKILL_PATH = path.join(
  REPO_ROOT,
  '.cursor',
  'skills',
  'promote-foundation-skill',
  'SKILL.md',
);
const PACKAGE_PATH = path.join(REPO_ROOT, 'foundation-skills', 'package.json');

test('promote-foundation-skill defines the release-ready promotion contract', () => {
  assert.ok(fs.existsSync(SKILL_PATH), 'promotion slash skill must exist');
  const text = fs.readFileSync(SKILL_PATH, 'utf8').replace(/\r\n/g, '\n');

  assert.match(text, /^---\nname: promote-foundation-skill\n/m);
  assert.match(text, /\/promote-foundation-skill <skill-name>/);
  assert.match(text, /foundation-skills\/foundation\/<skill-name>/);
  assert.match(text, /foundation-skills\/adapters\/<skill-name>/);
  assert.match(text, /foundation-skills\/catalog\.json/);
  assert.match(text, /suiteVersion/);
  assert.match(text, /npm pack --dry-run --json/);
  assert.match(text, /post-skill-bootstrap/);
  assert.match(text, /AskQuestion/);
  assert.match(text, /Do not commit, push, publish, or create an APEX release/i);
});

test('published package includes adapter templates', () => {
  const manifest = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  assert.ok(
    manifest.files?.includes('adapters/'),
    'foundation-skills/package.json files must include adapters/',
  );
});
