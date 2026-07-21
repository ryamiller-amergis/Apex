import { test } from 'node:test';
import assert from 'node:assert/strict';
import { satisfies, compare, isValid, parse } from '../lib/semver.mjs';

test('parse and isValid', () => {
  assert.equal(isValid('1.2.3'), true);
  assert.equal(isValid('1.2'), false);
  assert.deepEqual(parse('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null });
});

test('compare orders correctly', () => {
  assert.equal(compare('1.0.0', '1.0.1'), -1);
  assert.equal(compare('2.0.0', '1.9.9'), 1);
  assert.equal(compare('1.0.0', '1.0.0'), 0);
  assert.equal(compare('1.0.0-alpha', '1.0.0'), -1);
});

test('caret ranges', () => {
  assert.equal(satisfies('0.1.5', '^0.1.0'), true);
  assert.equal(satisfies('0.2.0', '^0.1.0'), false);
  assert.equal(satisfies('1.4.0', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
});

test('tilde and comparators', () => {
  assert.equal(satisfies('1.2.9', '~1.2.0'), true);
  assert.equal(satisfies('1.3.0', '~1.2.0'), false);
  assert.equal(satisfies('0.1.0', '>=0.1.0'), true);
  assert.equal(satisfies('0.0.9', '>=0.1.0'), false);
});

test('wildcard and hyphen ranges', () => {
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('1.5.0', '1.0.0 - 2.0.0'), true);
  assert.equal(satisfies('2.5.0', '1.0.0 - 2.0.0'), false);
});
