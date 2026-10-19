import { createHash } from 'crypto';

const EXCLUDED_HEADING = /^(architecture overview|source|implementation|repository layout)$/i;
const MAX_BRIEF_CHARS = 24_000;

const briefCache = new Map<string, string>();

interface MarkdownSection {
  heading: string;
  body: string;
}

function splitH2(markdown: string): MarkdownSection[] {
  const matches = [...markdown.matchAll(/^## (.+)$/gm)];
  if (matches.length === 0) return [];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? markdown.length) : markdown.length;
    return {
      heading: match[1].trim(),
      body: markdown.slice(start, end).trim(),
    };
  });
}

/**
 * Product-language extract of a repository context.md.
 * Architecture and source sections stay out so a BA interview does not
 * carry implementation detail into every question.
 */
export function buildInterviewBaBrief(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return '';

  const sections = splitH2(trimmed);
  const kept = sections.filter((section) => !EXCLUDED_HEADING.test(section.heading));
  const source = kept.length > 0 ? kept : sections;
  const body = source.length > 0
    ? source.map((section) => `## ${section.heading}\n\n${section.body}`).join('\n\n')
    : trimmed;
  if (body.length <= MAX_BRIEF_CHARS) return body;
  return `${body.slice(0, MAX_BRIEF_CHARS).trimEnd()}\n\n[Application brief truncated.]`;
}

export function cachedInterviewBaBrief(markdown: string): string {
  const hash = createHash('sha256').update(markdown).digest('hex');
  const cached = briefCache.get(hash);
  if (cached !== undefined) return cached;
  const brief = buildInterviewBaBrief(markdown);
  briefCache.set(hash, brief);
  return brief;
}

export async function readInterviewBaBrief(
  readContext: () => Promise<string | null | undefined>,
): Promise<string> {
  try {
    const raw = await readContext();
    if (raw?.trim()) return cachedInterviewBaBrief(raw);
  } catch {
    // A missing context.md still leaves the interview able to ask the person.
  }
  return 'No application brief was available for this project. Ask the person. Do not search the repository.';
}
