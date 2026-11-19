export type ProjectSkillOutputKind = 'report@1' | 'scorecard@1' | 'decision@1' | 'document@1';
export type ProjectSkillType = 'autonomous' | 'interactive';
export type ProjectSkillLibraryFilter = 'all' | 'pending-reference';

export interface ProjectSkillLibraryFile {
  id: string;
  fileName: string;
  classification: 'instruction' | 'reference';
  approvalStatus: 'pending' | 'approved';
  content?: string;
}

export interface ProjectSkillLibraryVersion {
  id: string;
  versionNumber: number;
  status: 'draft' | 'published';
  skillType: string | null;
  outputKind: string | null;
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

export const OUTPUT_KIND_OPTIONS: { label: string; value: ProjectSkillOutputKind }[] = [
  { label: 'Document', value: 'document@1' },
  { label: 'Report', value: 'report@1' },
  { label: 'Scorecard', value: 'scorecard@1' },
  { label: 'Decision', value: 'decision@1' },
];

export function skillNameFromTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function companionFileName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withExt = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/.test(withExt) || withExt.toUpperCase() === 'SKILL.MD') {
    return null;
  }
  return withExt;
}

export function buildProjectSkillMarkdown(input: {
  title: string;
  description: string;
  skillType: ProjectSkillType;
  outputKind: ProjectSkillOutputKind;
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
    `    output-kind: ${input.outputKind}`,
    '---',
    '',
    input.body.trim(),
    '',
  ].join('\n');
  return { name, content };
}

export function skillHasPendingReference(skill: ProjectSkillLibraryItem): boolean {
  return skill.versions.some((version) =>
    version.files.some((file) => file.classification === 'reference' && file.approvalStatus === 'pending'),
  );
}

export function filterProjectSkills(
  skills: ProjectSkillLibraryItem[],
  filter: ProjectSkillLibraryFilter,
  search: string,
): ProjectSkillLibraryItem[] {
  const query = search.trim().toLowerCase();
  return skills.filter((skill) => {
    if (filter === 'pending-reference' && !skillHasPendingReference(skill)) return false;
    if (!query) return true;
    return `${skill.name} ${skill.description}`.toLowerCase().includes(query);
  });
}
