const MAX_TITLE_LENGTH = 200;
const UNTITLED = 'Untitled brainstorm';

/** First level-1 heading of a Brainstorm artifact, outside frontmatter and code fences. */
export function brainstormArtifactHeading(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let index = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) index = end + 1;
  }
  let fence: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}#[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading && heading[1].trim()) return heading[1].trim();
  }
  return null;
}

/** Label for a linked Brainstorm: the artifact heading, else the session title. */
export function brainstormLinkTitle(markdown: string | null | undefined, sessionTitle: string | null | undefined): string {
  const title = brainstormArtifactHeading(markdown ?? '') ?? sessionTitle?.trim() ?? '';
  return (title || UNTITLED).slice(0, MAX_TITLE_LENGTH);
}
