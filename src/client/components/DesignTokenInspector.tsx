import React, { useMemo, useState } from 'react';
import { auditPrototypeColors, type DesignTokenMatch } from '../utils/designTokenAudit';
import styles from './DesignTokenInspector.module.css';

interface Props {
  html: string | null;
}

const GROUP_LABELS: Record<string, string> = {
  text: 'Text',
  background: 'Background',
  ui: 'UI / Borders',
  primary: 'Primary',
  secondary: 'Secondary',
  tertiary: 'Tertiary',
  action: 'Action',
  error: 'Error',
  info: 'Info',
  warning: 'Warning',
  success: 'Success',
};

function groupResults(matches: DesignTokenMatch[]) {
  const onPalette = matches.filter(m => m.token);
  const offPalette = matches.filter(m => !m.token);

  const grouped = new Map<string, DesignTokenMatch[]>();
  for (const m of onPalette) {
    const key = m.group ?? 'other';
    const arr = grouped.get(key);
    if (arr) arr.push(m);
    else grouped.set(key, [m]);
  }

  return { grouped, offPalette };
}

const Swatch: React.FC<{ color: string }> = ({ color }) => (
  <span
    className={styles.swatch}
    style={{ background: color }}
    title={color}
  />
);

const DesignTokenInspector: React.FC<Props> = ({ html }) => {
  const [collapsed, setCollapsed] = useState(false);

  const matches = useMemo(() => (html ? auditPrototypeColors(html) : []), [html]);
  const { grouped, offPalette } = useMemo(() => groupResults(matches), [matches]);

  if (!html) return null;

  const onPaletteCount = matches.filter(m => m.token).length;
  const totalCount = matches.length;

  const containerClass = collapsed
    ? `${styles.container} ${styles.collapsed}`
    : styles.container;

  return (
    <div className={containerClass}>
      <button
        className={styles.header}
        onClick={() => setCollapsed(c => !c)}
        type="button"
      >
        <span className={styles.headerTitle}>
          Design Tokens
        </span>
        <span className={styles.headerBadge}>
          {onPaletteCount}/{totalCount}
        </span>
        <span className={styles.chevron}>{collapsed ? '‹' : '›'}</span>
      </button>

      {!collapsed && (
        <div className={styles.body}>
          {totalCount === 0 && (
            <div className={styles.empty}>No colors detected in this prototype.</div>
          )}

          {[...grouped.entries()].map(([group, items]) => (
            <div key={group} className={styles.group}>
              <div className={styles.groupTitle}>{GROUP_LABELS[group] ?? group}</div>
              {items.map((m) => (
                <div key={m.value} className={styles.row}>
                  <Swatch color={m.value} />
                  <div className={styles.rowInfo}>
                    <div className={styles.tokenName}>{m.token}</div>
                    <div className={styles.tokenValue}>
                      {m.value}
                      {m.count > 1 && <span className={styles.tokenCount}> x{m.count}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}

          {offPalette.length > 0 && (
            <div className={styles.group}>
              <div className={`${styles.groupTitle} ${styles.offPaletteTitle}`}>
                Off-palette ({offPalette.length})
              </div>
              {offPalette.map((m) => (
                <div key={m.value} className={`${styles.row} ${styles.offPaletteRow}`}>
                  <Swatch color={m.value} />
                  <div className={styles.rowInfo}>
                    <div className={styles.tokenName}>Unmatched</div>
                    <div className={styles.tokenValue}>
                      {m.value}
                      {m.count > 1 && <span className={styles.tokenCount}> x{m.count}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DesignTokenInspector;
