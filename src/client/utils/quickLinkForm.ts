import { z } from 'zod';
import {
  QUICK_LINK_CATEGORY_MAX_LENGTH,
  QUICK_LINK_LABEL_MAX_LENGTH,
  QUICK_LINK_URL_MAX_LENGTH,
} from '../../shared/types/projectQuickLinks';

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const quickLinkLabelField = z
  .string()
  .trim()
  .min(1, 'Label is required')
  .max(QUICK_LINK_LABEL_MAX_LENGTH, `Label must be ${QUICK_LINK_LABEL_MAX_LENGTH} characters or fewer`);

export const quickLinkUrlField = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .max(QUICK_LINK_URL_MAX_LENGTH, `URL must be ${QUICK_LINK_URL_MAX_LENGTH} characters or fewer`)
  .refine(isHttpUrl, 'Enter a full URL starting with http:// or https://');

export const quickLinkCategoryField = z
  .string()
  .trim()
  .max(QUICK_LINK_CATEGORY_MAX_LENGTH, `Category must be ${QUICK_LINK_CATEGORY_MAX_LENGTH} characters or fewer`);
