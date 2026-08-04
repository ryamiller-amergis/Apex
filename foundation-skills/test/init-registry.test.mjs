import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  initRegistry,
  mergeApexRegistry,
  hasApexRegistry,
} from '../lib/initRegistry.mjs';
import { makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

test('mergeApexRegistry appends @apex and always-auth without clobbering @maxview', () => {
  const input =
    '@maxview:registry=https://pkgs.dev.azure.com/amergis/MaxView/_packaging/maxview-core/npm/registry/\n';
  const out = mergeApexRegistry(input, {
    registry: 'https://pkgs.dev.azure.com/amergis/_packaging/apex-skills/npm/registry/',
  });
  assert.match(out, /@maxview:registry=/);
  assert.match(out, /@apex:registry=https:\/\/pkgs\.dev\.azure\.com\/amergis\/_packaging\/apex-skills/);
  assert.match(out, /always-auth=true/);
  assert.equal(hasApexRegistry(out), true);
});

test('init-registry creates .npmrc from .npmrc.template', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.npmrc.template':
      '# template\n' +
      '@maxview:registry=https://pkgs.dev.azure.com/amergis/MaxView/_packaging/maxview-core/npm/registry/\n' +
      'always-auth=true\n',
  });
  try {
    const result = initRegistry(repo, { org: 'amergis', feed: 'apex-skills' });
    assert.equal(result.action, 'created-from-template');
    assert.equal(result.wrote, true);
    const text = fs.readFileSync(path.join(repo, '.npmrc'), 'utf8');
    assert.match(text, /@maxview:registry=/);
    assert.match(text, /@apex:registry=/);
  } finally {
    cleanup(repo);
  }
});

test('init-registry merges into existing gitignored-style .npmrc', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.npmrc':
      '@maxview:registry=https://pkgs.dev.azure.com/amergis/MaxView/_packaging/maxview-core/npm/registry/\n' +
      'always-auth=true\n',
  });
  try {
    const result = initRegistry(repo, { org: 'amergis', feed: 'apex-skills' });
    assert.equal(result.action, 'merged');
    const text = fs.readFileSync(path.join(repo, '.npmrc'), 'utf8');
    assert.match(text, /@maxview:registry=/);
    assert.match(text, /@apex:registry=.*apex-skills/);
  } finally {
    cleanup(repo);
  }
});

test('init-registry is a no-op when @apex already matches', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.npmrc':
      '@apex:registry=https://pkgs.dev.azure.com/amergis/_packaging/apex-skills/npm/registry/\n' +
      'always-auth=true\n',
  });
  try {
    const result = initRegistry(repo, { org: 'amergis', feed: 'apex-skills' });
    assert.equal(result.action, 'unchanged');
    assert.equal(result.wrote, false);
  } finally {
    cleanup(repo);
  }
});
