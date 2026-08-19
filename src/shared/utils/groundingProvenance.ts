const COMMENT_RE = /<!-- apex-grounded-sha:[0-9a-f]+ -->/i;
const COMMENT_LINE_RE = /^\s*<!--\s*apex-grounded-sha:[0-9a-f]+\s*-->[ \t]*\r?\n?/gim;
const BLOCK_RE =
  /^<!-- apex-grounded-sha:[0-9a-f]+ -->\s*(?:> (?:Grounded on|Based on)[^\n]*\n+)?/i;
const LEGACY_QUOTE_RE =
  /^> Grounded on `?([^`\s]+)`? @ `?([^`\s]+)`? at `?[0-9a-f]+`? \(([^)]+)\)\.[ \t]*$/gim;

export interface GroundingProvenanceInput {
  groundedSha: string;
  repository: string;
  branch: string;
  groundedAt: string;
}

export function formatGroundingProvenanceQuote(
  repository: string,
  branch: string,
  groundedAt: string,
): string {
  const groundedDate = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(groundedAt));
  return `> Based on the **${repository}** project, **${branch}** branch, as of ${groundedDate}.`;
}

export function formatGroundingProvenanceBlock(
  input: GroundingProvenanceInput,
): string {
  const sha = input.groundedSha.trim().toLowerCase();
  return [
    `<!-- apex-grounded-sha:${sha} -->`,
    '',
    formatGroundingProvenanceQuote(
      input.repository,
      input.branch,
      input.groundedAt,
    ),
    '',
  ].join('\n');
}

/** Preview-only: hide the machine SHA comment and rewrite the legacy engineer quote. */
export function rewriteGroundingProvenanceForDisplay(markdown: string): string {
  if (!markdown) return markdown;
  COMMENT_LINE_RE.lastIndex = 0;
  LEGACY_QUOTE_RE.lastIndex = 0;
  return markdown
    .replace(COMMENT_LINE_RE, '')
    .replace(
      LEGACY_QUOTE_RE,
      (_match, repository: string, branch: string, date: string) =>
        `> Based on the **${repository}** project, **${branch}** branch, as of ${date}.`,
    )
    .replace(/^\r?\n/, '');
}

/** Idempotent: replaces an existing stamp instead of stacking another copy. */
export function stampGroundingProvenance(
  markdown: string,
  input: GroundingProvenanceInput,
): string {
  const sha = input.groundedSha.trim();
  if (!sha) return markdown;
  const block = formatGroundingProvenanceBlock(input);
  const stripped = markdown.replace(BLOCK_RE, '');
  if (COMMENT_RE.test(stripped)) {
    return stripped.replace(
      COMMENT_RE,
      `<!-- apex-grounded-sha:${sha.trim().toLowerCase()} -->`,
    );
  }
  return `${block}${stripped}`;
}
