import { rewriteGroundingProvenanceForDisplay } from '../../shared/utils/groundingProvenance';

/**
 * Removes a leading YAML frontmatter block (`---` … `---`) from markdown.
 *
 * Document previews render with ReactMarkdown, which treats soft line breaks as
 * spaces — so frontmatter keys (title, slug, created, …) collapse into one
 * unprofessional paragraph. Strip the block for display; keep it in stored source.
 *
 * Also hides the machine SHA HTML comment. ReactMarkdown does not parse HTML by
 * default, so `<!-- apex-grounded-sha:… -->` would otherwise show as raw text.
 */
export function stripYamlFrontmatter(markdown: string): string {
  if (!markdown) return markdown;
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = match
    ? markdown.slice(match[0].length).replace(/^\r?\n/, '')
    : markdown;
  return rewriteGroundingProvenanceForDisplay(body);
}
