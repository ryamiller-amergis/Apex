import React, { useCallback, useState } from 'react';
import { diagramDownloadFilename, downloadBlob } from '../utils/diagramDownload';
import styles from './DiagramExportMenu.module.css';

export interface DiagramExportMenuProps {
  title: string;
  exportPng: () => Promise<Blob>;
  exportSvg: () => Promise<SVGSVGElement>;
  exportNativeJson: () => Promise<string>;
  'data-testid'?: string;
}

function serializeSvg(svg: SVGSVGElement): Blob {
  const markup = new XMLSerializer().serializeToString(svg);
  return new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
}

export const DiagramExportMenu: React.FC<DiagramExportMenuProps> = ({
  title,
  exportPng,
  exportSvg,
  exportNativeJson,
  'data-testid': testId = 'diagram-export-menu',
}) => {
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const runExport = useCallback(
    async (format: 'png' | 'svg' | 'excalidraw') => {
      setError(null);
      setIsExporting(true);
      try {
        if (format === 'png') {
          const blob = await exportPng();
          downloadBlob(diagramDownloadFilename(title, 'png'), blob);
          return;
        }
        if (format === 'svg') {
          const svg = await exportSvg();
          downloadBlob(diagramDownloadFilename(title, 'svg'), serializeSvg(svg));
          return;
        }
        const json = await exportNativeJson();
        downloadBlob(
          diagramDownloadFilename(title, 'excalidraw'),
          new Blob([json], { type: 'application/json' }),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Export failed');
      } finally {
        setIsExporting(false);
      }
    },
    [exportNativeJson, exportPng, exportSvg, title],
  );

  return (
    <div className={styles.menu} aria-label="Export Diagram" {...{ 'data-testid': testId }}>
      <button
        type="button"
        className={styles.exportBtn}
        disabled={isExporting}
        onClick={() => { void runExport('png'); }}
        aria-label="Export as PNG"
        {...{ 'data-testid': 'diagram-export-png' }}
      >
        PNG
      </button>
      <button
        type="button"
        className={styles.exportBtn}
        disabled={isExporting}
        onClick={() => { void runExport('svg'); }}
        aria-label="Export as SVG"
        {...{ 'data-testid': 'diagram-export-svg' }}
      >
        SVG
      </button>
      <button
        type="button"
        className={styles.exportBtn}
        disabled={isExporting}
        onClick={() => { void runExport('excalidraw'); }}
        aria-label="Export as Excalidraw"
        {...{ 'data-testid': 'diagram-export-excalidraw' }}
      >
        .excalidraw
      </button>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
};

export default DiagramExportMenu;
