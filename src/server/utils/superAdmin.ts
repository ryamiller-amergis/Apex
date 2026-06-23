import type { Request } from 'express';
import { getUserEmail } from './requestUser';

export const SUPER_ADMIN_EMAILS = [
  'ryamiller@amergis.com',
  'anedunur@amergis.com',
];

export function isSuperAdminEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return SUPER_ADMIN_EMAILS.some((e) => e.toLowerCase() === lower);
}

export function isSuperAdminRequest(req: Request): boolean {
  const email = getUserEmail(req);
  if (!email) return false;
  return isSuperAdminEmail(email);
}
