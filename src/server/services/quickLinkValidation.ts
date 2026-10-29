import {
  ProjectQuickLinkError,
  QUICK_LINK_CATEGORY_MAX_LENGTH,
  QUICK_LINK_LABEL_MAX_LENGTH,
  QUICK_LINK_URL_MAX_LENGTH,
} from '../../shared/types/projectQuickLinks';

export function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectQuickLinkError('Label is required');
  }
  const label = value.trim();
  if (label.length > QUICK_LINK_LABEL_MAX_LENGTH) {
    throw new ProjectQuickLinkError(
      `Label must be ${QUICK_LINK_LABEL_MAX_LENGTH} characters or fewer`,
    );
  }
  return label;
}

/** Accepts only absolute http(s) URLs so a link can never run script (`javascript:`, `data:`). */
export function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectQuickLinkError('URL is required');
  }
  const raw = value.trim();
  if (raw.length > QUICK_LINK_URL_MAX_LENGTH) {
    throw new ProjectQuickLinkError(
      `URL must be ${QUICK_LINK_URL_MAX_LENGTH} characters or fewer`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProjectQuickLinkError('URL is not valid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProjectQuickLinkError('URL must start with http:// or https://');
  }
  return parsed.toString();
}

export function normalizeCategory(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ProjectQuickLinkError('Category must be text');
  const category = value.trim();
  if (!category) return null;
  if (category.length > QUICK_LINK_CATEGORY_MAX_LENGTH) {
    throw new ProjectQuickLinkError(
      `Category must be ${QUICK_LINK_CATEGORY_MAX_LENGTH} characters or fewer`,
    );
  }
  return category;
}

export function normalizeSortOrder(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) {
    throw new ProjectQuickLinkError('Sort order must be a whole number from 0 to 100000');
  }
  return n;
}

