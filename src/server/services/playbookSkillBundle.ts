import { createHash } from 'node:crypto';

/**
 * bundle-v1: the content hash a resolverVersion 2 Playbook policy pins.
 *
 * Covers the skill version ID, the SKILL.md text, and every instruction companion, sorted by file
 * name. Reference files are excluded, so a catalog change never changes a published pin.
 *
 * Each part is written as `<label>\n<byte length>\n<content>\n`, with the content in UTF-8 and LF
 * line endings. The label is the file name, or the fixed label for the version ID. A byte length
 * in front of every part keeps two different splits of the same bytes from hashing the same.
 */

export const BUNDLE_HASH_FORMAT = 'bundle-v1';

export type SkillCompanionClassification = 'instruction' | 'reference';

export interface SkillBundleCompanion {
  /** Bare file name beside SKILL.md, for example INVESTIGATION_GUIDE.md. */
  path: string;
  content: string;
  classification: SkillCompanionClassification;
}

export interface SkillBundleInput {
  skillVersionId: string;
  skillContent: string;
  companions: readonly SkillBundleCompanion[];
}

const VERSION_ID_LABEL = 'skill-version-id';
const SKILL_LABEL = 'SKILL.md';

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function encodePart(label: string, content: string): Buffer {
  const body = Buffer.from(normalizeLineEndings(content), 'utf8');
  return Buffer.concat([
    Buffer.from(`${label}\n${body.length}\n`, 'utf8'),
    body,
    Buffer.from('\n', 'utf8'),
  ]);
}

function assertBareFileName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    /[/\\\r\n]/.test(name)
  ) {
    throw new Error(`Skill companion path "${name}" must be a bare file name.`);
  }
}

/** SHA-256 of a skill version under the bundle-v1 format, as 64 lowercase hex characters. */
export function bundleHashV1(input: SkillBundleInput): string {
  if (input.skillVersionId.length === 0) {
    throw new Error('A skill version ID is required to hash a bundle.');
  }

  const seen = new Set<string>();
  for (const companion of input.companions) {
    assertBareFileName(companion.path);
    if (seen.has(companion.path)) {
      throw new Error(`Skill companion "${companion.path}" appears twice in one bundle.`);
    }
    seen.add(companion.path);
  }

  const instructionFiles = input.companions
    .filter((companion) => companion.classification === 'instruction')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash('sha256');
  hash.update(encodePart(VERSION_ID_LABEL, input.skillVersionId));
  hash.update(encodePart(SKILL_LABEL, input.skillContent));
  for (const companion of instructionFiles) {
    hash.update(encodePart(companion.path, companion.content));
  }
  return hash.digest('hex');
}
