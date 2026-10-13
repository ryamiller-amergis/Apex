export type DocumentDeepLinkKind =
  | 'adr'
  | 'interview'
  | 'prd'
  | 'design-doc'
  | 'design-prototype'
  | 'design-plan'
  | 'ui-lab'
  | 'diagram'
  | 'load-test'
  | 'load-test-run'
  | 'dev-session'
  | 'feature-request'
  | 'work-item'
  | 'standup-session'
  | 'chat-thread'
  | 'playbook-run';

export interface DocumentDeepLink {
  kind: DocumentDeepLinkKind;
  id: string;
  guardedView: string;
}

const RESERVED_IDS = new Set(['new', 'runs']);

function idFrom(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (!id || RESERVED_IDS.has(id)) return null;
  return id;
}

function queryId(search: string, key: string): string | null {
  const id = new URLSearchParams(search).get(key)?.trim() ?? '';
  return id || null;
}

/**
 * A URL that points at one record. List pages and compose routes are not links
 * to a record, so they stay on the project the user already has open.
 */
export function parseDocumentDeepLink(pathname: string, search = ''): DocumentDeepLink | null {
  const pathLinks: Array<{ pattern: RegExp; kind: DocumentDeepLinkKind; guardedView: string }> = [
    { pattern: /^\/adr\/([^/]+)$/, kind: 'adr', guardedView: 'adr' },
    { pattern: /^\/backlog\/interview\/([^/]+)$/, kind: 'interview', guardedView: 'backlog' },
    { pattern: /^\/backlog\/prd\/([^/]+)$/, kind: 'prd', guardedView: 'backlog' },
    { pattern: /^\/backlog\/design-doc\/([^/]+)$/, kind: 'design-doc', guardedView: 'backlog' },
    { pattern: /^\/backlog\/design-prototypes\/([^/]+)$/, kind: 'design-prototype', guardedView: 'backlog' },
    { pattern: /^\/backlog\/design-prototype\/([^/]+)$/, kind: 'design-prototype', guardedView: 'backlog' },
    { pattern: /^\/backlog\/design-plan\/([^/]+)$/, kind: 'design-plan', guardedView: 'backlog' },
    { pattern: /^\/ui-lab\/([^/]+)$/, kind: 'ui-lab', guardedView: 'ui-lab' },
    { pattern: /^\/diagrams\/([^/]+)$/, kind: 'diagram', guardedView: 'diagrams' },
    { pattern: /^\/load-tests\/runs\/([^/]+)$/, kind: 'load-test-run', guardedView: 'load-tests' },
    { pattern: /^\/load-tests\/([^/]+)\/runs$/, kind: 'load-test', guardedView: 'load-tests' },
    { pattern: /^\/load-tests\/([^/]+)$/, kind: 'load-test', guardedView: 'load-tests' },
    { pattern: /^\/my-work\/session\/([^/]+)$/, kind: 'dev-session', guardedView: 'my-work' },
  ];

  for (const entry of pathLinks) {
    const id = idFrom(pathname, entry.pattern);
    if (id) return { kind: entry.kind, id, guardedView: entry.guardedView };
  }

  const queryLinks: Array<{
    pathname: string;
    key: string;
    kind: DocumentDeepLinkKind;
    guardedView: string;
  }> = [
    { pathname: '/feature-requests', key: 'id', kind: 'feature-request', guardedView: 'feature-requests' },
    { pathname: '/my-work', key: 'itemId', kind: 'feature-request', guardedView: 'my-work' },
    { pathname: '/work-board', key: 'item', kind: 'work-item', guardedView: 'work-board' },
    { pathname: '/standup-summary', key: 'session', kind: 'standup-session', guardedView: 'standup-summary' },
    { pathname: '/home', key: 'thread', kind: 'chat-thread', guardedView: 'home' },
    { pathname: '/playbooks', key: 'run', kind: 'playbook-run', guardedView: 'playbooks' },
  ];

  for (const entry of queryLinks) {
    if (pathname !== entry.pathname) continue;
    const id = queryId(search, entry.key);
    if (id) return { kind: entry.kind, id, guardedView: entry.guardedView };
  }

  return null;
}

/**
 * The project name from the user's project list that owns this document.
 * Null when the document is already in the selected project, or the user
 * has no matching project to switch to.
 */
export function documentProjectSwitchTarget(
  documentProject: string | undefined,
  selectedProject: string,
  availableProjects: readonly string[],
): string | null {
  if (!documentProject) return null;
  const canonical = availableProjects.find(
    (project) => project.toLowerCase() === documentProject.toLowerCase(),
  );
  if (!canonical) return null;
  if (canonical.toLowerCase() === selectedProject.toLowerCase()) return null;
  return canonical;
}

export function shouldHoldDocumentRoute(input: {
  link: DocumentDeepLink | null;
  lookupPending: boolean;
  switchTarget: string | null;
}): boolean {
  if (input.switchTarget) return true;
  if (!input.link) return false;
  return input.lookupPending;
}
