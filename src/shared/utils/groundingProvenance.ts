const COMMENT_RE = /<!-- apex-grounded-sha:[0-9a-f]+ -->/i;
const BLOCK_RE =
  /^<!-- apex-grounded-sha:[0-9a-f]+ -->\s*(?:> Grounded on[^\n]*\n+)?/i;

export interface GroundingProvenanceInput {
  groundedSha: string;
  repository: string;
  branch: string;
  groundedAt: string;
}

export function formatGroundingProvenanceBlock(
  input: GroundingProvenanceInput,
): string {
  const sha = input.groundedSha.trim().toLowerCase();
  const groundedDate = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(input.groundedAt));
  return [
    `<!-- apex-grounded-sha:${sha} -->`,
    '',
    `> Grounded on \`${input.repository}\` @ \`${input.branch}\` at \`${sha}\` (${groundedDate}).`,
    '',
  ].join('\n');
}

/** Idempotent: replaces an existing stamp rather than stacking another copy. */
export function stampGroundingProvenance(
  markdown: string,
  input: GroundingProvenanceInput,
): string {
  const sha = input.groundedSha.trim();
  if (!sha) return markdown;
  const block = formatGroundingProvenanceBlock(input);
  const stripped = markdown.replace(BLOCK_RE, '');
  if (COMMENT_RE.test(stripped)) {
    return stripped.replace(COMMENT_RE, `<!-- apex-grounded-sha:${sha.trim().toLowerCase()} -->`);
  }
  return `${block}${stripped}`;
}
