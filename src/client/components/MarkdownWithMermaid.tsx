import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import {
  normalizeMermaidBlocks,
  normalizeMermaidChart,
} from '../utils/mermaidMarkdown';
import { stripYamlFrontmatter } from '../utils/stripYamlFrontmatter';
import styles from './MarkdownWithMermaid.module.css';

let mermaidDiagramCounter = 0;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

/** Survives MermaidDiagram remounts (e.g. ADR poll re-renders markdown). */
type PersistedLightbox = { zoom: number; pan: { x: number; y: number } };
const openLightboxByChart = new Map<string, PersistedLightbox>();

function clampZoom(value: number): number {
  return Math.min(3, Math.max(0.5, Number(value.toFixed(2))));
}

function renderMermaid(
  chart: string,
  themeVariables: Record<string, string>
): { id: string; result: Promise<string> } {
  const id = `apex-mermaid-${mermaidDiagramCounter++}`;
  const render = async (): Promise<string> => {
    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables,
    });
    const { svg } = await mermaid.render(id, chart);
    return svg;
  };
  const result = mermaidRenderQueue.then(render, render);
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined
  );
  return { id, result };
}

function buildMermaidThemeVariables(
  source: HTMLElement | null
): Record<string, string> {
  const computed = window.getComputedStyle(source ?? document.body);
  const token = (name: string, fallback: string): string =>
    computed.getPropertyValue(name).trim() || fallback;
  const background = token('--bg-primary', '#ffffff');
  const surface = token('--bg-secondary', '#f5f5f5');
  const elevated = token('--bg-tertiary', '#e8e8e8');
  const text = token('--text-primary', '#1a1a1a');
  const muted = token('--text-secondary', '#555555');
  const border = token('--border-color', '#e0e0e0');
  const accent = token('--accent-color', '#142A67');

  return {
    background: surface,
    mainBkg: surface,
    primaryColor: elevated,
    primaryBorderColor: accent,
    primaryTextColor: text,
    secondaryColor: background,
    secondaryBorderColor: border,
    secondaryTextColor: text,
    tertiaryColor: elevated,
    tertiaryBorderColor: border,
    tertiaryTextColor: text,
    lineColor: accent,
    textColor: text,
    titleColor: text,
    nodeTextColor: text,
    edgeLabelBackground: background,
    clusterBkg: surface,
    clusterBorder: border,
    actorBkg: elevated,
    actorBorder: accent,
    actorTextColor: text,
    actorLineColor: accent,
    signalColor: accent,
    signalTextColor: text,
    labelBoxBkgColor: background,
    labelBoxBorderColor: border,
    labelTextColor: text,
    loopTextColor: text,
    noteBkgColor: elevated,
    noteTextColor: text,
    noteBorderColor: border,
    activationBkgColor: elevated,
    activationBorderColor: accent,
    sequenceNumberColor: muted,
  };
}

interface MermaidDiagramProps {
  chart: string;
}

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart }) => {
  const renderChart = normalizeMermaidChart(chart);
  const persistKey = renderChart;
  const persisted = openLightboxByChart.get(persistKey);

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const [expanded, setExpanded] = useState(() => openLightboxByChart.has(persistKey));
  const [zoom, setZoom] = useState(() => persisted?.zoom ?? 1);
  const [pan, setPan] = useState(() => persisted?.pan ?? { x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panSessionRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const titleId = useId();

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const closeLightbox = () => {
    openLightboxByChart.delete(persistKey);
    setExpanded(false);
    setIsPanning(false);
    panSessionRef.current = null;
    resetView();
  };

  const openLightbox = () => {
    openLightboxByChart.set(persistKey, { zoom, pan });
    setExpanded(true);
  };

  useEffect(() => {
    if (expanded) {
      openLightboxByChart.set(persistKey, { zoom, pan });
    }
  }, [expanded, zoom, pan, persistKey]);

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setThemeRevision((revision) => revision + 1)
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const renderAttempt = renderMermaid(
      renderChart,
      buildMermaidThemeVariables(containerRef.current)
    );
    renderAttempt.result
      .then((renderedSvg) => {
        if (!cancelled) setSvg(renderedSvg);
      })
      .catch((renderError: unknown) => {
        document.getElementById(renderAttempt.id)?.remove();
        document.getElementById(`d${renderAttempt.id}`)?.remove();
        if (!cancelled) {
          setSvg(null);
          setError(
            renderError instanceof Error
              ? renderError.message
              : 'Unable to render Mermaid diagram.'
          );
        }
      });
    return () => {
      cancelled = true;
      document.getElementById(renderAttempt.id)?.remove();
      document.getElementById(`d${renderAttempt.id}`)?.remove();
    };
  }, [renderChart, themeRevision]);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeLightbox();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((value) => clampZoom(value + 0.25));
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom((value) => clampZoom(value - 0.25));
      }
      if (event.key === '0') {
        event.preventDefault();
        resetView();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded, persistKey]);

  useEffect(() => {
    if (!expanded) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY > 0 ? -0.1 : 0.1;
      setZoom((value) => clampZoom(value + delta));
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [expanded, svg]);

  const handlePanStart = (clientX: number, clientY: number) => {
    panSessionRef.current = {
      startX: clientX,
      startY: clientY,
      originX: pan.x,
      originY: pan.y,
    };
    setIsPanning(true);
  };

  const handlePanMove = (clientX: number, clientY: number) => {
    const session = panSessionRef.current;
    if (!session) return;
    setPan({
      x: session.originX + (clientX - session.startX),
      y: session.originY + (clientY - session.startY),
    });
  };

  const endPan = () => {
    if (!panSessionRef.current) return;
    panSessionRef.current = null;
    setIsPanning(false);
  };

  const lightbox =
    expanded &&
    createPortal(
      <div
        className={styles.lightbox}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="mermaid-lightbox"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeLightbox();
        }}
      >
        <div className={styles.lightboxCard}>
          <header className={styles.lightboxHeader}>
            <div className={styles.lightboxHeading}>
              <h2 id={titleId} className={styles.lightboxTitle}>
                Diagram
              </h2>
              <p className={styles.lightboxHint}>
                Drag to pan · Ctrl + scroll to zoom
              </p>
            </div>
            <div className={styles.lightboxControls}>
              <button
                type="button"
                className={styles.zoomButton}
                onClick={() => setZoom((value) => clampZoom(value - 0.25))}
                aria-label="Zoom out"
                title="Zoom out (−)"
              >
                −
              </button>
              <span className={styles.zoomLabel} aria-live="polite">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className={styles.zoomButton}
                onClick={() => setZoom((value) => clampZoom(value + 0.25))}
                aria-label="Zoom in"
                title="Zoom in (+)"
              >
                +
              </button>
              <button
                type="button"
                className={styles.zoomButton}
                onClick={resetView}
                aria-label="Reset zoom"
                title="Reset zoom and pan (0)"
              >
                Reset
              </button>
              <button
                ref={closeRef}
                type="button"
                className={styles.closeButton}
                onClick={closeLightbox}
                aria-label="Close diagram"
              >
                Close
              </button>
            </div>
          </header>
          <div
            ref={viewportRef}
            className={`${styles.lightboxBody}${isPanning ? ` ${styles.lightboxBodyPanning}` : ''}`}
            data-testid="mermaid-pan-viewport"
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              handlePanStart(event.clientX, event.clientY);
            }}
            onMouseMove={(event) => handlePanMove(event.clientX, event.clientY)}
            onMouseUp={endPan}
            onMouseLeave={endPan}
            onTouchStart={(event) => {
              if (event.touches.length !== 1) return;
              const touch = event.touches[0];
              handlePanStart(touch.clientX, touch.clientY);
            }}
            onTouchMove={(event) => {
              if (event.touches.length !== 1) return;
              event.preventDefault();
              const touch = event.touches[0];
              handlePanMove(touch.clientX, touch.clientY);
            }}
            onTouchEnd={endPan}
            onTouchCancel={endPan}
          >
            {svg ? (
              <div
                className={`${styles.lightboxDiagram}${isPanning ? ` ${styles.lightboxDiagramPanning}` : ''}`}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <div className={styles.loading}>Rendering diagram…</div>
            )}
          </div>
        </div>
      </div>,
      document.body
    );

  if (error && !expanded) {
    return (
      <div ref={containerRef} className={styles.error}>
        <strong>Unable to render Mermaid diagram.</strong>
        <span>{error}</span>
        <pre>{chart}</pre>
      </div>
    );
  }

  if (!svg && !expanded) {
    return (
      <div ref={containerRef} className={styles.loading}>
        Rendering diagram…
      </div>
    );
  }

  return (
    <>
      {svg ? (
        <div ref={containerRef} className={styles.diagramWrap}>
          <div
            className={styles.diagram}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <button
            type="button"
            className={styles.expandButton}
            onClick={openLightbox}
            aria-label="Expand diagram"
            title="Expand diagram"
            data-testid="mermaid-expand"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
            Expand
          </button>
        </div>
      ) : (
        <div ref={containerRef} className={styles.loading}>
          Rendering diagram…
        </div>
      )}
      {lightbox}
    </>
  );
};

interface MarkdownWithMermaidProps {
  content: string;
  components?: Components;
  className?: string;
}

export const MarkdownWithMermaid: React.FC<MarkdownWithMermaidProps> = ({
  content,
  components,
  className,
}) => {
  const markdownComponents: Components = {
    ...components,
    code({ className: codeClassName, children, ...props }) {
      const language = /language-(\w+)/.exec(codeClassName ?? '')?.[1];
      if (language === 'mermaid') {
        return <MermaidDiagram chart={String(children).replace(/\n$/, '')} />;
      }
      return (
        <code className={codeClassName} {...props}>
          {children}
        </code>
      );
    },
  };

  return (
    <div className={`${styles.markdown}${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {normalizeMermaidBlocks(stripYamlFrontmatter(content))}
      </ReactMarkdown>
    </div>
  );
};
