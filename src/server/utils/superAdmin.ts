import type { Request } from 'express';

export const SUPER_ADMIN_EMAILS = ['ryamiller@amergis.com'];

export function isSuperAdminEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return SUPER_ADMIN_EMAILS.some((e) => e.toLowerCase() === lower);
}

export function isSuperAdminRequest(req: Request): boolean {
  const profile = (req.user as any)?.profile;
  const email: string | undefined = profile?.upn ?? profile?.email;
  if (!email) return false;
  return isSuperAdminEmail(email);
}
