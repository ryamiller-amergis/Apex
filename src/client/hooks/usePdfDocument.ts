import { useState, useEffect, useRef, useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePdfWorker } from '../contexts/PdfWorkerContext';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export function usePdfDocument(fileUrl: string | null) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const [retryTrigger, setRetryTrigger] = useState(0);

  const { getDocument } = usePdfWorker();

  useEffect(() => {
    if (!fileUrl) {
      setDocument(null);
      setIsLoading(false);
      setError(null);
      retryCountRef.current = 0;
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    getDocument(fileUrl)
      .then((doc) => {
        if (!cancelled) {
          setDocument(doc);
          setIsLoading(false);
          retryCountRef.current = 0;
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          if (retryCountRef.current < MAX_RETRIES) {
            retryCountRef.current += 1;
            retryTimerRef.current = window.setTimeout(() => {
              if (!cancelled) {
                setRetryTrigger((n) => n + 1);
              }
            }, RETRY_DELAY_MS);
          } else {
            setError(err instanceof Error ? err.message : String(err));
            setDocument(null);
            setIsLoading(false);
          }
        }
      });

    return () => {
      cancelled = true;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [fileUrl, getDocument, retryTrigger]);

  const retry = useCallback(() => {
    retryCountRef.current = 0;
    setRetryTrigger((n) => n + 1);
  }, []);

  return { document, isLoading, error, retry };
}
