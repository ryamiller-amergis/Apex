import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  BOOKMARK_IMPORT_MAX_FILE_BYTES,
  PROJECT_QUICK_LINKS_MAX_PER_PROJECT,
  USER_QUICK_LINKS_MAX_PER_PROJECT,
  type CreateUserQuickLinkInput,
  type ImportQuickLinksResult,
  type QuickLinkScope,
} from '../../shared/types/projectQuickLinks';
import { useImportMyQuickLinks, useImportProjectQuickLinks } from '../hooks/useProjectQuickLinks';
import {
  BookmarkParseCancelled,
  parseBookmarksHtmlAsync,
  type ParsedBookmark,
  type ParsedBookmarks,
} from '../utils/parseBookmarksHtml';
import {
  COLLAPSE_FOLDERS_ABOVE,
  FOLDER_RENDER_LIMIT,
  alreadySavedIds,
  folderStats,
  formatCount,
  groupByFolder,
  initialSelection,
  summarizeSelection,
  withSelection,
  type BookmarkFolder,
} from '../utils/bookmarkImportSelection';
import { categoryToneClass } from './QuickLinkCategory';
import { QuickLinkCategoryField } from './QuickLinkCategoryField';
import styles from './QuickLinkModals.module.css';

const MAX_FILE_MB = BOOKMARK_IMPORT_MAX_FILE_BYTES / (1024 * 1024);

type ReadState =
  | { phase: 'idle' }
  | { phase: 'reading'; found: number }
  | { phase: 'ready'; parsed: ParsedBookmarks };

interface TriStateCheckboxProps {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  'aria-label': string;
  'data-testid': string;
}

const TriStateCheckbox: React.FC<TriStateCheckboxProps> = ({
  checked,
  indeterminate,
  disabled = false,
  onChange,
  'aria-label': ariaLabel,
  'data-testid': testId,
}) => (
  <input
    type="checkbox"
    checked={checked}
    disabled={disabled}
    ref={(el) => {
      if (el) el.indeterminate = indeterminate;
    }}
    onChange={(e) => onChange(e.target.checked)}
    aria-label={ariaLabel}
    aria-checked={indeterminate ? 'mixed' : checked}
    {...{ 'data-testid': testId }}
  />
);

interface BookmarkRowProps {
  bookmark: ParsedBookmark;
  checked: boolean;
  saved: boolean;
  onToggle: (id: string, checked: boolean) => void;
}

/** Memoized so toggling one bookmark re-renders only that row. */
const BookmarkRow = memo<BookmarkRowProps>(({ bookmark, checked, saved, onToggle }) => (
  <li>
    <label className={`${styles.bookmark} ${saved ? styles.bookmarkSaved : ''}`}>
      <input
        type="checkbox"
        checked={checked && !saved}
        disabled={saved}
        onChange={(e) => onToggle(bookmark.id, e.target.checked)}
        {...{ 'data-testid': `bookmark-import-item-${bookmark.id}` }}
      />
      <span className={styles.bookmarkText}>
        <span className={styles.bookmarkLabel}>{bookmark.label}</span>
        <span className={styles.bookmarkUrl}>{bookmark.url}</span>
      </span>
      {saved && <span className={styles.savedBadge}>Already saved</span>}
    </label>
  </li>
));
BookmarkRow.displayName = 'BookmarkRow';

interface BookmarkImportModalProps {
  project: string;
  /** True with quick-links:manage: the whole import can go to the shared project links instead. */
  canShare: boolean;
  /** URLs already saved in each destination: shown as "Already saved" and counted against the cap. */
  existingPersonalUrls: string[];
  existingProjectUrls: string[];
  personalCategories: string[];
  projectCategories: string[];
  onCancel: () => void;
  onImported: (result: ImportQuickLinksResult, scope: QuickLinkScope) => void;
  'data-testid'?: string;
}

export const BookmarkImportModal: React.FC<BookmarkImportModalProps> = ({
  project,
  canShare,
  existingPersonalUrls,
  existingProjectUrls,
  personalCategories,
  projectCategories,
  onCancel,
  onImported,
  'data-testid': testId = 'bookmark-import-modal',
}) => {
  const [readState, setReadState] = useState<ReadState>({ phase: 'idle' });
  const [fileError, setFileError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<QuickLinkScope>('personal');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  const importMine = useImportMyQuickLinks(project);
  const importShared = useImportProjectQuickLinks(project);
  const importLinks = scope === 'project' ? importShared : importMine;

  const deferredSearch = useDeferredValue(search);
  const parsed = readState.phase === 'ready' ? readState.parsed : null;
  const existingUrls = scope === 'project' ? existingProjectUrls : existingPersonalUrls;
  const cap = scope === 'project' ? PROJECT_QUICK_LINKS_MAX_PER_PROJECT : USER_QUICK_LINKS_MAX_PER_PROJECT;
  const room = Math.max(0, cap - existingUrls.length);

  const folders = useMemo(() => groupByFolder(parsed?.bookmarks ?? []), [parsed]);
  const saved = useMemo(() => alreadySavedIds(parsed?.bookmarks ?? [], existingUrls), [parsed, existingUrls]);
  const stats = useMemo(() => folderStats(folders, selected, saved), [folders, selected, saved]);
  const summary = useMemo(
    () => summarizeSelection(parsed?.bookmarks.length ?? 0, selected, saved, room),
    [parsed, selected, saved, room],
  );

  const categoryOptions = useMemo(
    () =>
      scope === 'project'
        ? projectCategories
        : Array.from(new Set([...personalCategories, ...projectCategories])).sort((a, b) => a.localeCompare(b)),
    [scope, personalCategories, projectCategories],
  );

  const query = deferredSearch.trim().toLowerCase();
  const visibleFolders = useMemo(() => {
    if (!query) return folders;
    return folders
      .map((folder) => ({
        ...folder,
        bookmarks: folder.name.toLowerCase().includes(query)
          ? folder.bookmarks
          : folder.bookmarks.filter(
            (b) => b.label.toLowerCase().includes(query) || b.url.toLowerCase().includes(query),
          ),
      }))
      .filter((folder) => folder.bookmarks.length > 0);
  }, [folders, query]);

  const visibleSelectableIds = useMemo(
    () => visibleFolders.flatMap((f) => f.bookmarks.filter((b) => !saved.has(b.id)).map((b) => b.id)),
    [visibleFolders, saved],
  );

  const onToggleRow = useCallback(
    (id: string, checked: boolean) => setSelected((prev) => withSelection(prev, [id], checked, saved)),
    [saved],
  );

  useEffect(() => {
    fileInputRef.current?.focus();
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !importLinks.isPending) onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel, importLinks.isPending]);

  const handleFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    if (file.size > BOOKMARK_IMPORT_MAX_FILE_BYTES) {
      setFileError(`That file is larger than ${MAX_FILE_MB} MB. Export bookmarks again or pick a smaller file.`);
      return;
    }
    setReadState({ phase: 'reading', found: 0 });
    try {
      const html = await file.text();
      const result = await parseBookmarksHtmlAsync(html, {
        onProgress: (found) => setReadState({ phase: 'reading', found }),
        isCancelled: () => cancelledRef.current,
      });
      if (cancelledRef.current) return;
      if (result.bookmarks.length === 0) {
        setReadState({ phase: 'idle' });
        setFileError(
          result.skipped > 0
            ? `No http or https bookmarks found (${formatCount(result.skipped)} other links skipped).`
            : 'No bookmarks found. Choose the .html file exported from your browser.',
        );
        return;
      }
      const savedNow = alreadySavedIds(result.bookmarks, existingUrls);
      setSelected(initialSelection(result.bookmarks, savedNow, room));
      setExpanded(
        result.bookmarks.length > COLLAPSE_FOLDERS_ABOVE
          ? new Set()
          : new Set(result.bookmarks.map((b) => b.folderPath.join(' / '))),
      );
      setShowAll(new Set());
      setCategories({});
      setSearch('');
      setReadState({ phase: 'ready', parsed: result });
    } catch (err) {
      if (err instanceof BookmarkParseCancelled) return;
      setReadState({ phase: 'idle' });
      setFileError('Could not read that file.');
    }
  };

  const toggleKey = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const categoryFor = (folder: BookmarkFolder) => categories[folder.key] ?? folder.defaultCategory;

  const handleImport = () => {
    if (summary.overBy > 0) return;
    const items: CreateUserQuickLinkInput[] = folders.flatMap((folder) =>
      folder.bookmarks
        .filter((b) => selected.has(b.id) && !saved.has(b.id))
        .map((b) => ({ label: b.label, url: b.url, category: categoryFor(folder).trim() || null })),
    );
    if (items.length === 0) return;
    importLinks.mutate({ items }, { onSuccess: (result) => onImported(result, scope) });
  };

  const allVisibleSelected =
    visibleSelectableIds.length > 0 && visibleSelectableIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleSelectableIds.some((id) => selected.has(id));
  const isReading = readState.phase === 'reading';

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget && !importLinks.isPending) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="bookmark-import-title"
      {...{ 'data-testid': testId }}
    >
      <div className={`${styles.card} ${styles.cardWide}`}>
        <h2 className={styles.title} id="bookmark-import-title">Import bookmarks</h2>

        {canShare && (
          <fieldset className={styles.scopeGroup} {...{ 'data-testid': 'bookmark-import-scope' }}>
            <legend className={styles.label}>Save to</legend>
            {(
              [
                ['personal', 'Only me', 'Private links under My links'],
                ['project', `Everyone in ${project}`, 'Shared links under Project links'],
              ] as const
            ).map(([value, title, hint]) => (
              <label
                key={value}
                className={`${styles.scopeOption} ${scope === value ? styles.scopeOptionActive : ''}`}
              >
                <input
                  type="radio"
                  name="bookmark-import-scope"
                  value={value}
                  className={styles.scopeRadio}
                  checked={scope === value}
                  disabled={importLinks.isPending}
                  onChange={() => setScope(value)}
                  {...{ 'data-testid': `bookmark-import-scope-${value}` }}
                />
                <span className={styles.scopeText}>
                  <span className={styles.scopeTitle}>{title}</span>
                  <span className={styles.scopeHint}>{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <div className={styles.field}>
          <p className={styles.text}>
            Browsers don&apos;t let websites read your bookmarks, so export them to a file first:
          </p>
          <ol className={styles.steps} {...{ 'data-testid': 'bookmark-import-instructions' }}>
            <li>In Chrome, open the Bookmark Manager (Ctrl+Shift+O, or ⌘+Option+B on a Mac).</li>
            <li>Click the ⋮ menu at the top right and choose <strong>Export bookmarks</strong>.</li>
            <li>Choose the saved <code>.html</code> file below. Edge and Firefox exports work too.</li>
          </ol>
          <label className={styles.label} htmlFor="bookmark-import-file">
            Bookmark file (.html, up to {MAX_FILE_MB} MB)
          </label>
          <input
            ref={fileInputRef}
            id="bookmark-import-file"
            type="file"
            accept=".html,.htm,text/html"
            disabled={isReading || importLinks.isPending}
            onChange={(e) => void handleFile(e.target.files?.[0])}
            {...{ 'data-testid': 'bookmark-import-file' }}
          />
          {isReading && (
            <p className={styles.reading} role="status" aria-live="polite" {...{ 'data-testid': 'bookmark-import-reading' }}>
              <span className={styles.spinner} aria-hidden="true" />
              Reading bookmarks…{readState.found > 0 && ` ${formatCount(readState.found)} found`}
            </p>
          )}
          {fileError && (
            <p className={styles.formError} role="alert" {...{ 'data-testid': 'bookmark-import-file-error' }}>
              {fileError}
            </p>
          )}
        </div>

        {parsed && (
          <>
            <div className={styles.previewToolbar}>
              <label className={styles.checkboxLabel}>
                <TriStateCheckbox
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected && !allVisibleSelected}
                  disabled={visibleSelectableIds.length === 0}
                  onChange={(checked) => setSelected((prev) => withSelection(prev, visibleSelectableIds, checked, saved))}
                  aria-label={query ? 'Select all matching bookmarks' : 'Select all bookmarks'}
                  data-testid="bookmark-import-select-all"
                />
                {query ? 'Select all matching' : 'Select all'}
              </label>
              <input
                type="search"
                className={`${styles.input} ${styles.search}`}
                placeholder="Search bookmarks…"
                aria-label="Search bookmarks"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                {...{ 'data-testid': 'bookmark-import-search' }}
              />
            </div>

            <p className={styles.summary} aria-live="polite" {...{ 'data-testid': 'bookmark-import-summary' }}>
              <strong>{formatCount(summary.selectedCount)}</strong> selected of {formatCount(summary.total)}
              {summary.alreadySaved > 0 && ` · ${formatCount(summary.alreadySaved)} already saved`}
              {parsed.skipped > 0 && ` · ${formatCount(parsed.skipped)} skipped (not http or https)`}
            </p>

            <div className={styles.tree} {...{ 'data-testid': 'bookmark-import-tree' }}>
              {visibleFolders.length === 0 && <p className={styles.summary}>No bookmarks match your search.</p>}
              {visibleFolders.map((folder) => {
                const folderStat = stats.get(folder.key) ?? { selectable: 0, selected: 0 };
                const visibleIds = folder.bookmarks.filter((b) => !saved.has(b.id)).map((b) => b.id);
                const isOpen = Boolean(query) || expanded.has(folder.key);
                const rows = showAll.has(folder.key) ? folder.bookmarks : folder.bookmarks.slice(0, FOLDER_RENDER_LIMIT);
                return (
                  <section
                    key={folder.key}
                    className={`${styles.folder} ${categoryToneClass(categoryFor(folder))}`}
                    aria-label={folder.name}
                    {...{ 'data-testid': `bookmark-import-folder-${folder.index}` }}
                  >
                    <div className={styles.folderHeader}>
                      <div className={styles.folderTitle}>
                        <button
                          type="button"
                          className={styles.folderToggle}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Collapse' : 'Expand'} folder ${folder.name}`}
                          disabled={Boolean(query)}
                          onClick={() => toggleKey(setExpanded, folder.key)}
                          {...{ 'data-testid': `bookmark-import-folder-expand-${folder.index}` }}
                        >
                          <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`} aria-hidden="true">▸</span>
                        </button>
                        <label className={styles.checkboxLabel}>
                          <TriStateCheckbox
                            checked={folderStat.selectable > 0 && folderStat.selected === folderStat.selectable}
                            indeterminate={folderStat.selected > 0 && folderStat.selected < folderStat.selectable}
                            disabled={folderStat.selectable === 0}
                            onChange={(checked) =>
                              setSelected((prev) => withSelection(prev, query ? visibleIds : folder.bookmarks.map((b) => b.id), checked, saved))
                            }
                            aria-label={`Select folder ${folder.name}`}
                            data-testid={`bookmark-import-folder-toggle-${folder.index}`}
                          />
                          <span className={styles.folderName}>{folder.name}</span>
                          <span className={styles.folderCount} {...{ 'data-testid': `bookmark-import-folder-count-${folder.index}` }}>
                            {formatCount(folderStat.selected)}/{formatCount(folderStat.selectable)}
                          </span>
                        </label>
                      </div>
                      <div className={styles.categoryPicker}>
                        <QuickLinkCategoryField
                          key={`${scope}-${folder.key}`}
                          id={`bookmark-import-category-${folder.index}`}
                          label={`Category for ${folder.name}`}
                          hideLabel
                          compact
                          value={categoryFor(folder)}
                          onChange={(value) => setCategories((prev) => ({ ...prev, [folder.key]: value }))}
                          options={categoryOptions}
                          data-testid={`bookmark-import-category-${folder.index}`}
                        />
                      </div>
                    </div>
                    {isOpen && (
                      <ul className={styles.bookmarkList}>
                        {rows.map((bookmark) => (
                          <BookmarkRow
                            key={bookmark.id}
                            bookmark={bookmark}
                            checked={selected.has(bookmark.id)}
                            saved={saved.has(bookmark.id)}
                            onToggle={onToggleRow}
                          />
                        ))}
                        {rows.length < folder.bookmarks.length && (
                          <li>
                            <button
                              type="button"
                              className={styles.showAll}
                              onClick={() => toggleKey(setShowAll, folder.key)}
                              {...{ 'data-testid': `bookmark-import-folder-show-all-${folder.index}` }}
                            >
                              Show all {formatCount(folder.bookmarks.length)}
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>

            {summary.overBy > 0 && (
              <p className={styles.capWarning} role="alert" {...{ 'data-testid': 'bookmark-import-cap-warning' }}>
                {room === 0
                  ? `${project} already has the most ${scope === 'project' ? 'shared' : 'personal'} links allowed (${formatCount(cap)}).`
                  : `You can add ${formatCount(room)} more ${scope === 'project' ? 'shared links' : 'links'} in ${project}.`}
                {' '}Deselect {formatCount(summary.overBy)} to import (limit {formatCount(cap)} per project).
              </p>
            )}
          </>
        )}

        {importLinks.error && (
          <p className={styles.formError} role="alert" {...{ 'data-testid': 'bookmark-import-error' }}>
            {importLinks.error.message}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={onCancel}
            disabled={importLinks.isPending}
            {...{ 'data-testid': 'bookmark-import-cancel' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            onClick={handleImport}
            disabled={!parsed || summary.selectedCount === 0 || summary.overBy > 0 || importLinks.isPending}
            {...{ 'data-testid': 'bookmark-import-confirm' }}
          >
            {importLinks.isPending
              ? 'Importing…'
              : `Import ${formatCount(summary.selectedCount)} link${summary.selectedCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BookmarkImportModal;
