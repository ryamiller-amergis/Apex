export type ProjectSkillType = 'autonomous' | 'interactive';
export interface ProjectSkillLibraryFile {
  id: string;
  fileName: string;
  classification: 'instruction' | 'reference';
  content: string;
}

export interface ProjectSkillLibraryVersion {
  id: string;
  versionNumber: number;
  status: 'draft' | 'published';
  skillType: string | null;
  outputKind: string | null;
  content: string;
  createdBy: string;
  createdAt: string;
  files: ProjectSkillLibraryFile[];
}

export interface ProjectSkillLibraryItem {
  id: string;
  name: string;
  description: string;
  versions: ProjectSkillLibraryVersion[];
}

/** The server stores at most this many bytes per skill file. Keep in step with MAX_COMPANION_BYTES. */
export const MAX_SKILL_FILE_BYTES = 1_000_000;

/** Word and PDF files are converted to text on the server; anything else must already be text. */
export const MAX_CONVERTED_FILE_BYTES = 5_000_000;

export function skillNameFromTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * A stored name for a picked file: unsupported characters become dashes. Returns null when no
 * usable name is left, when there is no extension, or when the name is SKILL.md.
 */
export function skillFileName(raw: string): string | null {
  const base = raw.trim().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '');
  const stem = base
    .slice(0, dot)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 81);
  if (!stem || !extension || extension.length > 16) return null;
  const name = `${stem}.${extension}`;
  if (name.toUpperCase() === 'SKILL.MD') return null;
  return name;
}

export function isConvertedFileName(name: string): boolean {
  return /\.(docx|pdf)$/i.test(name);
}

/** The text of a picked file, or null when the bytes are not UTF-8 text. */
export function decodeSkillFileText(bytes: ArrayBuffer): string | null {
  const view = new Uint8Array(bytes);
  if (view.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

export function buildProjectSkillMarkdown(input: {
  title: string;
  description: string;
  skillType: ProjectSkillType;
  body: string;
}): { name: string; content: string } {
  const name = skillNameFromTitle(input.title);
  const content = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(input.description.trim())}`,
    'metadata:',
    '  apex:',
    `    skill-type: ${input.skillType}`,
    '---',
    '',
    input.body.trim(),
    '',
  ].join('\n');
  return { name, content };
}

/** The instructions of a saved SKILL.md, without its frontmatter. */
export function skillInstructions(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export function filterProjectSkills(
  skills: ProjectSkillLibraryItem[],
  search: string,
): ProjectSkillLibraryItem[] {
  const query = search.trim().toLowerCase();
  if (!query) return skills;
  return skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query));
}
