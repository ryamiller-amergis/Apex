export interface RepositoryContextPackInput {
  project: string;
  repo: string;
  branch: string;
  provider: 'ado' | 'github';
  contextContent?: string | null;
  agentsContent?: string | null;
}

const REPOSITORY_PATH_PREFIXES = [
  '.cursor/',
  'design-docs/',
  'infra/',
  'migrations/',
  'public/',
  'scripts/',
  'src/',
  'tests/',
];

/**
 * Extract concrete repository paths from the backticked references in AGENTS.md.
 * Commands, permission keys, routes, and wildcard globs are deliberately omitted.
 */
export function extractKnownRepositoryPaths(
  agentsContent: string,
  maxPaths = 120,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const backticked = /`([^`\r\n]+)`/g;
  let match: RegExpExecArray | null;

  while ((match = backticked.exec(agentsContent)) !== null && paths.length < maxPaths) {
    const candidate = match[1].trim().replace(/^\/+/, '');
    if (
      !candidate
      || candidate.length > 240
      || candidate.includes('*')
      || candidate.includes(' ')
      || candidate.includes('${')
      || /^https?:/i.test(candidate)
    ) {
      continue;
    }

    const isRootFile = /^(?:AGENTS\.md|context\.md|package\.json|README\.md)$/i.test(candidate);
    const isKnownRepositoryPath = REPOSITORY_PATH_PREFIXES.some((prefix) =>
      candidate.startsWith(prefix),
    );
    if (!isRootFile && !isKnownRepositoryPath) continue;

    if (!seen.has(candidate)) {
      seen.add(candidate);
      paths.push(candidate);
    }
  }

  return paths;
}

export function buildRepositoryContextPack(input: RepositoryContextPackInput): string | null {
  const contextContent = input.contextContent?.trim();
  const agentsContent = input.agentsContent?.trim();
  if (!contextContent && !agentsContent) return null;

  const knownPaths = agentsContent ? extractKnownRepositoryPaths(agentsContent) : [];
  const parts = [
    '# Pre-loaded repository context pack',
    '',
    `Source: ${input.provider} · ${input.project}/${input.repo} · branch ${input.branch}`,
    '',
    'This repository context was fetched by Apex before the agent run.',
    'Do not call MCP to re-read documents included below.',
    'Use the known-path index for scoped `list_repo_dir` and `get_skill_file` calls.',
    '`search_repo_code` is intentionally unavailable in interview sessions; if no known path applies,',
    'state the unresolved assumption or ask the user instead of performing a broad repository search.',
  ];

  if (contextContent) {
    parts.push('', '## context.md', '', contextContent);
  }
  if (agentsContent) {
    parts.push('', '## AGENTS.md', '', agentsContent);
  }
  if (knownPaths.length > 0) {
    parts.push(
      '',
      '## Known repository paths extracted from AGENTS.md',
      '',
      ...knownPaths.map((path) => `- \`${path}\``),
    );
  }

  parts.push('', '# End pre-loaded repository context pack');
  return parts.join('\n');
}
