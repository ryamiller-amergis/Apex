/**
 * Reviewed capture exclusion, poll, and route-template policy.
 * Pure functions so the request path never consults PostgreSQL.
 */
import type { Request } from 'express';
import { normalizeRouteTemplate } from '../../shared/utils/traceRedaction';

const EXCLUDED_PREFIXES = [
  '/api/observability',
  '/observability',
  '/api/health',
  '/health',
  '/api/ready',
  '/ready',
  '/api/platform-admin/observability',
];

const STATIC_EXTENSION_RE = /\.(?:js|css|map|mjs|cjs|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|txt|html|json)$/i;

const POLL_SUFFIXES = ['/run-status', '/unread-count', '/poll'];

export function joinRouteTemplate(baseUrl: string, routePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const path = routePath.startsWith('/') ? routePath : `/${routePath}`;
  if (!base) return path;
  return `${base}${path}`;
}

export function resolveRouteTemplate(req: Request): string {
  const matched = req.route && typeof req.route.path === 'string' ? req.route.path : req.path;
  const combined = joinRouteTemplate(req.baseUrl || '', matched || req.path || '');
  return normalizeRouteTemplate(combined) ?? combined.split(/[?#]/, 1)[0] ?? '/';
}

export function isCaptureExcludedPath(routeTemplate: string): boolean {
  const normalized = (normalizeRouteTemplate(routeTemplate) ?? routeTemplate).toLowerCase();
  if (STATIC_EXTENSION_RE.test(normalized) || normalized.startsWith('/static')) {
    return true;
  }
  return EXCLUDED_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

export function isPollRoute(routeTemplate: string): boolean {
  const normalized = (normalizeRouteTemplate(routeTemplate) ?? routeTemplate).toLowerCase();
  return POLL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function resolveCaptureProject(req: Request): string | undefined {
  const fromQuery = req.query?.project;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;

  const fromParams = req.params?.project;
  if (typeof fromParams === 'string' && fromParams) return fromParams;

  const fromProjectIdParam = req.params?.projectId;
  if (typeof fromProjectIdParam === 'string' && fromProjectIdParam) {
    return fromProjectIdParam;
  }

  const fromHeader = req.get?.('x-apex-project') ?? req.headers?.['x-apex-project'];
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;

  return undefined;
}

const TRACEPARENT_RE = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;

export function parseTraceIdFromTraceparent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = TRACEPARENT_RE.exec(value.trim());
  return match?.[1]?.toLowerCase() ?? null;
}
