/**
 * Tells a change request apart from a question about build progress, so a
 * request sent while a build runs becomes the next revision instead of a reply.
 */
const CHANGE_WORDS =
  /\b(change|update|make|add|remove|delete|use|switch|replace|fix|move|set|rename|swap|hide|increase|decrease|bigger|smaller|darker|lighter|bolder|want|would like|instead|redesign|restyle|adjust|tweak|improve|align|center|resize|recolou?r|theme|tokens?)\b/i;

const PROGRESS_QUESTION =
  /^\s*(what|when|where|why|how|is|are|did|has|have|any)\b[^.!]*\b(status|progress|done|finished|ready|eta|long|happening|working|running|stuck|left)\b/i;

export function isBuildChangeRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (PROGRESS_QUESTION.test(trimmed)) return false;
  return CHANGE_WORDS.test(trimmed);
}
