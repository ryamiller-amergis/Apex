import React, { useEffect, useId, useRef, useState } from 'react';
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
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const renderChart = normalizeMermaidChart(chart);

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setThemeRevision((revision) => revision + 1)
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'style'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
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
        if (!cancelled)
          setError(
            renderError instanceof Error
              ? renderError.message
              : 'Unable to render Mermaid diagram.'
          );
      });
    return () => {
      cancelled = true;
      document.getElementById(renderAttempt.id)?.remove();
      document.getElementById(`d${renderAttempt.id}`)?.remove();
    };
  }, [renderChart, themeRevision]);

  useEffect(() => {
    if (!expanded) {
      setZoom(1);
      return;
    }
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((value) => Math.min(3, Number((value + 0.25).toFixed(2))));
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        setZoom((value) => Math.max(0.5, Number((value - 0.25).toFixed(2))));
      }
      if (event.key === '0') {
        event.preventDefault();
        setZoom(1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  if (error) {
    return (
      <div ref={containerRef} className={styles.error}>
        <strong>Unable to render Mermaid diagram.</strong>
        <span>{error}</span>
        <pre>{chart}</pre>
      </div>
    );
  }
  if (!svg)
    return (
      <div ref={containerRef} className={styles.loading}>
        Rendering diagram…
      </div>
    );

  return (
    <>
      <div ref={containerRef} className={styles.diagramWrap}>
        <div
          className={styles.diagram}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <button
          type="button"
          className={styles.expandButton}
          onClick={() => setExpanded(true)}
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

      {expanded && (
        <div
          className={styles.lightbox}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="mermaid-lightbox"
          onClick={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
        >
          <div className={styles.lightboxCard}>
            <header className={styles.lightboxHeader}>
              <h2 id={titleId} className={styles.lightboxTitle}>
                Diagram
              </h2>
              <div className={styles.lightboxControls}>
                <button
                  type="button"
                  className={styles.zoomButton}
                  onClick={() =>
                    setZoom((value) =>
                      Math.max(0.5, Number((value - 0.25).toFixed(2)))
                    )
                  }
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
                  onClick={() =>
                    setZoom((value) =>
                      Math.min(3, Number((value + 0.25).toFixed(2)))
                    )
                  }
                  aria-label="Zoom in"
                  title="Zoom in (+)"
                >
                  +
                </button>
                <button
                  type="button"
                  className={styles.zoomButton}
                  onClick={() => setZoom(1)}
                  aria-label="Reset zoom"
                  title="Reset zoom (0)"
                >
                  Reset
                </button>
                <button
                  ref={closeRef}
                  type="button"
                  className={styles.closeButton}
                  onClick={() => setExpanded(false)}
                  aria-label="Close diagram"
                >
                  Close
                </button>
              </div>
            </header>
            <div className={styles.lightboxBody}>
              <div
                className={styles.lightboxDiagram}
                style={{ transform: `scale(${zoom})` }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            </div>
          </div>
        </div>
      )}
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
