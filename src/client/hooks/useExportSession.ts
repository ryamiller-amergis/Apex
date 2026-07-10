import { useMutation } from '@tanstack/react-query';

interface ExportSessionParams {
  sessionId: string;
  filename?: string;
  pages?: number[];
}

function generateDefaultFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `merged-document-${stamp}.pdf`;
}

function ensurePdfExtension(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return generateDefaultFilename();
  if (!trimmed.toLowerCase().endsWith('.pdf')) return `${trimmed}.pdf`;
  return trimmed;
}

export function useExportSession() {
  return useMutation<void, Error & { code?: string }, ExportSessionParams>({
    mutationFn: async ({ sessionId, filename, pages }) => {
      const finalFilename = filename ? ensurePdfExtension(filename) : generateDefaultFilename();

      const body: Record<string, unknown> = { filename: finalFilename };
      if (pages && pages.length > 0) {
        body.pages = pages;
      }

      const res = await fetch(`/api/pdf/sessions/${sessionId}/export`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(
          body.message ?? body.error ?? `Export failed (HTTP ${res.status})`,
        ) as Error & { code?: string };
        err.code = body.error;
        throw err;
      }

      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const downloadName = match?.[1] ?? finalFilename;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();

      setTimeout(() => {
        URL.revokeObjectURL(url);
        anchor.remove();
      }, 100);
    },
  });
}

export { generateDefaultFilename, ensurePdfExtension };
