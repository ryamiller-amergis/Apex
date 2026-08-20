/** Selected project from localStorage, used for project-scoped RBAC. */
export const SELECTED_PROJECT_CHANGE_EVENT = 'apex:selected-project';

export function getSelectedApexProject(): string | null {
  return localStorage.getItem('selectedProject');
}

/** Same-tab signal that `selectedProject` in localStorage changed. */
export function notifySelectedProjectChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SELECTED_PROJECT_CHANGE_EVENT));
}

/**
 * Headers that include X-Apex-Project when a project is selected.
 * Use for raw fetch / XHR that cannot go through apiFetch.
 */
export function apexProjectHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  const selectedProject = getSelectedApexProject();
  if (selectedProject) {
    headers.set('X-Apex-Project', selectedProject);
  }
  return headers;
}

/**
 * Append `?project=` (or `&project=`) so routes that load via URL
 * (e.g. pdf.js getDocument) still resolve project-scoped permissions.
 */
export function withApexProject(url: string): string {
  const selectedProject = getSelectedApexProject();
  if (!selectedProject) return url;
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}project=${encodeURIComponent(selectedProject)}`;
}

/**
 * Central fetch wrapper that attaches credentials and the X-Apex-Project header
 * (read from localStorage at call time) to every request.
 */
export async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = apexProjectHeaders(options?.headers);

  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  if (res.status === 204 || res.headers?.get('content-length') === '0') {
    return undefined as unknown as T;
  }

  // Some successful mutation endpoints return 200/201 with an empty body and
  // no Content-Length header. Reading them with response.json() throws.
  if (typeof res.text === 'function') {
    const text = await res.text();
    return text ? JSON.parse(text) as T : undefined as unknown as T;
  }

  // Retain compatibility with lightweight Response mocks used by callers.
  return res.json() as Promise<T>;
}
