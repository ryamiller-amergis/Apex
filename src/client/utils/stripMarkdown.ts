/**
 * Strips markdown formatting so text is suitable for text-to-speech.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  result = result.replace(/```[\s\S]*?```/g, '');
  result = result.replace(/`([^`\n]+)`/g, '$1');
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  result = result.replace(/^#{1,6}\s+/gm, '');
  result = result.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/___([^_]+)___/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');
  result = result.replace(/~~([^~]+)~~/g, '$1');
  result = result.replace(/^[-*_]{3,}\s*$/gm, '');
  result = result.replace(/^\|.*\|$/gm, '');

  result = result.replace(/\n(?=\s*[-*+]\s)/g, '. ');
  result = result.replace(/\n(?=\s*\d+\.\s)/g, '. ');
  result = result.replace(/\n(?=\s*>)/g, '. ');
  result = result.replace(/(^|[.\s])\s*[-*+]\s+/g, '$1');
  result = result.replace(/(^|[.\s])\s*\d+\.\s+/g, '$1');
  result = result.replace(/(^|[.\s])>\s?/g, '$1');

  result = result.replace(/\n{2,}/g, '. ');
  result = result.replace(/\n/g, ' ');
  result = result.replace(/\s+/g, ' ');
  result = result.replace(/\s*\.\s*/g, '. ');

  const trimmed = result.replace(/^\.\s*/, '').trim();
  if (!trimmed || trimmed === '.') return '';

  return trimmed;
}
