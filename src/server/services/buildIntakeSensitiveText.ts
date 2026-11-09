/**
 * Pattern check for credentials and personal data in a build-intake message.
 * Returns class names only. Name detection is not attempted.
 */
import { SENSITIVE_CLASSES, type SensitiveClass } from '../../shared/utils/buildIntakeMarkers';
import { findSecretClasses } from './buildRedactionService';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const CARD_CANDIDATE_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(CARD_CANDIDATE_RE)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return true;
  }
  return false;
}

export function detectSensitiveClasses(text: string): SensitiveClass[] {
  const found = new Set<SensitiveClass>(findSecretClasses(text));
  if (EMAIL_RE.test(text)) found.add('personal_email');
  if (PHONE_RE.test(text)) found.add('personal_phone');
  if (SSN_RE.test(text)) found.add('personal_government_id');
  if (hasCardNumber(text)) found.add('personal_card_number');
  return SENSITIVE_CLASSES.filter((value) => found.has(value));
}
