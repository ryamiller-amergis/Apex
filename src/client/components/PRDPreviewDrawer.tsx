import React, { useMemo, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './PRDPreviewDrawer.module.css';

// ── Two load-source variants ──────────────────────────────────────────────────

interface ThreadSource {
  threadId: string;
  title?: string;
}

interface WikiSource {
  project: string;
  wikiId: string;
  pagePath: string;
  wikiUrl?: string;
}

export type PRDPreviewDrawerProps = (ThreadSource | WikiSource) & {
  onClose: () => void;
  skillSettingsName?: string | null;
};

// ── Data fetchers ─────────────────────────────────────────────────────────────

interface LoadedContent {
  title: string;
  markdown: string;
  openUrl?: string;
}

async function fetchFromThread(threadId: string): Promise<LoadedContent> {
  const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/prd`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const markdown = await res.text();
  return { title: 'PRD Preview', markdown };
}

async function fetchFromWiki(
  project: string,
  wikiId: string,
  path: string,
): Promise<LoadedContent> {
  const res = await fetch(
    `/api/wiki/page?project=${encodeURIComponent(project)}&wikiId=${encodeURIComponent(wikiId)}&path=${encodeURIComponent(path)}`,
    { credentials: 'include' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  const data = await res.json() as { path: string; content: string; remoteUrl?: string; url?: string };
  return {
    title: path.split('/').pop() ?? 'PRD',
    markdown: data.content,
    openUrl: data.remoteUrl ?? data.url,
  };
}

async function savePrdEdits(threadId: string, content: string): Promise<void> {
  const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/prd`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'text/plain' },
    body: content,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}

// ── Heading anchor helper ─────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ── Table of contents ─────────────────────────────────────────────────────────

interface TocEntry {
  level: number;
  text: string;
  id: string;
}

function buildToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const seen: Record<string, number> = {};
  for (const line of markdown.split('\n')) {
    const m = line.match(/^(#{1,4})\s+(.+)$/);
    if (!m) continue;
    const text = m[2].replace(/\*\*|__|\*|_|`/g, '').trim();
    const base = slugify(text);
    const count = seen[base] ?? 0;
    seen[base] = count + 1;
    const id = count === 0 ? base : `${base}-${count}`;
    entries.push({ level: m[1].length, text, id });
  }
  return entries;
}

// ── Backlog types ─────────────────────────────────────────────────────────────

interface BacklogItem {
  id?: string;
  title: string;
  type?: string;
  module?: string;
  description?: string;
  dependencies?: string[];
  predecessors?: string[];
  testScope?: string | string[];
  wave?: number;
}

interface BacklogWave {
  wave: number;
  name?: string;
  items: BacklogItem[];
}

interface BacklogData {
  feature?: string;
  waves?: BacklogWave[];
  items?: BacklogItem[];
}

async function fetchBacklog(threadId: string): Promise<BacklogData> {
  const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}/backlog`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<BacklogData>;
}

/** Normalise flat items list or wave-grouped data into waves for display */
function normaliseBacklog(data: BacklogData): BacklogWave[] {
  if (data.waves && data.waves.length > 0) return data.waves;
  if (data.items && data.items.length > 0) {
    const waveMap = new Map<number, BacklogItem[]>();
    for (const item of data.items) {
      const w = item.wave ?? 1;
      if (!waveMap.has(w)) waveMap.set(w, []);
      waveMap.get(w)!.push(item);
    }
    return Array.from(waveMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([waveNum, items]) => ({ wave: waveNum, items }));
  }
  return [];
}

// ── Backlog view sub-component ────────────────────────────────────────────────

const BacklogView: React.FC<{ threadId: string }> = ({ threadId }) => {
  const { data, isLoading, error } = useQuery<BacklogData, Error>({
    queryKey: ['backlog-thread', threadId],
    queryFn: () => fetchBacklog(threadId),
    staleTime: 60_000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        Loading backlog…
      </div>
    );
  }

  if (error) {
    return <div className={styles.error}>Failed to load backlog: {error.message}</div>;
  }

  if (!data) return null;

  const waves = normaliseBacklog(data);

  if (waves.length === 0) {
    return <div className={styles.backlogEmpty}>No backlog items found in the generated output.</div>;
  }

  return (
    <div className={styles.backlogPane}>
      {data.feature && <div className={styles.backlogFeatureTitle}>{data.feature}</div>}
      {waves.map((wave) => (
        <div key={wave.wave} className={styles.waveBlock}>
          <div className={styles.waveHeader}>
            <span className={styles.waveBadge}>Wave {wave.wave}</span>
            {wave.name && <span className={styles.waveName}>{wave.name}</span>}
            <span className={styles.waveCount}>{wave.items.length} item{wave.items.length !== 1 ? 's' : ''}</span>
          </div>
          <div className={styles.waveItems}>
            {wave.items.map((item, idx) => {
              const deps = item.dependencies ?? item.predecessors ?? [];
              const scope = Array.isArray(item.testScope) ? item.testScope.join(', ') : item.testScope;
              return (
                <div key={item.id ?? idx} className={styles.backlogItem}>
                  <div className={styles.backlogItemHeader}>
                    {item.id && <span className={styles.backlogItemId}>{item.id}</span>}
                    <span className={styles.backlogItemType}>{item.type ?? 'Story'}</span>
                    {item.module && <span className={styles.backlogItemModule}>{item.module}</span>}
                  </div>
                  <div className={styles.backlogItemTitle}>{item.title}</div>
                  {item.description && (
                    <div className={styles.backlogItemDesc}>{item.description}</div>
                  )}
                  <div className={styles.backlogItemMeta}>
                    {deps.length > 0 && (
                      <span className={styles.backlogDeps}>
                        ← depends on: {deps.join(', ')}
                      </span>
                    )}
                    {scope && (
                      <span className={styles.backlogTestScope}>tests: {scope}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Component ─────────────────────────────────────────────────────────────────

type Tab = 'preview' | 'edit' | 'backlog';

export const PRDPreviewDrawer: React.FC<PRDPreviewDrawerProps> = (props) => {
  const isThread = 'threadId' in props;
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<Tab>('preview');
  const [draftMarkdown, setDraftMarkdown] = useState<string | null>(null);
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);

  const queryKey = isThread
    ? ['prd-thread', props.threadId]
    : ['wiki-page', props.project, props.wikiId, props.pagePath];

  const { data, isLoading, error } = useQuery<LoadedContent, Error>({
    queryKey,
    queryFn: isThread
      ? () => fetchFromThread(props.threadId)
      : () => fetchFromWiki(props.project, props.wikiId, props.pagePath),
    staleTime: 60_000,
    retry: 1,
  });

  // When data first loads, seed the draft with the fetched content
  const currentMarkdown = draftMarkdown ?? data?.markdown ?? '';

  const saveMutation = useMutation<void, Error, string>({
    mutationFn: (content) => savePrdEdits((props as ThreadSource).threadId, content),
    onSuccess: (_, content) => {
      // Update the query cache so Preview re-renders immediately
      queryClient.setQueryData<LoadedContent>(queryKey, (old) =>
        old ? { ...old, markdown: content } : old,
      );
      setDraftMarkdown(null);
      setHasUnsavedEdits(false);
      setActiveTab('preview');
    },
  });

  const handleDraftChange = useCallback((value: string) => {
    setDraftMarkdown(value);
    setHasUnsavedEdits(value !== (data?.markdown ?? ''));
  }, [data?.markdown]);

  const handleSaveEdits = () => {
    if (!isThread) return;
    saveMutation.mutate(currentMarkdown);
  };

  const handleDiscardEdits = () => {
    setDraftMarkdown(null);
    setHasUnsavedEdits(false);
    setActiveTab('preview');
  };

  const title = data?.title ?? (isThread ? (props.title ?? 'PRD Preview') : (props as WikiSource).pagePath.split('/').pop() ?? 'PRD');
  const openUrl = data?.openUrl ?? (!isThread ? (props as WikiSource).wikiUrl : undefined);

  const toc = useMemo(() => (data?.markdown ? buildToc(data.markdown) : []), [data?.markdown]);

  return (
    <>
      <div className={styles.overlay} onClick={props.onClose} aria-hidden="true" />
      <div
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prd-drawer-title"
      >
        {/* ── Header ── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerIcon}>📄</div>
            <div>
              <h2 className={styles.title} id="prd-drawer-title">{title}</h2>
              {isThread && (
                <div className={styles.meta}>
                  Thread {(props as ThreadSource).threadId.slice(0, 8)}
                  {hasUnsavedEdits && <span className={styles.unsavedBadge}>● unsaved</span>}
                </div>
              )}
              {!isThread && <div className={styles.meta}>{(props as WikiSource).pagePath}</div>}
              {props.skillSettingsName && (
                <span className={styles.repoBadge}>{props.skillSettingsName}</span>
              )}
            </div>
          </div>
          <div className={styles.headerActions}>
            {isThread && data?.markdown && (
              <a
                className={styles.actionBtn}
                href={`/api/chat/threads/${(props as ThreadSource).threadId}/prd`}
                download="prd.md"
              >
                ↓ Download
              </a>
            )}
            {openUrl && (
              <a className={styles.actionBtn} href={openUrl} target="_blank" rel="noopener noreferrer">
                Open in ADO ↗
              </a>
            )}
            <button className={styles.closeBtn} onClick={props.onClose} aria-label="Close PRD preview">
              ✕
            </button>
          </div>
        </div>

        {/* ── Tab bar (only for thread source where editing makes sense) ── */}
        {isThread && data?.markdown && (
          <div className={styles.tabBar}>
            <button
              className={`${styles.tab} ${activeTab === 'preview' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('preview')}
            >
              Preview
            </button>
            <button
              className={`${styles.tab} ${activeTab === 'edit' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('edit')}
            >
              Edit{hasUnsavedEdits ? ' ●' : ''}
            </button>
            <button
              className={`${styles.tab} ${activeTab === 'backlog' ? styles.tabActive : ''}`}
              onClick={() => setActiveTab('backlog')}
            >
              Backlog / Waves
            </button>

            {activeTab === 'edit' && (
              <div className={styles.editActions}>
                <button
                  className={styles.discardBtn}
                  onClick={handleDiscardEdits}
                  disabled={saveMutation.isPending}
                >
                  Discard
                </button>
                <button
                  className={styles.applyBtn}
                  onClick={handleSaveEdits}
                  disabled={!hasUnsavedEdits || saveMutation.isPending}
                >
                  {saveMutation.isPending ? 'Saving…' : 'Apply changes'}
                </button>
              </div>
            )}

            {saveMutation.error && (
              <span className={styles.saveError}>{saveMutation.error.message}</span>
            )}
          </div>
        )}

        {/* ── Content area ── */}
        <div className={styles.layout}>
          {/* TOC sidebar — only in preview mode */}
          {activeTab === 'preview' && toc.length > 1 && (
            <nav className={styles.toc} aria-label="Table of contents">
              <div className={styles.tocTitle}>Contents</div>
              <ul className={styles.tocList}>
                {toc.map((entry) => (
                  <li key={entry.id} className={styles[`tocLevel${entry.level}` as keyof typeof styles]}>
                    <a className={styles.tocLink} href={`#${entry.id}`}>
                      {entry.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          {/* Body */}
          <div className={activeTab === 'edit' ? styles.editorPane : styles.body}>
            {/* Backlog tab — full-width, skip PRD loading states */}
            {activeTab === 'backlog' && isThread && (
              <BacklogView threadId={(props as ThreadSource).threadId} />
            )}

            {activeTab !== 'backlog' && isLoading && (
              <div className={styles.loading}>
                <div className={styles.spinner} />
                Loading PRD…
              </div>
            )}
            {activeTab !== 'backlog' && error && (
              <div className={styles.error}>
                Failed to load PRD: {error.message}
              </div>
            )}

            {/* Preview tab */}
            {activeTab === 'preview' && currentMarkdown && (
              <div className={styles.prose}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children, ...rest }) => <h1 id={slugify(String(children))} {...rest}>{children}</h1>,
                    h2: ({ children, ...rest }) => <h2 id={slugify(String(children))} {...rest}>{children}</h2>,
                    h3: ({ children, ...rest }) => <h3 id={slugify(String(children))} {...rest}>{children}</h3>,
                    h4: ({ children, ...rest }) => <h4 id={slugify(String(children))} {...rest}>{children}</h4>,
                  }}
                >
                  {currentMarkdown}
                </ReactMarkdown>
              </div>
            )}

            {/* Edit tab */}
            {activeTab === 'edit' && (
              <div className={styles.editorWrapper}>
                <div className={styles.editorHint}>
                  Edit the markdown below. Click <strong>Apply changes</strong> to save and return to preview.
                </div>
                <textarea
                  className={styles.editor}
                  value={currentMarkdown}
                  onChange={(e) => handleDraftChange(e.target.value)}
                  spellCheck={false}
                  aria-label="PRD markdown editor"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
