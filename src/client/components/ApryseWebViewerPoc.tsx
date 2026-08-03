import React, { useRef, useState } from 'react';
import { useApryseWorkbench } from '../hooks/useApryseWorkbench';
import { env } from '../config/env';
import { NutrientWorkbenchHeader } from './NutrientWorkbenchHeader';
import { ApryseToolRail } from './ApryseToolRail';
import { NutrientFloatingToolbar } from './NutrientFloatingToolbar';
import styles from './ApryseWebViewerPoc.module.css';

/**
 * Apryse WebViewer POC with Apex-owned chrome (same shell as Nutrient).
 * Vendor header/ribbons are disabled; tools are driven via Core APIs.
 * Wave B: redaction, signatures, XLSX Spreadsheet Editor.
 */
export const ApryseWebViewerPoc: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  const licenseKey = env.VITE_APRYSE_WEBVIEWER_LICENSE_KEY.trim();

  const { state, actions } = useApryseWorkbench({
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

  const handleAddPdfFromToolbar = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void handleMergePdf(file);
    };
    input.click();
  };

  const handleSearchAndRedact = () => {
    const query = window.prompt(
      'Search text to mark for redaction (literal match):',
      ''
    );
    if (query == null) return;
    void actions.searchAndRedact?.(query, false);
  };

  if (!licenseKey) {
    return (
      <section className={styles.workbench} data-testid="apryse-webviewer-poc">
        <div className={styles.configError} role="alert">
          VITE_APRYSE_WEBVIEWER_LICENSE_KEY is not configured.
        </div>
      </section>
    );
  }

  const spreadsheetMode = state.documentKind === 'xlsx';

  return (
    <section className={styles.workbench} data-testid="apryse-webviewer-poc">
      <NutrientWorkbenchHeader
        fileName={state.fileName}
        isDirty={state.isDirty}
        isLoaded={state.isLoaded}
        isConverting={isConverting}
        currentPage={state.currentPage}
        totalPages={state.totalPages}
        status={state.status}
        error={state.error}
        accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx"
        openLabel="Open"
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

      <div className={styles.body}>
        <ApryseToolRail
          activeTool={state.activeTool}
          isLoaded={state.isLoaded}
          spreadsheetMode={spreadsheetMode}
          onSetTool={actions.setTool}
        />

        <div className={styles.canvasWrapper}>
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
              onMergePdf={handleAddPdfFromToolbar}
              onDeletePage={() => void actions.deleteCurrentPage?.()}
              onApplyRedactions={() => void actions.applyRedactions?.()}
              onSearchAndRedact={handleSearchAndRedact}
            />
          )}

          <div
            ref={containerCallback}
            className={styles.viewer}
            data-testid="apryse-webviewer-container"
          />

          {!state.isLoaded && !state.error && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon} aria-hidden="true">
                📄
              </div>
              <p className={styles.emptyTitle}>No document open</p>
              <p className={styles.emptyHint}>
                Click <strong>Open</strong> for a PDF or XLSX to start the Apryse
                POC.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
