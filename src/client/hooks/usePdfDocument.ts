import { useState, useEffect } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePdfWorker } from '../contexts/PdfWorkerContext';

export function usePdfDocument(fileUrl: string | null) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { getDocument } = usePdfWorker();

  useEffect(() => {
    if (!fileUrl) {
      setDocument(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setDocument(null);
    setIsLoading(true);
    setError(null);

    getDocument(fileUrl)
      .then((doc) => {
        if (!cancelled) {
          setDocument(doc);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setDocument(null);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileUrl, getDocument]);

  return { document, isLoading, error };
}
