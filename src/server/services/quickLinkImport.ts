import {
  ProjectQuickLinkError,
  QUICK_LINKS_IMPORT_MAX_ITEMS,
  type CreateUserQuickLinkInput,
  type RejectedQuickLinkImport,
} from '../../shared/types/projectQuickLinks';
import { normalizeCategory, normalizeLabel, normalizeUrl } from './quickLinkValidation';

export interface ImportCandidate {
  index: number;
  label: string;
  url: string;
  category: string | null;
}

export interface ImportPlan {
  toInsert: ImportCandidate[];
  skippedDuplicates: number;
  rejected: RejectedQuickLinkImport[];
}

/** Throws unless `items` is a non-empty list within the per-request limit. */
export function assertImportItems(items: unknown): asserts items is unknown[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ProjectQuickLinkError('items must be a non-empty list');
  }
  if (items.length > QUICK_LINKS_IMPORT_MAX_ITEMS) {
    throw new ProjectQuickLinkError(
      `An import can include at most ${QUICK_LINKS_IMPORT_MAX_ITEMS} links`,
    );
  }
}

/**
 * Validates each import item on its own, skips URLs already saved or repeated in the batch,
 * and rejects whatever does not fit under `cap`. Throws only when `items` is not a usable list.
 */
export function planQuickLinkImport(
  items: unknown,
  existingUrls: string[],
  cap: number,
  limitMessage: string,
): ImportPlan {
  assertImportItems(items);

  const rejected: RejectedQuickLinkImport[] = [];
  const seen = new Set(existingUrls);
  const fresh: ImportCandidate[] = [];
  let skippedDuplicates = 0;

  items.forEach((raw, index) => {
    const item = (raw ?? {}) as Partial<CreateUserQuickLinkInput>;
    let candidate: ImportCandidate;
    try {
      candidate = {
        index,
        label: normalizeLabel(item.label),
        url: normalizeUrl(item.url),
        category: normalizeCategory(item.category),
      };
    } catch (err) {
      if (!(err instanceof ProjectQuickLinkError)) throw err;
      rejected.push({
        index,
        label: typeof item.label === 'string' ? item.label : '',
        url: typeof item.url === 'string' ? item.url : '',
        reason: err.message,
      });
      return;
    }
    if (seen.has(candidate.url)) {
      skippedDuplicates += 1;
      return;
    }
    seen.add(candidate.url);
    fresh.push(candidate);
  });

  const capacity = Math.max(0, cap - existingUrls.length);
  for (const item of fresh.slice(capacity)) {
    rejected.push({ index: item.index, label: item.label, url: item.url, reason: limitMessage });
  }
  rejected.sort((a, b) => a.index - b.index);

  return { toInsert: fresh.slice(0, capacity), skippedDuplicates, rejected };
}
