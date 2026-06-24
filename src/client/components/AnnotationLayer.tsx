import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { ReviewCommentWithReplies, ReviewSectionKey, TextSelector } from '../../shared/types/reviewComments';
import styles from './AnnotationLayer.module.css';

interface AnnotationLayerProps {
  sectionKey: ReviewSectionKey;
  comments: ReviewCommentWithReplies[];
  activeCommentId: string | null;
  onAddComment: (sectionKey: ReviewSectionKey, selector: TextSelector) => void;
  onCommentClick: (commentId: string) => void;
  children: React.ReactNode;
}

interface FloatingButton {
  top: number;
  left: number;
  selector: TextSelector;
}

const CONTEXT_CHARS = 30;

/**
 * When a selection spans multiple block elements (e.g. a heading + a paragraph),
 * browsers insert `\n` between them in `sel.toString()`, but `element.textContent`
 * concatenates without any such separator. This helper finds the start/end offsets
 * in the original containerText by stripping whitespace from both sides and mapping
 * the match position back to the original character indices.
 */
function findStrippedMatch(
  containerText: string,
  strippedTarget: string,
): { start: number; end: number } | null {
  if (!strippedTarget) return null;
  const origPositions: number[] = [];
  for (let i = 0; i < containerText.length; i++) {
    if (!/\s/.test(containerText[i])) origPositions.push(i);
  }
  const strippedContainer = origPositions.map((i) => containerText[i]).join('');
  const idx = strippedContainer.indexOf(strippedTarget);
  if (idx < 0) return null;
  const start = origPositions[idx];
  const end = origPositions[idx + strippedTarget.length - 1] + 1;
  return { start, end };
}

export function buildTextSelector(
  selectedText: string,
  containerText: string,
  anchorOffset: number,
): TextSelector | null {
  // Normalize: collapse whitespace sequences (browsers add \n between block elements)
  const normalized = selectedText.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  // 1. Try direct match with the normalized text
  let idx = containerText.indexOf(normalized, Math.max(0, anchorOffset - normalized.length - 10));
  if (idx < 0) idx = containerText.indexOf(normalized);

  if (idx >= 0) {
    const end = idx + normalized.length;
    return {
      exact: normalized,
      prefix: containerText.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
      suffix: containerText.slice(end, end + CONTEXT_CHARS),
      start: idx,
      end,
    };
  }

  // 2. Fallback: strip all whitespace from both and map positions back.
  //    Handles cross-block selections where textContent has no whitespace between elements.
  const strippedTarget = normalized.replace(/\s/g, '');
  if (strippedTarget.length < 3) return null;
  const stripped = findStrippedMatch(containerText, strippedTarget);
  if (!stripped) return null;

  return {
    exact: normalized,
    prefix: containerText.slice(Math.max(0, stripped.start - CONTEXT_CHARS), stripped.start),
    suffix: containerText.slice(stripped.end, stripped.end + CONTEXT_CHARS),
    start: stripped.start,
    end: stripped.end,
  };
}

function getTextOffset(container: Node, targetNode: Node, targetOffset: number): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node === targetNode) return offset + targetOffset;
    offset += (node.textContent?.length ?? 0);
  }
  return offset;
}

/**
 * Locate the position of a selector's exact text within the container's
 * full text content. Falls back through: exact offset → prefix+suffix context
 * → first-occurrence match.
 *
 * Context (prefix+suffix) is preferred over a bare `indexOf(exact)` so that a
 * non-unique selection (e.g. "External User" appearing more than once)
 * re-anchors to the originally selected span instead of latching onto the first
 * matching occurrence after surrounding text changes (issue #3).
 */
export function anchorSelector(containerText: string, selector: TextSelector): { start: number; end: number } | null {
  const { exact, prefix, suffix, start: hintStart } = selector;

  // 1. Try at the hinted offset first
  if (
    hintStart >= 0 &&
    hintStart + exact.length <= containerText.length &&
    containerText.slice(hintStart, hintStart + exact.length) === exact
  ) {
    return { start: hintStart, end: hintStart + exact.length };
  }

  // 2. Prefer prefix + suffix context so the originally selected occurrence is
  //    respected even when the same text appears elsewhere.
  if (prefix) {
    const prefixIdx = containerText.indexOf(prefix);
    if (prefixIdx >= 0) {
      const candidateStart = prefixIdx + prefix.length;
      const candidateEnd = candidateStart + exact.length;
      if (
        candidateEnd <= containerText.length &&
        containerText.slice(candidateStart, candidateEnd) === exact
      ) {
        return { start: candidateStart, end: candidateEnd };
      }
    }
  }

  if (suffix) {
    const suffixIdx = containerText.indexOf(suffix);
    if (suffixIdx >= 0) {
      const candidateEnd = suffixIdx;
      const candidateStart = candidateEnd - exact.length;
      if (
        candidateStart >= 0 &&
        containerText.slice(candidateStart, candidateEnd) === exact
      ) {
        return { start: candidateStart, end: candidateEnd };
      }
    }
  }

  // 3. Last resort: first occurrence anywhere.
  const idx = containerText.indexOf(exact);
  if (idx >= 0) {
    return { start: idx, end: idx + exact.length };
  }

  return null;
}

/**
 * Create a DOM Range spanning the given character offsets within a container.
 */
function createRangeFromOffsets(
  container: Node,
  startOffset: number,
  endOffset: number,
): Range | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let charsSeen = 0;
  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (!startNode && charsSeen + len > startOffset) {
      startNode = node as Text;
      startNodeOffset = startOffset - charsSeen;
    }
    if (charsSeen + len >= endOffset) {
      endNode = node as Text;
      endNodeOffset = endOffset - charsSeen;
      break;
    }
    charsSeen += len;
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    return range;
  } catch {
    return null;
  }
}

export const AnnotationLayer: React.FC<AnnotationLayerProps> = ({
  sectionKey,
  comments,
  activeCommentId,
  onAddComment,
  onCommentClick,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [floatingButton, setFloatingButton] = useState<FloatingButton | null>(null);
  const highlightElementsRef = useRef<HTMLElement[]>([]);

  const clearHighlights = useCallback(() => {
    for (const el of highlightElementsRef.current) {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
    }
    highlightElementsRef.current = [];
  }, []);

  // Derive a stable fingerprint of only the data that affects highlights so
  // the expensive DOM teardown/rebuild only runs when it actually needs to.
  const highlightFingerprint = useMemo(
    () => comments.map((c) => `${c.id}:${c.selector.start}:${c.selector.end}:${c.status}`).join('|'),
    [comments],
  );

  // Re-anchor highlights only when the set of comments, their positions, or
  // statuses change — NOT on every field update (replies, timestamps, etc.).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    clearHighlights();

    const containerText = container.textContent ?? '';
    if (!containerText) return;

    for (const comment of comments) {
      // Skip resolved comments: once resolved, a highlight must not re-anchor
      // (and possibly jump to a different matching occurrence) after edits.
      if (comment.status === 'resolved') continue;

      const anchor = anchorSelector(containerText, comment.selector);
      if (!anchor) continue;

      const range = createRangeFromOffsets(container, anchor.start, anchor.end);
      if (!range) continue;

      const mark = document.createElement('mark');
      mark.className = comment.id === activeCommentId
        ? `${styles.highlight} ${styles.highlightActive}`
        : styles.highlight;
      mark.dataset.commentId = comment.id;
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        onCommentClick(comment.id);
      });

      try {
        range.surroundContents(mark);
        highlightElementsRef.current.push(mark);
      } catch {
        const fragments = extractTextNodes(range, container);
        for (const frag of fragments) {
          const fragMark = document.createElement('mark');
          fragMark.className = mark.className;
          fragMark.dataset.commentId = comment.id;
          fragMark.addEventListener('click', (e) => {
            e.stopPropagation();
            onCommentClick(comment.id);
          });
          frag.parentNode?.insertBefore(fragMark, frag);
          fragMark.appendChild(frag);
          highlightElementsRef.current.push(fragMark);
        }
      }
    }

    if (activeCommentId) {
      const activeMark = highlightElementsRef.current.find(
        (el) => el.dataset.commentId === activeCommentId,
      );
      if (activeMark) {
        let ancestor: HTMLElement | null = activeMark.parentElement;
        while (ancestor && ancestor !== containerRef.current) {
          if (ancestor.dataset.collapsed === 'true') {
            ancestor.dispatchEvent(new Event('expand-for-comment', { bubbles: false }));
          }
          ancestor = ancestor.parentElement;
        }
        // Double rAF: first lets React process the state updates and re-render,
        // second ensures the browser has laid out the now-visible sections.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            activeMark.scrollIntoView({ behavior: 'smooth', block: 'center' }),
          ),
        );
      }
    }

    return clearHighlights;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightFingerprint, activeCommentId, onCommentClick, clearHighlights]);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !containerRef.current) {
      setFloatingButton(null);
      return;
    }

    const range = sel.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) {
      setFloatingButton(null);
      return;
    }

    const selectedText = sel.toString().trim();
    if (!selectedText) {
      setFloatingButton(null);
      return;
    }

    const containerText = containerRef.current.textContent ?? '';
    const anchorOffset = getTextOffset(
      containerRef.current,
      range.startContainer,
      range.startOffset,
    );

    const selector = buildTextSelector(selectedText, containerText, anchorOffset);
    if (!selector) {
      setFloatingButton(null);
      return;
    }

    const rect = range.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();

    // Place the button above the selection; if there isn't enough room above
    // (near the top of the container), flip it below instead.
    const rawTop = rect.top - containerRect.top - 36;
    const top = rawTop < 4 ? rect.bottom - containerRect.top + 4 : rawTop;

    setFloatingButton({
      top,
      left: rect.left - containerRect.left + rect.width / 2,
      selector,
    });
  }, []);

  const handleAddComment = useCallback(() => {
    if (!floatingButton) return;
    onAddComment(sectionKey, floatingButton.selector);
    setFloatingButton(null);
    window.getSelection()?.removeAllRanges();
  }, [floatingButton, onAddComment, sectionKey]);

  // Dismiss floating button when clicking outside or pressing Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (!floatingButton) return;
      const target = e.target as HTMLElement;
      if (target.closest(`.${styles.addCommentButton}`)) return;
      setFloatingButton(null);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFloatingButton(null);
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [floatingButton]);

  return (
    <div
      ref={containerRef}
      className={styles.container}
      onMouseUp={handleMouseUp}
    >
      {children}

      {floatingButton && (
        <button
          className={styles.addCommentButton}
          style={{ top: floatingButton.top, left: floatingButton.left }}
          onClick={handleAddComment}
          type="button"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3.5v9M3.5 8h9" />
          </svg>
          Comment
        </button>
      )}
    </div>
  );
};

/**
 * Extract the text nodes inside a Range when it spans multiple elements.
 * Returns cloned text nodes ready to be wrapped in highlight marks.
 */
function extractTextNodes(range: Range, container: Node): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let inRange = false;
  let node: Node | null;

  while ((node = walker.nextNode())) {
    if (node === range.startContainer) inRange = true;
    if (inRange && node.textContent) {
      let textNode = node as Text;
      if (node === range.startContainer && range.startOffset > 0) {
        textNode = textNode.splitText(range.startOffset);
      }
      if (node === range.endContainer || textNode === range.endContainer) {
        const endOff = node === range.startContainer
          ? range.endOffset - range.startOffset
          : range.endOffset;
        if (endOff < (textNode.textContent?.length ?? 0)) {
          textNode.splitText(endOff);
        }
      }
      nodes.push(textNode);
    }
    if (node === range.endContainer) break;
  }

  return nodes;
}
