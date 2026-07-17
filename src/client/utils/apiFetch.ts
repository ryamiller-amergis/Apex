/** Selected project from localStorage, used for project-scoped RBAC. */
export function getSelectedApexProject(): string | null {
  return localStorage.getItem('selectedProject');
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
