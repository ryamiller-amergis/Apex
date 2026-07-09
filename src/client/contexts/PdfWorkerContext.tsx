import React, { createContext, useCallback, useContext, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

interface PdfWorkerContextValue {
  getDocument: (url: string) => Promise<PDFDocumentProxy>;
}

const PdfWorkerContext = createContext<PdfWorkerContextValue>({
  getDocument: () => Promise.reject(new Error('PdfWorkerProvider not mounted')),
});

export const usePdfWorker = () => useContext(PdfWorkerContext);

interface PdfWorkerProviderProps {
  children: React.ReactNode;
}

export const PdfWorkerProvider: React.FC<PdfWorkerProviderProps> = ({ children }) => {
  const documentCache = useRef<Map<string, PDFDocumentProxy>>(new Map());
  const loadingCache = useRef<Map<string, Promise<PDFDocumentProxy>>>(new Map());

  const getDocument = useCallback(async (url: string): Promise<PDFDocumentProxy> => {
    const cached = documentCache.current.get(url);
    if (cached) return cached;

    const inflight = loadingCache.current.get(url);
    if (inflight) return inflight;

    const loading = pdfjsLib.getDocument({
      url,
      disableAutoFetch: true,
      disableRange: true,
    }).promise.then(
      (doc) => {
        documentCache.current.set(url, doc);
        loadingCache.current.delete(url);
        return doc;
      },
      (err: unknown) => {
        loadingCache.current.delete(url);
        throw err;
      },
    );

    loadingCache.current.set(url, loading);
    return loading;
  }, []);

  const contextValue = React.useMemo(() => ({ getDocument }), [getDocument]);

  return (
    <PdfWorkerContext.Provider value={contextValue}>
      {children}
    </PdfWorkerContext.Provider>
  );
};
