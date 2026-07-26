import { useMutation } from '@tanstack/react-query';
import type {
  DesignModuleGlobPreviewRequest,
  DesignModuleGlobPreviewResponse,
} from '../../shared/types/designModuleScoping';

async function previewGlobs(
  body: DesignModuleGlobPreviewRequest
): Promise<DesignModuleGlobPreviewResponse> {
  const res = await fetch('/api/design-modules/preview-globs', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<DesignModuleGlobPreviewResponse>;
}

export function useGlobPreview() {
  return useMutation<
    DesignModuleGlobPreviewResponse,
    Error,
    DesignModuleGlobPreviewRequest
  >({
    mutationFn: previewGlobs,
  });
}
