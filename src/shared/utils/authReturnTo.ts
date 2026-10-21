/**
 * Validate a post-login return path. Only same-origin Apex relative paths are
 * accepted — rejects protocol-relative URLs, absolute URLs, and non-path junk.
 */
export function sanitizeAuthReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  if (/[\r\n\0]/.test(value)) return null;
  // Disallow scheme-looking segments after the leading slash.
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  // Cap length to avoid session bloat.
  if (value.length > 1024) return null;
  return value;
}

export function buildLoginUrl(returnTo?: string | null): string {
  const safe = sanitizeAuthReturnTo(returnTo);
  if (!safe) return '/auth/login';
  const params = new URLSearchParams({ returnTo: safe });
  return `/auth/login?${params.toString()}`;
}
