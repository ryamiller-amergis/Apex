import { parse as parseYaml } from 'yaml';

const OUTPUT_KINDS = new Set(['report@1', 'scorecard@1', 'decision@1', 'document@1']);
const SKILL_TYPES = new Set(['autonomous', 'interactive']);

export interface PlaybookSkillFrontmatter {
  name: string;
  description: string;
  skillType: 'autonomous' | 'interactive' | null;
  outputKind: string | null;
  declaresCapabilities: boolean;
}

export class PlaybookSkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookSkillFrontmatterError';
  }
}

function metadataString(metadata: unknown, key: string): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const apex = (metadata as { apex?: unknown }).apex;
  if (!apex || typeof apex !== 'object') return '';
  const value = (apex as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** YAML frontmatter. A skill with no frontmatter block is refused. */
export function parsePlaybookSkillFrontmatter(content: string): PlaybookSkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new PlaybookSkillFrontmatterError('The skill needs a YAML frontmatter block.');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid YAML';
    throw new PlaybookSkillFrontmatterError(`The skill frontmatter is not valid YAML. ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlaybookSkillFrontmatterError('The skill frontmatter must be a YAML map.');
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  if (!name) {
    throw new PlaybookSkillFrontmatterError('The skill frontmatter needs a name.');
  }
  const skillTypeRaw = metadataString(record.metadata, 'skill-type');
  const outputKindRaw = metadataString(record.metadata, 'output-kind');
  if (skillTypeRaw && !SKILL_TYPES.has(skillTypeRaw)) {
    throw new PlaybookSkillFrontmatterError(
      `The skill type "${skillTypeRaw}" is not autonomous or interactive.`,
    );
  }
  if (outputKindRaw && !OUTPUT_KINDS.has(outputKindRaw)) {
    throw new PlaybookSkillFrontmatterError(`The output kind "${outputKindRaw}" is not one of the four kinds.`);
  }
  return {
    name,
    description,
    skillType: skillTypeRaw ? (skillTypeRaw as 'autonomous' | 'interactive') : null,
    outputKind: outputKindRaw || null,
    declaresCapabilities: Object.prototype.hasOwnProperty.call(record, 'playbook-capabilities'),
  };
}
