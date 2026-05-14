import type { Request } from 'express';

/**
 * Extract a stable, unique identifier for the authenticated user from an
 * Express request populated by Passport + passport-azure-ad.
 *
 * Passport stores the Azure AD user as:
 *   req.user = { profile: { oid, upn, displayName, ... }, accessToken, refreshToken }
 *
 * Identity fields (oid, upn) live under req.user.profile, NOT at the top
 * level of req.user. Always read from profile to avoid silently falling
 * back to 'anonymous' and mixing threads across users.
 *
 * Preference order:
 *   1. profile.oid  — Azure AD Object ID; stable, survives email changes
 *   2. profile.sub  — OIDC subject claim; equivalent in most configs
 *   3. profile.upn  — User Principal Name (email); changes if renamed
 */
export function getUserId(req: Request): string {
  const user = (req as any).user;
  const profile = user?.profile;
  return profile?.oid ?? profile?.sub ?? profile?.upn ?? 'anonymous';
}

/**
 * Return a display-friendly name for the authenticated user, or 'Unknown User'.
 */
export function getDisplayName(req: Request): string {
  const profile = (req as any).user?.profile;
  return profile?.displayName ?? profile?.upn ?? 'Unknown User';
}
