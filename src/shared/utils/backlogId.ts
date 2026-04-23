/**
 * ID format: {PREFIX}-{XXXX}-{NNN}
 *   PREFIX — work item type abbreviation (EPIC, FEAT, PBI)
 *   XXXX   — 4 random uppercase alphanumeric characters, guarantees page-level uniqueness
 *   NNN    — 3-digit sequence number based on how many items of that type exist in the document
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomFourChars(): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return s;
}

export type BacklogPrefix = 'EPIC' | 'FEAT' | 'PBI';

/**
 * Generate a unique backlog item ID.
 *
 * @param prefix   - 'EPIC' | 'FEAT' | 'PBI'
 * @param existing - all existing IDs of the same type in the document (used for sequence number)
 * @param offset   - add to sequence when generating multiple IDs in the same batch (default 0)
 */
export function generateBacklogId(
  prefix: BacklogPrefix,
  existing: string[],
  offset = 0
): string {
  const seq = existing.length + 1 + offset;
  return `${prefix}-${randomFourChars()}-${String(seq).padStart(3, '0')}`;
}
