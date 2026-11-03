import React, { useMemo, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import type { PlaybookStepTypePaletteItem } from '../../shared/types/playbook';
import {
  DEFAULT_POPULAR_STEP_TYPES,
  PLAYBOOK_STEP_GROUP_ORDER,
  stepMeta,
  type PlaybookStepMeta,
} from './playbookStepCatalog';
import styles from './PlaybookBuilder.module.css';

const POPULAR_COUNT = 3;

interface PlaybookStepLibraryProps {
  items: readonly PlaybookStepTypePaletteItem[];
  usage: Record<string, number>;
  canAuthor: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onAdd: (stepType: string) => void;
}

function rankPopular(items: readonly PlaybookStepMeta[], usage: Record<string, number>) {
  const fallbackRank = (stepType: string) => {
    const index = DEFAULT_POPULAR_STEP_TYPES.indexOf(stepType);
    return index === -1 ? DEFAULT_POPULAR_STEP_TYPES.length : index;
  };
  return [...items]
    .sort(
      (a, b) =>
        (usage[b.stepType] ?? 0) - (usage[a.stepType] ?? 0)
        || fallbackRank(a.stepType) - fallbackRank(b.stepType),
    )
    .slice(0, POPULAR_COUNT);
}

function matches(meta: PlaybookStepMeta, query: string): boolean {
  const haystack = `${meta.title} ${meta.stepType} ${meta.description} ${meta.group}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export const PlaybookStepLibrary: React.FC<PlaybookStepLibraryProps> = ({
  items,
  usage,
  canAuthor,
  collapsed,
  onToggleCollapsed,
  onAdd,
}) => {
  const [query, setQuery] = useState('');
  const steps = useMemo(() => items.map((item) => stepMeta(item.stepType)), [items]);
  const popular = useMemo(() => rankPopular(steps, usage), [steps, usage]);
  const trimmed = query.trim();
  const results = useMemo(
    () => (trimmed ? steps.filter((meta) => matches(meta, trimmed)) : steps),
    [steps, trimmed],
  );
  const grouped = useMemo(
    () =>
      PLAYBOOK_STEP_GROUP_ORDER.map((group) => ({
        group,
        steps: results.filter((meta) => meta.group === group),
      })).filter((entry) => entry.steps.length > 0),
    [results],
  );

  const dragProps = (meta: PlaybookStepMeta) => ({
    draggable: canAuthor,
    disabled: !canAuthor,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData('application/playbook-step-type', meta.stepType);
      event.dataTransfer.setData('application/playbook-step-label', meta.title);
      event.dataTransfer.effectAllowed = 'move';
    },
    onClick: () => onAdd(meta.stepType),
  });

  if (collapsed) {
    return (
      <aside className={styles.rail} aria-label="Step library">
        <button
          type="button"
          className={styles.railToggle}
          onClick={onToggleCollapsed}
          aria-label="Open step library"
          title="Open step library"
          {...{ 'data-testid': 'playbook-library-expand' }}
        >
          <PanelLeftOpen size={16} aria-hidden />
        </button>
        <span className={styles.railDivider} aria-hidden />
        {steps.map((meta) => {
          const Icon = meta.icon;
          return (
            <button
              key={meta.stepType}
              type="button"
              className={styles.railItem}
              title={`${meta.title} — ${meta.description}`}
              aria-label={`Add ${meta.title}`}
              {...{ 'data-group': meta.group, 'data-testid': `playbook-palette-rail-${meta.stepType}` }}
              {...dragProps(meta)}
            >
              <Icon size={16} aria-hidden />
            </button>
          );
        })}
      </aside>
    );
  }

  return (
    <aside className={styles.library} aria-label="Step library">
      <div className={styles.libraryHeader}>
        <span className={styles.libraryTitle}>Steps</span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onToggleCollapsed}
          aria-label="Collapse step library"
          title="Collapse"
          {...{ 'data-testid': 'playbook-library-collapse' }}
        >
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>

      <label className={styles.librarySearch}>
        <Search size={14} aria-hidden className={styles.librarySearchIcon} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search steps"
          aria-label="Search steps"
          {...{ 'data-testid': 'playbook-library-search' }}
        />
      </label>

      <div className={styles.libraryScroll}>
        {!trimmed ? (
          <section aria-labelledby="playbook-library-popular">
            <h3 id="playbook-library-popular" className={styles.libraryGroup}>Most used</h3>
            <div className={styles.popularGrid}>
              {popular.map((meta) => {
                const Icon = meta.icon;
                return (
                  <button
                    key={meta.stepType}
                    type="button"
                    className={styles.popularTile}
                    title={meta.description}
                    {...{ 'data-group': meta.group, 'data-testid': `playbook-palette-top-${meta.stepType}` }}
                    {...dragProps(meta)}
                  >
                    <span className={styles.stepGlyph} aria-hidden>
                      <Icon size={16} />
                    </span>
                    <span className={styles.popularLabel}>{meta.title}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {grouped.length === 0 ? (
          <p className={styles.libraryEmpty} {...{ 'data-testid': 'playbook-library-empty' }}>
            No steps match “{trimmed}”.
          </p>
        ) : (
          grouped.map(({ group, steps: groupSteps }) => (
            <section key={group} aria-label={group}>
              <h3 className={styles.libraryGroup}>{group}</h3>
              <ul className={styles.stepList}>
                {groupSteps.map((meta) => {
                  const Icon = meta.icon;
                  return (
                    <li key={meta.stepType}>
                      <button
                        type="button"
                        className={styles.stepRow}
                        {...{ 'data-group': meta.group, 'data-testid': `playbook-palette-${meta.stepType}` }}
                        {...dragProps(meta)}
                      >
                        <span className={styles.stepGlyph} aria-hidden>
                          <Icon size={15} />
                        </span>
                        <span className={styles.stepText}>
                          <span className={styles.stepTitle}>{meta.title}</span>
                          <span className={styles.stepDescription}>{meta.description}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      {canAuthor ? (
        <p className={styles.libraryHint}>Drag onto the canvas, or click to add.</p>
      ) : null}
    </aside>
  );
};

export default PlaybookStepLibrary;
