import React, { useEffect, useRef, useState } from 'react';
import WebViewer from '@pdftron/webviewer';
import { env } from '../config/env';
import styles from './ApryseWebViewerPoc.module.css';

type ApryseWebViewerInstance = Awaited<ReturnType<typeof WebViewer.Iframe>>;

function loadErrorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (
    cause &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof cause.message === 'string'
  ) {
    return cause.message;
  }
  return 'Apryse could not load the PDF.';
}

export const ApryseWebViewerPoc: React.FC = () => {
  const viewerHostRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<ApryseWebViewerInstance | null>(null);
  const currentFileNameRef = useRef<string | null>(null);
  const [status, setStatus] = useState('Initializing Apryse WebViewer…');
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const licenseKey = env.VITE_APRYSE_WEBVIEWER_LICENSE_KEY.trim();

  useEffect(() => {
    const viewerHost = viewerHostRef.current;
    if (!licenseKey || !viewerHost) return;
    const viewerElement = document.createElement('div');
    viewerElement.className = styles.viewerInstance;
    viewerHost.replaceChildren(viewerElement);

    let cancelled = false;
    let removeDocumentListeners: (() => void) | null = null;
    WebViewer.Iframe(
      {
        path: '/apryse-webviewer/lib',
        licenseKey,
        fullAPI: true,
        backendType: WebViewer.BackendTypes.WASM,
      },
      viewerElement
    )
      .then((instance) => {
        if (cancelled) {
          instance.UI.dispose();
          return;
        }
        instanceRef.current = instance;
        instance.UI.enableFeatures([instance.UI.Feature.ContentEdit]);
        instance.UI.setToolbarGroup(instance.UI.ToolbarGroup.EDIT);
        const handleDocumentLoaded = () => {
          if (cancelled) return;
          const pageCount = instance.Core.documentViewer.getPageCount();
          if (pageCount < 1) {
            setError('Apryse loaded the file but found no PDF pages.');
            return;
          }
          setError(null);
          instance.Core.documentViewer.setCurrentPage(1, true);
          instance.UI.setFitMode(instance.UI.FitMode.FitPage);
          setStatus(
            `${currentFileNameRef.current ?? 'PDF'} loaded (${pageCount} ${pageCount === 1 ? 'page' : 'pages'}). Rendering…`
          );
        };
        const handleFinishedRendering = () => {
          if (cancelled) return;
          setStatus(
            `${currentFileNameRef.current ?? 'PDF'} rendered. Use Edit Text, then Download.`
          );
        };
        const handleLoadError = (cause: unknown) => {
          if (cancelled) return;
          setError(loadErrorMessage(cause));
        };
        instance.Core.documentViewer.addEventListener(
          'documentLoaded',
          handleDocumentLoaded
        );
        instance.Core.documentViewer.addEventListener(
          'loadError',
          handleLoadError
        );
        instance.Core.documentViewer.addEventListener(
          'finishedRendering',
          handleFinishedRendering
        );
        removeDocumentListeners = () => {
          instance.Core.documentViewer.removeEventListener(
            'documentLoaded',
            handleDocumentLoaded
          );
          instance.Core.documentViewer.removeEventListener(
            'loadError',
            handleLoadError
          );
          instance.Core.documentViewer.removeEventListener(
            'finishedRendering',
            handleFinishedRendering
          );
        };
        setIsReady(true);
        setStatus('Apryse WebViewer is ready.');
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : 'Apryse WebViewer failed to initialize.'
        );
        setIsReady(false);
      });

    return () => {
      cancelled = true;
      removeDocumentListeners?.();
      instanceRef.current?.UI.dispose();
      instanceRef.current = null;
      viewerElement.remove();
    };
  }, [licenseKey]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (
      file.type !== 'application/pdf' &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      setError('Choose a PDF file.');
      return;
    }
    const instance = instanceRef.current;
    if (!instance) {
      setError('Apryse WebViewer is not ready yet.');
      return;
    }

    setError(null);
    currentFileNameRef.current = file.name;
    setStatus(`Loading ${file.name}…`);
    try {
      instance.UI.loadDocument(file, { filename: file.name });
    } catch (cause: unknown) {
      setError(loadErrorMessage(cause));
    }
  };

  const configurationError = !licenseKey
    ? 'VITE_APRYSE_WEBVIEWER_LICENSE_KEY is not configured.'
    : null;

  return (
    <section className={styles.page} data-testid="apryse-webviewer-poc">
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>PDF editing evaluation</div>
          <h1>Apryse WebViewer POC</h1>
          <p>
            Upload a non-sensitive PDF, use Edit Text, then download the edited
            file from the WebViewer toolbar.
          </p>
        </div>
        <a className={styles.backLink} href="/pdf-tools">
          Back to PDF tools
        </a>
      </header>

      <div className={styles.controls}>
        <label className={styles.fileLabel}>
          <span>Choose PDF for Apryse POC</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={handleFileChange}
            disabled={Boolean(configurationError) || !isReady}
          />
        </label>
        {configurationError || error ? (
          <div className={styles.error} role="alert">
            {configurationError ?? error}
          </div>
        ) : (
          <div className={styles.status} role="status">
            {status}
          </div>
        )}
      </div>

      <div
        ref={viewerHostRef}
        className={styles.viewer}
        data-testid="apryse-webviewer-container"
      />
    </section>
  );
};
