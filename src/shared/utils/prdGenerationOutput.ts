/**
 * Guards for PRD generation artifact completeness.
 * Used by the PRD watcher and post-run sync so stub/leftover workspace files
 * cannot promote a PRD out of `generating` or trigger test-case generation.
 */

/** Minimum markdown body length to reject title-only / work-item stubs. */
const MIN_PRD_CONTENT_CHARS = 200;

/**
 * Returns true when PRD markdown + backlog look like real /to-prd output
 * (not an empty `{}` backlog or a short placeholder `.prd.md`).
 */
export function isPrdGenerationOutputComplete(
  content: string | null | undefined,
  backlog: unknown,
): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (trimmed.length < MIN_PRD_CONTENT_CHARS) return false;

  if (backlog == null || typeof backlog !== 'object' || Array.isArray(backlog)) {
    return false;
  }

  const epics = (backlog as { epics?: unknown }).epics;
  return Array.isArray(epics) && epics.length > 0;
}
