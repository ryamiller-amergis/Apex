import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BOOKMARK_IMPORT_MAX_FILE_BYTES,
  USER_QUICK_LINKS_IMPORT_MAX_ITEMS,
  USER_QUICK_LINKS_MAX_PER_PROJECT,
  type CreateUserQuickLinkInput,
  type ImportUserQuickLinksResult,
} from '../../shared/types/projectQuickLinks';
import { useImportMyQuickLinks } from '../hooks/useProjectQuickLinks';
import {
  defaultCategoryFor,
  parseBookmarksHtml,
  type ParsedBookmark,
  type ParsedBookmarks,
} from '../utils/parseBookmarksHtml';
import styles from './QuickLinkModals.module.css';

const MAX_FILE_MB = BOOKMARK_IMPORT_MAX_FILE_BYTES / (1024 * 1024);

interface BookmarkFolder {
  index: number;
  key: string;
  name: string;
  defaultCategory: string;
  bookmarks: ParsedBookmark[];
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsText(file);
  });
}

function groupByFolder(bookmarks: ParsedBookmark[]): BookmarkFolder[] {
  const folders = new Map<string, BookmarkFolder>();
  for (const bookmark of bookmarks) {
    const key = bookmark.folderPath.join(' / ');
    let folder = folders.get(key);
    if (!folder) {
      folder = {
        index: folders.size,
        key,
        name: key || 'No folder',
        defaultCategory: defaultCategoryFor(bookmark.folderPath),
        bookmarks: [],
      };
      folders.set(key, folder);
    }
    folder.bookmarks.push(bookmark);
  }
  return Array.from(folders.values());
}

interface TriStateCheckboxProps {
  checked: boolean;
  indeterminate: boolean;
  onChange: (checked: boolean) => void;
  'aria-label': string;
  'data-testid': string;
}

const TriStateCheckbox: React.FC<TriStateCheckboxProps> = ({
  checked,
  indeterminate,
  onChange,
  'aria-label': ariaLabel,
  'data-testid': testId,
}) => (
  <input
    type="checkbox"
    checked={checked}
    ref={(el) => {
      if (el) el.indeterminate = indeterminate;
    }}
    onChange={(e) => onChange(e.target.checked)}
    aria-label={ariaLabel}
    aria-checked={indeterminate ? 'mixed' : checked}
    {...{ 'data-testid': testId }}
  />
);

interface BookmarkImportModalProps {
  project: string;
  /** Personal links the user already has in this project, to warn before the cap. */
  existingCount: number;
  onCancel: () => void;
  onImported: (result: ImportUserQuickLinksResult) => void;
  'data-testid'?: string;
}

export const BookmarkImportModal: React.FC<BookmarkImportModalProps> = ({
  project,
  existingCount,
  onCancel,
  onImported,
  'data-testid': testId = 'bookmark-import-modal',
}) => {
  const [parsed, setParsed] = useState<ParsedBookmarks | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importLinks = useImportMyQuickLinks(project);

  const folders = useMemo(() => groupByFolder(parsed?.bookmarks ?? []), [parsed]);

  const visibleFolders = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return folders;
    return folders
      .map((folder) => ({
        ...folder,
        bookmarks: folder.bookmarks.filter(
          (b) =>
            b.label.toLowerCase().includes(q) ||
            b.url.toLowerCase().includes(q) ||
            folder.name.toLowerCase().includes(q),
        ),
      }))
      .filter((folder) => folder.bookmarks.length > 0);
  }, [folders, search]);

  const visibleIds = useMemo(
    () => visibleFolders.flatMap((f) => f.bookmarks.map((b) => b.id)),
    [visibleFolders],
  );

  useEffect(() => {
    fileInputRef.current?.focus();
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
    try {
      const result = parseBookmarksHtml(await readFileText(file));
      if (result.bookmarks.length === 0) {
        setFileError(
          result.skipped > 0
            ? `No http or https bookmarks found (${result.skipped} other links skipped).`
            : 'No bookmarks found. Choose the .html file exported from your browser.',
        );
        return;
      }
      setParsed(result);
      setSelected(new Set(result.bookmarks.map((b) => b.id)));
      setCategories({});
      setSearch('');
    } catch {
      setFileError('Could not read that file.');
    }
  };

  const setMany = (ids: string[], checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const categoryFor = (folder: BookmarkFolder) => categories[folder.key] ?? folder.defaultCategory;

  const handleImport = () => {
    const items: CreateUserQuickLinkInput[] = folders.flatMap((folder) =>
      folder.bookmarks
        .filter((b) => selected.has(b.id))
        .map((b) => ({ label: b.label, url: b.url, category: categoryFor(folder).trim() || null })),
    );
    if (items.length === 0) return;
    importLinks.mutate({ items }, { onSuccess: onImported });
  };

  const room = Math.max(0, USER_QUICK_LINKS_MAX_PER_PROJECT - existingCount);
  const selectedCount = selected.size;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));

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
            onChange={(e) => void handleFile(e.target.files?.[0])}
            {...{ 'data-testid': 'bookmark-import-file' }}
          />
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
                  onChange={(checked) => setMany(visibleIds, checked)}
                  aria-label="Select all bookmarks"
                  data-testid="bookmark-import-select-all"
                />
                Select all
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
              {selectedCount} of {parsed.bookmarks.length} selected
              {parsed.skipped > 0 && ` · ${parsed.skipped} skipped (not http or https)`}
            </p>

            <div className={styles.tree} {...{ 'data-testid': 'bookmark-import-tree' }}>
              {visibleFolders.length === 0 && <p className={styles.summary}>No bookmarks match your search.</p>}
              {visibleFolders.map((folder) => {
                const ids = folder.bookmarks.map((b) => b.id);
                const all = ids.every((id) => selected.has(id));
                const some = ids.some((id) => selected.has(id));
                return (
                  <section
                    key={folder.key}
                    className={styles.folder}
                    aria-label={folder.name}
                    {...{ 'data-testid': `bookmark-import-folder-${folder.index}` }}
                  >
                    <div className={styles.folderHeader}>
                      <label className={styles.checkboxLabel}>
                        <TriStateCheckbox
                          checked={all}
                          indeterminate={some && !all}
                          onChange={(checked) => setMany(ids, checked)}
                          aria-label={`Select folder ${folder.name}`}
                          data-testid={`bookmark-import-folder-toggle-${folder.index}`}
                        />
                        <span className={styles.folderName}>{folder.name}</span>
                        <span className={styles.folderCount}>({folder.bookmarks.length})</span>
                      </label>
                      <input
                        className={`${styles.input} ${styles.categoryInput}`}
                        value={categoryFor(folder)}
                        onChange={(e) => setCategories((prev) => ({ ...prev, [folder.key]: e.target.value }))}
                        placeholder="No category"
                        maxLength={60}
                        aria-label={`Category for ${folder.name}`}
                        {...{ 'data-testid': `bookmark-import-category-${folder.index}` }}
                      />
                    </div>
                    <ul className={styles.bookmarkList}>
                      {folder.bookmarks.map((bookmark) => (
                        <li key={bookmark.id}>
                          <label className={styles.bookmark}>
                            <input
                              type="checkbox"
                              checked={selected.has(bookmark.id)}
                              onChange={(e) => setMany([bookmark.id], e.target.checked)}
                              {...{ 'data-testid': `bookmark-import-item-${bookmark.id}` }}
                            />
                            <span className={styles.bookmarkText}>
                              <span className={styles.bookmarkLabel}>{bookmark.label}</span>
                              <span className={styles.bookmarkUrl}>{bookmark.url}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>

            {selectedCount > room && (
              <p className={styles.warning} {...{ 'data-testid': 'bookmark-import-cap-warning' }}>
                You have room for {room} more personal links in this project (limit {USER_QUICK_LINKS_MAX_PER_PROJECT}).
                Links already saved are skipped; anything past the limit is not imported.
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
            disabled={
              !parsed
              || selectedCount === 0
              || selectedCount > USER_QUICK_LINKS_IMPORT_MAX_ITEMS
              || importLinks.isPending
            }
            {...{ 'data-testid': 'bookmark-import-confirm' }}
          >
            {importLinks.isPending ? 'Importing…' : `Import ${selectedCount} link${selectedCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BookmarkImportModal;
