import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import {
  normalizeMermaidBlocks,
  normalizeMermaidChart,
} from '../utils/mermaidMarkdown';
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
  const containerRef = useRef<HTMLDivElement | null>(null);
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
    <div
      ref={containerRef}
      className={styles.diagram}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
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
        {normalizeMermaidBlocks(content)}
      </ReactMarkdown>
    </div>
  );
};
