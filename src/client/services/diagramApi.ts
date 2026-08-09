import type {
  CreateDiagramInput,
  DiagramDetail,
  DiagramListInput,
  DiagramListResponse,
  DiagramShare,
  DiagramShareTarget,
  DiagramSharesResponse,
  DiagramShareTargetsResponse,
  UpdateDiagramInput,
  UpsertDiagramShareInput,
} from '../../shared/types/diagram';

export class DiagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DiagramApiError';
  }
}

export function isVersionConflict(error: unknown): error is DiagramApiError {
  return error instanceof DiagramApiError
    && (error.status === 409 || error.code === 'DIAGRAM_VERSION_CONFLICT');
}

export function isDiagramAccessDenied(error: unknown): error is DiagramApiError {
  return error instanceof DiagramApiError
    && (error.status === 403 || error.code === 'DIAGRAM_FORBIDDEN');
}

export function isSceneTooLarge(error: unknown): boolean {
  return error instanceof DiagramApiError
    && (error.code === 'DIAGRAM_SCENE_TOO_LARGE' || error.status === 422);
}

async function parseError(response: Response): Promise<DiagramApiError> {
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    code?: string;
  };
  return new DiagramApiError(
    body.error ?? `Request failed: ${response.status}`,
    response.status,
    body.code,
  );
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function diagramsBase(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/diagrams`;
}

export async function createDiagram(
  projectId: string,
  input: CreateDiagramInput,
): Promise<DiagramDetail> {
  return apiFetch<DiagramDetail>(diagramsBase(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function getDiagram(
  projectId: string,
  diagramId: string,
): Promise<DiagramDetail> {
  return apiFetch<DiagramDetail>(
    `${diagramsBase(projectId)}/${encodeURIComponent(diagramId)}`,
  );
}

export async function updateDiagram(
  projectId: string,
  diagramId: string,
  input: UpdateDiagramInput,
): Promise<DiagramDetail> {
  return apiFetch<DiagramDetail>(
    `${diagramsBase(projectId)}/${encodeURIComponent(diagramId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function listDiagrams(
  projectId: string,
  input: DiagramListInput,
): Promise<DiagramListResponse> {
  const params = new URLSearchParams();
  params.set('scope', input.scope);
  if (input.limit != null) params.set('limit', String(input.limit));
  if (input.offset != null) params.set('offset', String(input.offset));
  return apiFetch<DiagramListResponse>(`${diagramsBase(projectId)}?${params.toString()}`);
}

export async function deleteDiagram(
  projectId: string,
  diagramId: string,
): Promise<void> {
  return apiFetch<void>(
    `${diagramsBase(projectId)}/${encodeURIComponent(diagramId)}`,
    { method: 'DELETE' },
  );
}

export async function listDiagramShares(
  projectId: string,
  diagramId: string,
): Promise<DiagramShare[]> {
  const data = await apiFetch<DiagramSharesResponse>(
    `${diagramsBase(projectId)}/${encodeURIComponent(diagramId)}/shares`,
  );
  return data.shares;
}

export async function listShareTargets(
  projectId: string,
  diagramId: string,
  query = '',
): Promise<DiagramShareTarget[]> {
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  const qs = params.toString();
  const data = await apiFetch<DiagramShareTargetsResponse>(
    `${diagramsBase(projectId)}/${encodeURIComponent(diagramId)}/share-targets${qs ? `?${qs}` : ''}`,
  );
  return data.members;
}

export async function createDiagramShare(
  projectId: string,
  diagramId: string,
  input: UpsertDiagramShareInput,
): Promise<DiagramShare> {
  return apiFetch<DiagramShare>(
    `${diagramsBase(projectId)}/${encodeURIComponent(diagramId)}/shares`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function changeDiagramShareAccess(
  projectId: string,
  diagramId: string,
  granteeId: string,
  access: UpsertDiagramShareInput['access'],
): Promise<DiagramShare> {
  return apiFetch<DiagramShare>(
    `${diagramsBase(projectId)}/${encodeURIComponent(diagramId)}/shares/${encodeURIComponent(granteeId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access }),
    },
  );
}

export async function revokeDiagramShare(
  projectId: string,
  diagramId: string,
  granteeId: string,
): Promise<void> {
  return apiFetch<void>(
    `${diagramsBase(projectId)}/${encodeURIComponent(diagramId)}/shares/${encodeURIComponent(granteeId)}`,
    { method: 'DELETE' },
  );
}
