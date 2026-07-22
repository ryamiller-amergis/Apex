import { useMutation } from '@tanstack/react-query';
import { apexProjectHeaders } from '../utils/apiFetch';
import type {
  EnqueueExportResponse,
  PdfConversionJob,
} from '../../shared/types/pdf';

interface ExportSessionParams {
  sessionId: string;
  filename?: string;
  pages?: number[];
}

function ensurePdfExtension(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!trimmed.toLowerCase().endsWith('.pdf')) return `${trimmed}.pdf`;
  return trimmed;
}

export function useExportSession() {
  return useMutation<void, Error & { code?: string }, ExportSessionParams>({
    mutationFn: async ({ sessionId, filename, pages }) => {
      const filenameOverride = filename?.trim()
        ? ensurePdfExtension(filename)
        : undefined;
      const body: Record<string, unknown> = {};
      if (filenameOverride) {
        body.filename = filenameOverride;
      }
      if (pages?.length) {
        body.pages = pages;
      }

      const enqueueResponse = await fetch(
        `/api/pdf/sessions/${sessionId}/export`,
        {
          method: 'POST',
          credentials: 'include',
          headers: apexProjectHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        }
      );

      if (!enqueueResponse.ok) {
        const body = await enqueueResponse.json().catch(() => ({}));
        const err = new Error(
          body.message ??
            body.error?.message ??
            body.error ??
            `Export failed (HTTP ${enqueueResponse.status})`
        ) as Error & { code?: string };
        err.code = body.error?.code ?? body.error;
        throw err;
      }

      const queued = (await enqueueResponse.json()) as EnqueueExportResponse;
      const completed = await pollExportJob(queued.statusUrl);
      const resultUrl =
        completed.resultUrl ?? `/api/pdf/jobs/${queued.jobId}/result`;
      const resultResponse = await fetch(resultUrl, {
        credentials: 'include',
        headers: apexProjectHeaders(),
      });
      if (!resultResponse.ok) {
        throw new Error(
          `Export download failed (HTTP ${resultResponse.status})`
        );
      }

      const blob = await resultResponse.blob();
      const disposition =
        resultResponse.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const downloadName =
        match?.[1] ??
        completed.resultFilename ??
        filenameOverride ??
        'merged-document.pdf';

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

async function pollExportJob(statusUrl: string): Promise<PdfConversionJob> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(statusUrl, {
      credentials: 'include',
      headers: apexProjectHeaders(),
    });
    if (!response.ok)
      throw new Error(`Export status failed (HTTP ${response.status})`);
    const job = (await response.json()) as PdfConversionJob;
    if (job.status === 'completed') return job;
    if (job.status === 'failed') {
      const error = new Error(
        job.error?.message ?? 'PDF export failed.'
      ) as Error & {
        code?: string;
      };
      error.code = job.error?.code;
      throw error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
  }
  throw new Error('PDF export timed out. Please retry.');
}

export { ensurePdfExtension };
