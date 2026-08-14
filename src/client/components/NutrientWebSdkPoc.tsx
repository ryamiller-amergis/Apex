import React, { useRef, useState } from 'react';
import { useNutrientWorkbench } from '../hooks/useNutrientWorkbench';
import { env } from '../config/env';
import { NutrientWorkbenchHeader } from './NutrientWorkbenchHeader';
import { NutrientToolRail } from './NutrientToolRail';
import { NutrientFloatingToolbar } from './NutrientFloatingToolbar';
import styles from './NutrientWebSdkPoc.module.css';

export const NutrientWebSdkPoc: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  const licenseKey = env.VITE_NUTRIENT_LICENSE_KEY.trim();

  const { state, actions } = useNutrientWorkbench({
    licenseKey,
    containerElement: containerEl,
  });

  const containerCallback = (el: HTMLDivElement | null) => {
    setContainerEl(el);
    (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  };

  const handleExportWord = async () => {
    setIsConverting(true);
    await actions.exportWord();
    setIsConverting(false);
  };

  const handleDownloadPdf = async () => {
    setIsConverting(true);
    await actions.downloadPdf();
    setIsConverting(false);
  };

  const handleMergePdf = async (file: File) => {
    setIsConverting(true);
    await actions.mergeDocument(file);
    setIsConverting(false);
  };

  return (
    <section className={styles.workbench} data-testid="nutrient-web-sdk-poc">
      {/* ── Command bar ─────────────────────────────────────────────────── */}
      <NutrientWorkbenchHeader
        fileName={state.fileName}
        isDirty={state.isDirty}
        isLoaded={state.isLoaded}
        isConverting={isConverting}
        currentPage={state.currentPage}
        totalPages={state.totalPages}
        status={state.status}
        error={state.error}
        accept=".pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
        openLabel="Open"
        openHint="Select a PDF or Word file to open, or multiple files to auto-merge"
        onLoadFiles={actions.loadDocuments}
        onPrevPage={actions.prevPage}
        onNextPage={actions.nextPage}
        onGoToPage={actions.goToPage}
        onZoomIn={actions.zoomIn}
        onZoomOut={actions.zoomOut}
        onFitPage={actions.fitPage}
        onUndo={actions.undo}
        onRedo={actions.redo}
        onOpenSearch={actions.openSearch}
        onDownloadPdf={() => void handleDownloadPdf()}
        onExportWord={() => void handleExportWord()}
        onMergePdf={(file) => void handleMergePdf(file)}
        onBack={() => {}}
      />

      {/* ── Body: tool rail + canvas ─────────────────────────────────────── */}
      <div className={styles.body}>
        <NutrientToolRail
          activeTool={state.activeTool}
          isLoaded={state.isLoaded}
          onSetTool={actions.setTool}
        />

        {/* ── Canvas ──────────────────────────────────────────────────── */}
        <div className={styles.canvasWrapper}>
          {/* Floating sub-option toolbar */}
          {state.isLoaded && (
            <NutrientFloatingToolbar
              activeTool={state.activeTool}
              isDirty={state.isDirty}
              onSaveEdits={() => void actions.saveContentEdits()}
              onDiscardEdits={() => void actions.discardContentEdits()}
              onZoomIn={actions.zoomIn}
              onZoomOut={actions.zoomOut}
              onFitPage={actions.fitPage}
              onSetHighlightColor={actions.setHighlightColor}
              onSetInkStrokeWidth={actions.setInkStrokeWidth}
              onRotateCw={() => void actions.rotateCurrentPageCw()}
              onRotateCcw={() => void actions.rotateCurrentPageCcw()}
            />
          )}

          {/* Nutrient viewer container */}
          <div
            ref={containerCallback}
            className={styles.viewer}
            data-testid="nutrient-viewer-container"
          />

          {/* Empty state */}
          {!state.isLoaded && !state.error && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>📄</div>
              <p className={styles.emptyTitle}>No document open</p>
              <p className={styles.emptyHint}>
                Click <strong>Open</strong> for a PDF or Word document. Use{' '}
                <strong>PDF</strong> to convert a Word file to PDF.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
