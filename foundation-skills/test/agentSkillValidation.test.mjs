import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSkillFrontmatter,
  validateAgentSkillDocument,
} from '../lib/agentSkillValidation.mjs';

const validSkill = `---
name: pdf-processing
description: Extract PDF text and tables. Use when handling PDF documents.
license: Apache-2.0
compatibility: Requires Python 3.14+
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Read
---

# PDF processing
`;

test('Agent Skills frontmatter accepts every specification field', () => {
  const result = validateAgentSkillDocument(validSkill, {
    expectedName: 'pdf-processing',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.frontmatter.metadata.version, '1.0');
});

test('Agent Skills frontmatter enforces names and parent directory match', () => {
  const invalid = validSkill.replace('name: pdf-processing', 'name: PDF--tool');
  const result = validateAgentSkillDocument(invalid, {
    expectedName: 'pdf-processing',
  });
  assert.match(result.errors.join('\n'), /lowercase letters/);
  assert.match(result.errors.join('\n'), /parent directory/);
});

test('Agent Skills frontmatter rejects missing and oversized descriptions', () => {
  const missing = validSkill.replace(
    'description: Extract PDF text and tables. Use when handling PDF documents.\n',
    ''
  );
  assert.match(
    validateAgentSkillDocument(missing).errors.join('\n'),
    /description is required/
  );

  const oversized = validSkill.replace(
    'Extract PDF text and tables. Use when handling PDF documents.',
    'x'.repeat(1025)
  );
  assert.match(
    validateAgentSkillDocument(oversized).errors.join('\n'),
    /at most 1024/
  );
});

test('Agent Skills frontmatter warns on extra harness fields without failing', () => {
  const extra = validSkill.replace(
    'license: Apache-2.0',
    'disable-model-invocation: true'
  );
  const result = validateAgentSkillDocument(extra);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.match(
    result.warnings.join('\n'),
    /unrecognized frontmatter field "disable-model-invocation"/
  );
});

test('Agent Skills metadata values must be strings', () => {
  const invalid = validSkill.replace('version: "1.0"', 'version: 1');
  assert.match(
    validateAgentSkillDocument(invalid).errors.join('\n'),
    /metadata must be a mapping of string keys to string values/
  );
});

test('frontmatter parser supports folded descriptions', () => {
  const parsed = parseSkillFrontmatter(`---
name: folded-skill
description: >
  First sentence.
  Use when folded YAML is preferred.
---
`);
  assert.equal(
    parsed.frontmatter.description,
    'First sentence. Use when folded YAML is preferred.'
  );
});
