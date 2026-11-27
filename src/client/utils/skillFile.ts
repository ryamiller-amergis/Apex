/**
 * Read and edit a whole SKILL.md as text. The skill editor keeps the file, frontmatter included,
 * as its single source of truth; the Title, Type, Description and Tools controls are shortcuts that
 * rewrite the matching frontmatter lines and leave every other line alone.
 */
import type { ProjectSkillType } from './projectSkillLibrary';

export interface SkillFileFields {
  name: string;
  description: string;
  skillType: ProjectSkillType | null;
  /** Tool ids named in `playbook-capabilities`. */
  tools: string[];
  /** The instructions after the frontmatter, trimmed. */
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const BLOCK_SCALAR = /^[>|][+-]?\d*$/;

export function splitSkillFile(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(FENCE);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

function frontmatterLines(frontmatter: string | null): string[] {
  return frontmatter === null ? [] : frontmatter.split(/\r?\n/);
}

/** True for a line that continues the entry above it: indented, a list item, or a blank inside a block. */
function continues(lines: string[], index: number): boolean {
  const line = lines[index];
  if (/^[ \t]+\S/.test(line) || /^-\s/.test(line)) return true;
  if (line.trim() !== '') return false;
  for (let next = index + 1; next < lines.length; next += 1) {
    if (lines[next].trim() === '') continue;
    return /^[ \t]+\S/.test(lines[next]);
  }
  return false;
}

/** The lines of the top-level `key:` entry, as a half-open range, or null when the key is absent. */
function entryRange(lines: string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && continues(lines, end)) end += 1;
  return { start, end };
}

function yamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // fall through to the unquoted reading below
    }
    return value.replace(/^"|"$/g, '');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function readScalar(lines: string[], key: string): string {
  const range = entryRange(lines, key);
  if (!range) return '';
  const first = lines[range.start].slice(key.length + 1).trim();
  const rest = lines.slice(range.start + 1, range.end).map((line) => line.trim());
  if (BLOCK_SCALAR.test(first)) {
    return first.startsWith('>') ? rest.join(' ').replace(/\s+/g, ' ').trim() : rest.join('\n').trim();
  }
  if (first === '') return rest.join(' ').trim();
  return yamlScalar(first);
}

function readSkillType(lines: string[]): ProjectSkillType | null {
  for (const line of lines) {
    const match = line.match(/^[ \t]+skill-type:\s*(\S+)/);
    if (!match) continue;
    const value = yamlScalar(match[1]);
    return value === 'autonomous' || value === 'interactive' ? value : null;
  }
  return null;
}

function readTools(lines: string[]): string[] {
  const range = entryRange(lines, 'playbook-capabilities');
  if (!range) return [];
  const first = lines[range.start].slice('playbook-capabilities:'.length).trim();
  const items = first.startsWith('[')
    ? first.replace(/^\[/, '').replace(/\]\s*$/, '').split(',')
    : lines.slice(range.start + 1, range.end).map((line) => line.replace(/^\s*-\s*/, ''));
  return [...new Set(items.map((item) => yamlScalar(item)).filter(Boolean))];
}

export function readSkillFile(content: string): SkillFileFields {
  const { frontmatter, body } = splitSkillFile(content);
  const lines = frontmatterLines(frontmatter);
  return {
    name: readScalar(lines, 'name'),
    description: readScalar(lines, 'description'),
    skillType: readSkillType(lines),
    tools: readTools(lines),
    body: body.trim(),
  };
}

function setEntry(lines: string[], key: string, replacement: string[] | null): string[] {
  const range = entryRange(lines, key);
  if (!range) {
    if (replacement === null) return lines;
    const kept = [...lines];
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    return [...kept, ...replacement];
  }
  const out = [...lines];
  out.splice(range.start, range.end - range.start, ...(replacement ?? []));
  return out;
}

function setSkillType(lines: string[], type: ProjectSkillType): string[] {
  const out = [...lines];
  const existing = out.findIndex((line) => /^[ \t]+skill-type:/.test(line));
  if (existing >= 0) {
    out[existing] = `${out[existing].match(/^[ \t]+/)![0]}skill-type: ${type}`;
    return out;
  }
  const apex = out.findIndex((line) => /^[ \t]+apex:\s*$/.test(line));
  if (apex >= 0) {
    out.splice(apex + 1, 0, `${out[apex].match(/^[ \t]+/)![0]}  skill-type: ${type}`);
    return out;
  }
  const metadata = out.findIndex((line) => /^metadata:\s*$/.test(line));
  if (metadata >= 0) {
    out.splice(metadata + 1, 0, '  apex:', `    skill-type: ${type}`);
    return out;
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return [...out, 'metadata:', '  apex:', `    skill-type: ${type}`];
}

function yamlName(name: string): string {
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : JSON.stringify(name);
}

/** Changes only the parts named in `patch`. Every other line of the file stays as written. */
export function updateSkillFile(
  content: string,
  patch: {
    name?: string;
    description?: string;
    skillType?: ProjectSkillType;
    tools?: readonly string[];
    body?: string;
  },
): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const split = splitSkillFile(content);
  let lines = frontmatterLines(split.frontmatter);
  let body = split.body;
  if (patch.name !== undefined) lines = setEntry(lines, 'name', [`name: ${yamlName(patch.name)}`]);
  if (patch.description !== undefined) {
    lines = setEntry(lines, 'description', [`description: ${JSON.stringify(patch.description)}`]);
  }
  if (patch.skillType !== undefined) lines = setSkillType(lines, patch.skillType);
  if (patch.tools !== undefined) {
    const tools = [...new Set(patch.tools)];
    lines = setEntry(
      lines,
      'playbook-capabilities',
      tools.length > 0 ? [`playbook-capabilities: [${tools.join(', ')}]`] : null,
    );
  }
  if (patch.body !== undefined) body = `${eol}${patch.body.trim()}${eol}`;
  return `---${eol}${lines.join(eol)}${eol}---${eol}${body}`;
}

/** A new skill: frontmatter with an empty name and description, a type, and no instructions. */
export function blankSkillFile(skillType: ProjectSkillType = 'autonomous'): string {
  return [
    '---',
    'name: ""',
    'description: ""',
    'metadata:',
    '  apex:',
    `    skill-type: ${skillType}`,
    '---',
    '',
    '',
  ].join('\n');
}
