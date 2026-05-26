import React, { useState, useMemo, useCallback } from 'react';
import type { ValidationScorecard, ValidationScorecardGap } from '../../shared/types/interview';
import styles from './FixValidationPanel.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContentSnapshot {
  design: string;
  techSpec: string;
  assumptions: string;
  capturedAt: string;
  fixThreadId?: string;
}

type SectionId = 'design' | 'tech-spec' | 'assumptions';

type GapVerdict = 'pending' | 'addressed' | 'not-addressed';
type SectionDecision = 'pending' | 'accepted' | 'reverted';

interface WordSpan {
  type: 'unchanged' | 'added' | 'removed';
  text: string;
}

interface DiffLine {
  type: 'added' | 'removed' | 'context';
  lineNum: number | null;
  text: string;
  /** Word-level spans — present when this line is part of a modified pair. */
  spans?: WordSpan[];
}

interface GapWithMeta extends ValidationScorecardGap {
  featureTitle: string;
  featureSlug: string;
  sectionId: SectionId;
}

interface SectionGroup {
  sectionId: SectionId;
  label: string;
  gaps: GapWithMeta[];
  hasChanges: boolean;
}

export interface GapChangeEntry {
  gap_id: string;
  what_changed: string;
  /** Verbatim original text the agent replaced for this gap (empty string = pure addition). */
  old_text?: string;
  /** Verbatim new text the agent wrote for this gap. */
  new_text?: string;
}

interface FixValidationPanelProps {
  baseline: ContentSnapshot;
  currentDesign: string;
  currentTechSpec: string;
  currentAssumptions: string;
  scorecard: ValidationScorecard | null | undefined;
  gapChanges: GapChangeEntry[];
  agentError?: string;
  isApplying: boolean;
  isReverting: boolean;
  onAcceptSection: (section: SectionId) => void;
  onRevertSection: (section: SectionId) => void;
  onDiscuss: (section: SectionId) => void;
  onApplyAndRevalidate: () => void;
  onRevertAll: () => void;
  onCancel: () => void;
  onRetry?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapGapToSection(gap: ValidationScorecardGap): SectionId {
  const s = gap.section.toLowerCase();
  if (s.includes('tech') || s.includes('spec')) return 'tech-spec';
  if (s.includes('assumption')) return 'assumptions';
  return 'design';
}

const sectionLabels: Record<SectionId, string> = {
  'design': 'Design',
  'tech-spec': 'Tech Spec',
  'assumptions': 'Assumptions',
};

function scoreColor(score: number): string {
  if (score <= 1) return 'var(--error-color)';
  if (score === 2) return '#d97706';
  return 'var(--success-color)';
}

// ── Word-level diff helpers ────────────────────────────────────────────────────

function computeWordLevelDiff(oldText: string, newText: string): WordSpan[] {
  const tokenize = (t: string): string[] => t.match(/\S+|\s+/g) ?? [];
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  const m = oldTokens.length;
  const n = newTokens.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldTokens[i - 1] === newTokens[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const spans: WordSpan[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
      spans.unshift({ type: 'unchanged', text: oldTokens[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      spans.unshift({ type: 'added', text: newTokens[j - 1] });
      j--;
    } else {
      spans.unshift({ type: 'removed', text: oldTokens[i - 1] });
      i--;
    }
  }
  // Don't highlight whitespace-only differences — they're noise
  return spans.map((s) =>
    /^\s+$/.test(s.text) ? { ...s, type: 'unchanged' as const } : s,
  );
}

/**
 * GitHub-style annotation: for each adjacent (removed, added) pair, compute
 * a word-level diff and attach filtered spans to BOTH lines.
 *
 * - Removed row spans: 'unchanged' + 'removed' tokens  → dark-red chips on red row
 * - Added row spans:   'unchanged' + 'added'   tokens  → dark-green chips on green row
 *
 * Both rows are kept; only the chip highlights differ.
 */
function annotateAdjacentPairs(lines: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'removed') {
      result.push(lines[i]);
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'removed') {
      removed.push(lines[i++]);
    }
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'added') {
      added.push(lines[i++]);
    }
    const pairs = Math.min(removed.length, added.length);
    for (let p = 0; p < pairs; p++) {
      const wordDiff = computeWordLevelDiff(removed[p].text, added[p].text);
      result.push({
        ...removed[p],
        spans: wordDiff.filter((s) => s.type !== 'added'),
      });
      result.push({
        ...added[p],
        spans: wordDiff.filter((s) => s.type !== 'removed'),
      });
    }
    for (let p = pairs; p < removed.length; p++) result.push(removed[p]);
    for (let p = pairs; p < added.length; p++) result.push(added[p]);
  }
  return result;
}


// ── Simple line-by-line unified diff ──────────────────────────────────────────

/** Normalize a line for comparison purposes: trim and collapse runs of whitespace. */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = normalizeLine(oldLines[i - 1]) === normalizeLine(newLines[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const stack: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && normalizeLine(oldLines[i - 1]) === normalizeLine(newLines[j - 1])) {
      stack.push({ type: 'context', lineNum: j, text: newLines[j - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: 'added', lineNum: j, text: newLines[j - 1] });
      j--;
    } else {
      stack.push({ type: 'removed', lineNum: i, text: oldLines[i - 1] });
      i--;
    }
  }

  stack.reverse();

  const hasChanges = stack.some((l) => l.type !== 'context');
  if (!hasChanges) return [];

  const changeIndices = new Set<number>();
  for (let idx = 0; idx < stack.length; idx++) {
    if (stack[idx].type !== 'context') changeIndices.add(idx);
  }

  const result: DiffLine[] = [];
  let lastIncluded = -10;
  for (let idx = 0; idx < stack.length; idx++) {
    const nearChange = [...changeIndices].some((ci) => Math.abs(ci - idx) <= 3);
    if (stack[idx].type !== 'context' || nearChange) {
      if (idx - lastIncluded > 1 && lastIncluded >= 0) {
        result.push({ type: 'context', lineNum: null, text: '···' });
      }
      result.push(stack[idx]);
      lastIncluded = idx;
    }
  }

  return annotateAdjacentPairs(result);
}

// ── Diff Renderer ─────────────────────────────────────────────────────────────

const DiffView: React.FC<{
  oldText: string;
  newText: string;
  changesOnly?: boolean;
}> = ({ oldText, newText, changesOnly }) => {
  const lines = useMemo(() => {
    const all = computeUnifiedDiff(oldText, newText);
    return changesOnly ? all.filter((l) => l.type === 'added' || l.type === 'removed') : all;
  }, [oldText, newText, changesOnly]);

  if (lines.length === 0) {
    return (
      <div className={styles.diffNoChanges}>
        <svg className={styles.diffNoChangesIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        No changes in this section
      </div>
    );
  }

  return (
    <table className={styles.diffTable}>
      <tbody>
        {lines.map((line, idx) => (
          <tr
            key={idx}
            className={
              line.type === 'added' ? styles.diffLineAdded :
              line.type === 'removed' ? styles.diffLineRemoved :
              styles.diffLineContext
            }
          >
            <td className={styles.diffLineNum}>
              {line.lineNum ?? ''}
            </td>
            <td className={styles.diffLineContent}>
              <span className={`${styles.diffPrefix} ${
                line.type === 'added' ? styles.diffPrefixAdd :
                line.type === 'removed' ? styles.diffPrefixRemove : ''
              }`}>
                {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
              </span>
              {line.spans ? (
                line.spans.map((span, si) => (
                  <span
                    key={si}
                    className={
                      span.type === 'removed' ? styles.wordRemoved :
                      span.type === 'added' ? styles.wordAdded : ''
                    }
                  >
                    {span.text}
                  </span>
                ))
              ) : (
                line.text
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ── Section Review Page ───────────────────────────────────────────────────────

const SectionReview: React.FC<{
  group: SectionGroup;
  baselineContent: string;
  currentContent: string;
  gapVerdicts: Record<string, GapVerdict>;
  gapChangesMap: Record<string, string>;
  gapChangeEntries: GapChangeEntry[];
  sectionDecision: SectionDecision;
  onGapVerdict: (gapId: string, verdict: GapVerdict) => void;
  onAcceptSection: () => void;
  onRevertSection: () => void;
  onDiscuss: () => void;
  isReverting: boolean;
}> = ({
  group,
  baselineContent,
  currentContent,
  gapVerdicts,
  gapChangesMap,
  gapChangeEntries,
  sectionDecision,
  onGapVerdict,
  onAcceptSection,
  onRevertSection,
  onDiscuss,
  isReverting,
}) => {
  const addressedCount = group.gaps.filter((g) => gapVerdicts[g.id] === 'addressed').length;
  const notAddressedCount = group.gaps.filter((g) => gapVerdicts[g.id] === 'not-addressed').length;

  return (
    <div className={styles.sectionReview}>
      {/* Gap checklist for this section */}
      <div className={styles.gapChecklist}>
        <div className={styles.gapChecklistHeader}>
          Gaps in this section
          <span className={styles.gapChecklistCount}>
            {addressedCount + notAddressedCount} / {group.gaps.length} reviewed
          </span>
        </div>
        <div className={styles.gapChecklistList}>
          {group.gaps.map((gap) => {
            const verdict = gapVerdicts[gap.id] ?? 'pending';
            const hasChanges = !!gapChangesMap[gap.id];
            return (
              <div key={gap.id} className={`${styles.gapChecklistItem} ${
                verdict === 'addressed' ? styles.gapItemAddressed :
                verdict === 'not-addressed' ? styles.gapItemNotAddressed : ''
              }`}>
                <div className={styles.gapItemTop}>
                  <div className={styles.gapItemInfo}>
                    <span className={styles.gapItemFeature}>{gap.featureTitle}</span>
                    <span className={styles.gapItemScoreBadge} style={{ color: scoreColor(gap.score) }}>
                      {gap.score}/3
                    </span>
                  </div>
                  <div className={styles.gapItemDesc}>{gap.description}</div>
                </div>

                {/* Per-gap changes: agent description + changed lines from section diff */}
                {(hasChanges || group.hasChanges) && (() => {
                  const entry = gapChangeEntries.find((e) => e.gap_id === gap.id);
                  const hasExactOldNew = !!(entry?.new_text);
                  const describedButNotApplied = hasChanges && !group.hasChanges && !hasExactOldNew;

                  return (
                    <details className={styles.gapChangeDetails} open>
                      <summary className={styles.gapChangeDetailsSummary}>
                        <svg className={styles.gapChangeChevron} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 6l4 4 4-4" />
                        </svg>
                        Changes made for this gap
                      </summary>
                      {hasChanges && (
                        <div className={styles.gapChangeMarkdownWrap}>
                          <p className={styles.gapChangeSummary}>
                            {gapChangesMap[gap.id]
                              .split('\n')
                              .map((l) => l.replace(/^#+\s*/, '').trim())
                              .find((l) => l.length > 0) ?? gapChangesMap[gap.id]}
                          </p>
                        </div>
                      )}
                      {describedButNotApplied && (
                        <div className={styles.gapChangeWarning}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 14, height: 14, flexShrink: 0 }}>
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                          </svg>
                          <span>Apex described this change but did not save it to the document. The section content is unchanged. Try running the fix again.</span>
                        </div>
                      )}
                      {hasExactOldNew && (
                        <div className={styles.gapChangeDiffWrap}>
                          <DiffView
                            oldText={entry!.old_text ?? ''}
                            newText={entry!.new_text!}
                          />
                        </div>
                      )}
                      {!hasExactOldNew && group.hasChanges && (
                        <div className={styles.gapChangeDiffWrap}>
                          <DiffView
                            oldText={baselineContent}
                            newText={currentContent}
                            changesOnly
                          />
                        </div>
                      )}
                    </details>
                  );
                })()}

                {/* What a 3 looks like — collapsed reference */}
                <details className={styles.gapItemDetails}>
                  <summary className={styles.gapItemDetailsSummary}>What a 3 looks like</summary>
                  <div className={styles.gapItemDetailsContent}>{gap.what_3_looks_like}</div>
                </details>

                <div className={styles.gapItemVerdictRow}>
                  <span className={styles.gapItemQuestion}>Was this gap addressed?</span>
                  <div className={styles.gapItemVerdictBtns}>
                    <button
                      className={`${styles.verdictBtn} ${verdict === 'addressed' ? styles.verdictBtnActiveGood : ''}`}
                      onClick={() => onGapVerdict(gap.id, verdict === 'addressed' ? 'pending' : 'addressed')}
                      type="button"
                    >
                      Yes
                    </button>
                    <button
                      className={`${styles.verdictBtn} ${verdict === 'not-addressed' ? styles.verdictBtnActiveBad : ''}`}
                      onClick={() => onGapVerdict(gap.id, verdict === 'not-addressed' ? 'pending' : 'not-addressed')}
                      type="button"
                    >
                      No
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section-level actions */}
      <div className={styles.sectionActionBar}>
        {sectionDecision === 'pending' ? (
          <>
            <button
              className={styles.sectionBtnAccept}
              onClick={onAcceptSection}
              disabled={!group.hasChanges || isReverting}
              type="button"
            >
              Accept Section Changes
            </button>
            <button
              className={styles.sectionBtnRevert}
              onClick={onRevertSection}
              disabled={!group.hasChanges || isReverting}
              type="button"
            >
              Revert Section
            </button>
            <div className={styles.sectionActionSpacer} />
            <button
              className={styles.sectionBtnDiscuss}
              onClick={onDiscuss}
              type="button"
            >
              Discuss with Apex
            </button>
          </>
        ) : sectionDecision === 'accepted' ? (
          <span className={styles.sectionStatusAccepted}>Section changes accepted</span>
        ) : (
          <span className={styles.sectionStatusReverted}>Section reverted to baseline</span>
        )}
      </div>
    </div>
  );
};

// ── Summary View ──────────────────────────────────────────────────────────────

const SummaryView: React.FC<{
  sectionGroups: SectionGroup[];
  gapVerdicts: Record<string, GapVerdict>;
  sectionDecisions: Record<SectionId, SectionDecision>;
  onBack: () => void;
  onApplyAndRevalidate: () => void;
  onRevertAll: () => void;
  isApplying: boolean;
  isReverting: boolean;
}> = ({ sectionGroups, gapVerdicts, sectionDecisions, onBack, onApplyAndRevalidate, onRevertAll, isApplying, isReverting }) => {
  const allGaps = sectionGroups.flatMap((g) => g.gaps);
  const addressed = allGaps.filter((g) => gapVerdicts[g.id] === 'addressed');
  const notAddressed = allGaps.filter((g) => gapVerdicts[g.id] === 'not-addressed');
  const pending = allGaps.filter((g) => !gapVerdicts[g.id] || gapVerdicts[g.id] === 'pending');

  return (
    <div className={styles.summaryView}>
      <div className={styles.summaryTitle}>Review Summary</div>

      {/* Section decisions */}
      <div className={styles.summarySection}>
        <div className={styles.summarySectionLabel}>Section Decisions</div>
        {sectionGroups.map((sg) => (
          <div key={sg.sectionId} className={styles.summaryRow}>
            <span className={styles.summaryRowLabel}>{sg.label}</span>
            <span className={`${styles.summaryRowStatus} ${
              sectionDecisions[sg.sectionId] === 'accepted' ? styles.summaryStatusGood :
              sectionDecisions[sg.sectionId] === 'reverted' ? styles.summaryStatusBad :
              styles.summaryStatusPending
            }`}>
              {sectionDecisions[sg.sectionId] === 'accepted' ? 'Accepted' :
               sectionDecisions[sg.sectionId] === 'reverted' ? 'Reverted' :
               sg.hasChanges ? 'Pending' : 'No changes'}
            </span>
          </div>
        ))}
      </div>

      {/* Gap verdicts */}
      <div className={styles.summarySection}>
        <div className={styles.summarySectionLabel}>Gap Assessment</div>

        {addressed.length > 0 && (
          <div className={styles.summaryGroup}>
            <div className={styles.summaryGroupLabel}>
              <span className={styles.summaryDot} style={{ background: 'var(--success-color)' }} />
              Addressed ({addressed.length})
            </div>
            {addressed.map((g) => (
              <div key={g.id} className={styles.summaryItem}>{g.description}</div>
            ))}
          </div>
        )}

        {notAddressed.length > 0 && (
          <div className={styles.summaryGroup}>
            <div className={styles.summaryGroupLabel}>
              <span className={styles.summaryDot} style={{ background: 'var(--error-color)' }} />
              Not Addressed ({notAddressed.length})
            </div>
            {notAddressed.map((g) => (
              <div key={g.id} className={styles.summaryItem}>{g.description}</div>
            ))}
          </div>
        )}

        {pending.length > 0 && (
          <div className={styles.summaryGroup}>
            <div className={styles.summaryGroupLabel}>
              <span className={styles.summaryDot} style={{ background: 'var(--text-muted)' }} />
              Not Reviewed ({pending.length})
            </div>
            {pending.map((g) => (
              <div key={g.id} className={styles.summaryItem}>{g.description}</div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.summaryActions}>
        <button className={styles.footerBtnSecondary} onClick={onBack} type="button">
          Back
        </button>
        <div className={styles.sectionActionSpacer} />
        <button
          className={styles.footerBtnDanger}
          onClick={onRevertAll}
          disabled={isApplying || isReverting}
          type="button"
        >
          Revert All
        </button>
        <button
          className={styles.footerBtnPrimary}
          onClick={onApplyAndRevalidate}
          disabled={isApplying || isReverting}
          type="button"
        >
          {isApplying ? 'Applying…' : 'Apply & Re-validate'}
        </button>
      </div>
    </div>
  );
};

// ── Main Panel ────────────────────────────────────────────────────────────────

export const FixValidationPanel: React.FC<FixValidationPanelProps> = ({
  baseline,
  currentDesign,
  currentTechSpec,
  currentAssumptions,
  scorecard,
  gapChanges,
  agentError,
  isApplying,
  isReverting,
  onAcceptSection,
  onRevertSection,
  onDiscuss,
  onApplyAndRevalidate,
  onRevertAll,
  onCancel,
  onRetry,
}) => {
  const [activeSectionIdx, setActiveSectionIdx] = useState(0);
  const [showSummary, setShowSummary] = useState(false);
  const [gapVerdicts, setGapVerdicts] = useState<Record<string, GapVerdict>>({});
  const [sectionDecisions, setSectionDecisions] = useState<Record<SectionId, SectionDecision>>({
    'design': 'pending',
    'tech-spec': 'pending',
    'assumptions': 'pending',
  });

  const gapChangesMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of gapChanges) {
      map[entry.gap_id] = entry.what_changed;
    }
    return map;
  }, [gapChanges]);

  const contentMap: Record<SectionId, { baseline: string; current: string }> = useMemo(() => ({
    'design': { baseline: baseline.design, current: currentDesign },
    'tech-spec': { baseline: baseline.techSpec, current: currentTechSpec },
    'assumptions': { baseline: baseline.assumptions, current: currentAssumptions },
  }), [baseline, currentDesign, currentTechSpec, currentAssumptions]);

  // Build section groups from scorecard gaps
  const sectionGroups: SectionGroup[] = useMemo(() => {
    const gapsBySection: Record<SectionId, GapWithMeta[]> = {
      'design': [],
      'tech-spec': [],
      'assumptions': [],
    };

    if (scorecard?.features) {
      for (const f of scorecard.features) {
        for (const g of f.gaps) {
          if (g.resolution === 'pending') {
            const sectionId = mapGapToSection(g);
            gapsBySection[sectionId].push({
              ...g,
              featureTitle: f.feature_title,
              featureSlug: f.feature_slug,
              sectionId,
            });
          }
        }
      }
    }

    const allSections: SectionId[] = ['design', 'tech-spec', 'assumptions'];
    return allSections
      .filter((s) => gapsBySection[s].length > 0 || contentMap[s].baseline !== contentMap[s].current)
      .map((s) => ({
        sectionId: s,
        label: sectionLabels[s],
        gaps: gapsBySection[s],
        hasChanges: contentMap[s].baseline !== contentMap[s].current,
      }));
  }, [scorecard, contentMap]);

  const activeGroup = sectionGroups[activeSectionIdx] ?? null;

  const handleGapVerdict = useCallback((gapId: string, verdict: GapVerdict) => {
    setGapVerdicts((prev) => ({ ...prev, [gapId]: verdict }));
  }, []);

  const handleAcceptSection = useCallback((sectionId: SectionId) => {
    setSectionDecisions((prev) => ({ ...prev, [sectionId]: 'accepted' }));
    onAcceptSection(sectionId);
  }, [onAcceptSection]);

  const handleRevertSection = useCallback((sectionId: SectionId) => {
    setSectionDecisions((prev) => ({ ...prev, [sectionId]: 'reverted' }));
    onRevertSection(sectionId);
  }, [onRevertSection]);

  const goNext = useCallback(() => {
    if (activeSectionIdx < sectionGroups.length - 1) {
      setActiveSectionIdx((i) => i + 1);
    } else {
      setShowSummary(true);
    }
  }, [activeSectionIdx, sectionGroups.length]);

  const goPrev = useCallback(() => {
    if (showSummary) {
      setShowSummary(false);
    } else if (activeSectionIdx > 0) {
      setActiveSectionIdx((i) => i - 1);
    }
  }, [activeSectionIdx, showSummary]);

  const totalGaps = sectionGroups.reduce((sum, g) => sum + g.gaps.length, 0);
  const reviewedGaps = Object.values(gapVerdicts).filter((v) => v !== 'pending').length;

  const allSectionsUnchanged = sectionGroups.length > 0 && sectionGroups.every((g) => !g.hasChanges);
  const noChangesDetected = sectionGroups.length === 0 || allSectionsUnchanged;

  if (agentError || (noChangesDetected && gapChanges.length === 0)) {
    return (
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <span className={styles.panelTitle}>Review Apex Changes</span>
          </div>
          <div className={styles.panelHeaderRight}>
            <button className={styles.fixingCancelBtn} onClick={onCancel} type="button">Close</button>
          </div>
        </div>
        <div className={styles.diffNoChanges}>
          {agentError ? (
            <>
              <svg className={styles.diffNoChangesIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--error-color)' }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Apex encountered an error</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', maxWidth: 420, textAlign: 'center', lineHeight: 1.5 }}>
                {agentError}
              </div>
            </>
          ) : (
            <>
              <svg className={styles.diffNoChangesIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--error-color)' }}>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>No changes were applied</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', maxWidth: 420, textAlign: 'center', lineHeight: 1.5 }}>
                The AI agent completed but did not save any changes to the design doc sections. This can happen if the agent encountered a tool error. Try running the fix again.
              </div>
            </>
          )}
          {onRetry && (
            <button
              className={styles.fixingRetryBtn}
              onClick={onRetry}
              type="button"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
                <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
              </svg>
              Retry Fix with Apex
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.panelHeader}>
        <div className={styles.panelHeaderLeft}>
          <svg className={styles.panelHeaderIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <span className={styles.panelTitle}>Review Apex Changes</span>
        </div>
        <div className={styles.panelHeaderRight}>
          <span className={styles.progressText}>
            {reviewedGaps} of {totalGaps} gaps reviewed
          </span>
          <button className={styles.fixingCancelBtn} onClick={onCancel} type="button">Cancel</button>
        </div>
      </div>

      {/* Section stepper tabs */}
      <div className={styles.stepper}>
        <div className={styles.stepperTabs}>
          {sectionGroups.map((sg, idx) => {
            const decision = sectionDecisions[sg.sectionId];
            const gapCount = sg.gaps.length;
            const reviewedInSection = sg.gaps.filter((g) => gapVerdicts[g.id] && gapVerdicts[g.id] !== 'pending').length;
            return (
              <button
                key={sg.sectionId}
                className={`${styles.stepperTab} ${
                  !showSummary && idx === activeSectionIdx ? styles.stepperTabActive : ''
                } ${
                  decision === 'accepted' ? styles.stepperTabAccepted :
                  decision === 'reverted' ? styles.stepperTabReverted : ''
                }`}
                onClick={() => { setShowSummary(false); setActiveSectionIdx(idx); }}
                type="button"
              >
                <span className={styles.stepperTabLabel}>{sg.label}</span>
                <span className={styles.stepperTabMeta}>
                  {sg.hasChanges ? `${reviewedInSection}/${gapCount} gaps` : 'no changes'}
                </span>
              </button>
            );
          })}
          <button
            className={`${styles.stepperTab} ${showSummary ? styles.stepperTabActive : ''}`}
            onClick={() => setShowSummary(true)}
            type="button"
          >
            <span className={styles.stepperTabLabel}>Summary</span>
          </button>
        </div>
      </div>

      {/* Summary view */}
      {showSummary && (
        <SummaryView
          sectionGroups={sectionGroups}
          gapVerdicts={gapVerdicts}
          sectionDecisions={sectionDecisions}
          onBack={() => setShowSummary(false)}
          onApplyAndRevalidate={onApplyAndRevalidate}
          onRevertAll={onRevertAll}
          isApplying={isApplying}
          isReverting={isReverting}
        />
      )}

      {/* Section review content */}
      {!showSummary && activeGroup && (
        <>
          <div className={styles.body}>
            <SectionReview
              group={activeGroup}
              baselineContent={contentMap[activeGroup.sectionId].baseline}
              currentContent={contentMap[activeGroup.sectionId].current}
              gapVerdicts={gapVerdicts}
              gapChangesMap={gapChangesMap}
              gapChangeEntries={gapChanges}
              sectionDecision={sectionDecisions[activeGroup.sectionId]}
              onGapVerdict={handleGapVerdict}
              onAcceptSection={() => handleAcceptSection(activeGroup.sectionId)}
              onRevertSection={() => handleRevertSection(activeGroup.sectionId)}
              onDiscuss={() => onDiscuss(activeGroup.sectionId)}
              isReverting={isReverting}
            />
          </div>

          {/* Footer navigation */}
          <div className={styles.footer}>
            <div className={styles.footerLeft}>
              <button
                className={styles.footerBtnSecondary}
                onClick={goPrev}
                disabled={activeSectionIdx === 0}
                type="button"
              >
                Previous Section
              </button>
            </div>
            <div className={styles.footerRight}>
              {activeSectionIdx < sectionGroups.length - 1 ? (
                <button className={styles.footerBtnPrimary} onClick={goNext} type="button">
                  Next Section
                </button>
              ) : (
                <button className={styles.footerBtnPrimary} onClick={goNext} type="button">
                  Review Summary
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ── Fixing Progress View (shown during AI fix) ───────────────────────────────

export const FixingProgressView: React.FC<{ onCancel: () => void }> = ({ onCancel }) => (
  <div className={styles.fixingOverlay}>
    <svg className={styles.fixingSpinner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
    <div className={styles.fixingTitle}>Apex is fixing validation gaps…</div>
    <div className={styles.fixingSub}>
      The assistant is reviewing each gap and rewriting the affected sections. This typically takes 1–3 minutes depending on the number of gaps.
    </div>
    <button className={styles.fixingCancelBtn} onClick={onCancel} type="button">
      Cancel
    </button>
  </div>
);

export default FixValidationPanel;
