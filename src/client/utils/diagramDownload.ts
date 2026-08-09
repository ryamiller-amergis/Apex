import { sanitizeArtifactName } from './artifactDownload';

/**
 * Builds a filesystem-safe download filename from a Diagram title + extension.
 */
export function diagramDownloadFilename(title: string, extension: string): string {
  const ext = extension.replace(/^\./, '');
  const base = sanitizeArtifactName(title, 'diagram');
  return `${base}.${ext}`;
}

/**
 * Triggers a browser file download for an in-memory Blob.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
