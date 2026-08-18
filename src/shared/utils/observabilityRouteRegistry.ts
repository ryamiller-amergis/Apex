/**
 * Allow-listed Apex route templates used by browser capture and ingest.
 * Concrete identifiers and query/fragment values are never retained.
 */
import { UNKNOWN_ROUTE_TEMPLATE } from '../types/observability';

export const APEX_ROUTE_TEMPLATES = [
  '/',
  '/home',
  '/calendar',
  '/planning',
  '/planning/dev-stats',
  '/planning/qa',
  '/planning/ai-analysis',
  '/planning/roadmap',
  '/planning/releases',
  '/planning/:tab',
  '/cloud-cost',
  '/backlog',
  '/backlog/interview/:id',
  '/backlog/prd/:id',
  '/backlog/design-prototypes/:id',
  '/backlog/design-plan/:id',
  '/backlog/design-doc/:id',
  '/adr',
  '/adr/:id',
  '/notifications',
  '/profile',
  '/admin',
  '/admin/roles',
  '/admin/users',
  '/admin/groups',
  '/admin/project-settings',
  '/admin/notifications',
  '/admin/load-test-targets',
  '/admin/api-keys',
  '/admin/:section',
  '/my-work',
  '/my-work/session/:id',
  '/standup',
  '/standup-manage',
  '/standup-summary',
  '/feature-requests',
  '/ui-lab',
  '/ui-lab/:id',
  '/pdf-tools',
  '/pdf-tools/webviewer-poc',
  '/pdf-tools/nutrient-poc',
  '/pdf-tools/:id',
  '/ai-cost',
  '/design-module',
  '/load-tests',
  '/load-tests/new',
  '/load-tests/runs/:runId',
  '/load-tests/:definitionId/runs',
  '/load-tests/:definitionId',
  '/diagrams',
  '/diagrams/new',
  '/diagrams/:id',
  '/platform-admin',
] as const;

const PARAM_RE = /^:[A-Za-z0-9_]+$/;

function stripPath(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  const withSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  if (withSlash.length > 1 && withSlash.endsWith('/')) return withSlash.slice(0, -1);
  return withSlash;
}

function templateScore(template: string): number {
  const segments = template.split('/').filter(Boolean);
  const params = segments.filter((segment) => PARAM_RE.test(segment)).length;
  return segments.length * 100 - params;
}

const SORTED_TEMPLATES = [...APEX_ROUTE_TEMPLATES].sort((a, b) => templateScore(b) - templateScore(a));

function matchesTemplate(path: string, template: string): boolean {
  const pathParts = path.split('/');
  const templateParts = template.split('/');
  if (pathParts.length !== templateParts.length) return false;
  for (let i = 0; i < templateParts.length; i += 1) {
    const expected = templateParts[i]!;
    const actual = pathParts[i]!;
    if (PARAM_RE.test(expected)) {
      if (!actual) return false;
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

export function normalizeApexRouteTemplate(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return UNKNOWN_ROUTE_TEMPLATE;
  const path = stripPath(value.trim());
  const matched = SORTED_TEMPLATES.find((template) => matchesTemplate(path, template));
  return matched ?? UNKNOWN_ROUTE_TEMPLATE;
}

export function isRegisteredApexRouteTemplate(value: unknown): boolean {
  return typeof value === 'string' && (APEX_ROUTE_TEMPLATES as readonly string[]).includes(value);
}
