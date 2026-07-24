import React, { useEffect, useRef, useState } from 'react';
import NutrientViewer, {
  type Instance as NutrientInstance,
} from '@nutrient-sdk/viewer';
import { env } from '../config/env';
import styles from './NutrientWebSdkPoc.module.css';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Nutrient Web SDK could not complete the operation.';
}

export const NutrientWebSdkPoc: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<NutrientInstance | null>(null);
  const fileNameRef = useRef('nutrient-output.pdf');
  const [status, setStatus] = useState(
    'Choose a PDF to start the Nutrient evaluation.'
  );
  const [error, setError] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const licenseKey = env.VITE_NUTRIENT_LICENSE_KEY.trim();

  useEffect(
    () => () => {
      const container = containerRef.current;
      if (container) NutrientViewer.unload(container);
      instanceRef.current = null;
    },
    []
  );

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    const container = containerRef.current;
    if (!file || !container) return;
    if (
      file.type !== 'application/pdf' &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      setError('Choose a PDF file.');
      return;
    }

    setError(null);
    setStatus(`Loading ${file.name}…`);
    try {
      const document = await file.arrayBuffer();
      NutrientViewer.unload(container);
      instanceRef.current = null;
      const instance = await NutrientViewer.load({
        container,
        document,
        useCDN: true,
        ...(licenseKey ? { licenseKey } : {}),
        toolbarItems: [
          ...NutrientViewer.defaultToolbarItems,
          { type: 'content-editor', dropdownGroup: 'editor' },
        ],
      });
      instanceRef.current = instance;
      fileNameRef.current = file.name;
      setStatus(`${file.name} loaded. Edit the PDF or export it to Word.`);
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    }
  };

  const handleExportWord = async () => {
    const instance = instanceRef.current;
    if (!instance) return;

    setError(null);
    setIsConverting(true);
    setStatus('Converting the edited PDF to DOCX in your browser…');
    try {
      if (instance.hasUnsavedContentEditingChanges()) {
        await instance.saveContentEditingSession();
      }
      const buffer = await instance.exportOffice({ format: 'docx' });
      const blob = new Blob([buffer], { type: DOCX_MIME });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileNameRef.current.replace(/\.pdf$/i, '') + '.docx';
      link.click();
      URL.revokeObjectURL(objectUrl);
      setStatus('DOCX export completed.');
    } catch (cause: unknown) {
      setError(errorMessage(cause));
    } finally {
      setIsConverting(false);
    }
  };

  return (
    <section className={styles.page} data-testid="nutrient-web-sdk-poc">
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Single-SDK evaluation</div>
          <h1>Nutrient Web SDK POC</h1>
          <p>
            Edit native PDF content and export the result to Word entirely in
            the browser.
          </p>
        </div>
        <a className={styles.backLink} href="/pdf-tools">
          Back to PDF tools
        </a>
      </header>

      <div className={styles.controls}>
        <label className={styles.fileLabel}>
          <span>Choose PDF for Nutrient POC</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => void handleFileChange(event)}
          />
        </label>
        <button
          type="button"
          className={styles.exportButton}
          onClick={() => void handleExportWord()}
          disabled={!instanceRef.current || isConverting}
        >
          {isConverting ? 'Converting…' : 'Export to Word'}
        </button>
        {!licenseKey && (
          <span className={styles.evaluation}>Evaluation mode</span>
        )}
        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : (
          <div className={styles.status} role="status">
            {status}
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        className={styles.viewer}
        data-testid="nutrient-viewer-container"
      />
    </section>
  );
};
