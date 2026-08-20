/**
 * Turns stored evaluation rationale into readable Markdown.
 * New evaluations already use headings; older rows are one semicolon-packed paragraph.
 */

export function formatRationaleMarkdown(rationale: string): string {
  const trimmed = rationale.trim();
  if (!trimmed) return '';
  if (/\n/.test(trimmed) || /^#{1,3}\s/m.test(trimmed)) return trimmed;

  const semicolonParts = trimmed.split(/\s*;\s+/).map((part) => part.trim()).filter(Boolean);
  if (semicolonParts.length >= 2) {
    return semicolonParts.map(toSentence).join('\n\n');
  }

  const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
  if (!sentences || sentences.length <= 2) return trimmed;

  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    chunks.push(sentences.slice(i, i + 2).map((part) => part.trim()).join(' '));
  }
  return chunks.join('\n\n');
}

function toSentence(value: string): string {
  if (/[.!?]$/.test(value)) return value;
  return `${value}.`;
}
