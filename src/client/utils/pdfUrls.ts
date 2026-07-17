import { withApexProject } from './apiFetch';

/** Build a project-scoped PDF file URL for pdf.js / preview loads. */
export function pdfFileUrl(sessionId: string, fileId: string): string {
  return withApexProject(`/api/pdf/sessions/${sessionId}/files/${fileId}`);
}
