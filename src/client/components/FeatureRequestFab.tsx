import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { IS_BETA_RELEASE } from '../config/release';
import { BrandLogo } from './BrandLogo';
import { AskApexChat } from './AskApexChat';
import { WalkthroughHelpHost } from './WalkthroughHelpHost';
import type { WorkItemType } from '../../shared/types/featureRequest';
import styles from './FeatureRequestFab.module.css';

const FAB_SIZE = 48;
const FAB_MARGIN = 24;
const FAB_STORAGE_KEY = 'apex-fab-position';
const DRAG_THRESHOLD = 6;
const MENU_MIN_WIDTH = 220;
const MENU_ESTIMATED_HEIGHT = 192;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

interface Position {
  x: number;
  y: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface FeatureRequestFabProps {
  onSubmit: (type: WorkItemType) => void;
  /** Active project — required to open Walkthrough Help / replay. */
  projectId?: string | null;
  /** When false, hide feature/issue submission actions (Walkthroughs + Ask Apex remain). */
  canSubmitWorkItems?: boolean;
  /** Optional test id for pre-commit / parent composition scans. */
  'data-testid'?: string;
}

function clampPosition(pos: Position): Position {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - FAB_SIZE - margin);
  const maxY = Math.max(margin, window.innerHeight - FAB_SIZE - margin);
  return {
    x: Math.max(margin, Math.min(maxX, pos.x)),
    y: Math.max(margin, Math.min(maxY, pos.y)),
  };
}

function getDefaultPosition(): Position {
  return clampPosition({
    x: window.innerWidth - FAB_SIZE - FAB_MARGIN,
    y: window.innerHeight - FAB_SIZE - FAB_MARGIN,
  });
}

function repositionForViewport(
  position: Position,
  previousViewport: ViewportSize,
  nextViewport: ViewportSize,
): Position {
  const anchoredRight = position.x + FAB_SIZE / 2 >= previousViewport.width / 2;
  const anchoredBottom = position.y + FAB_SIZE / 2 >= previousViewport.height / 2;

  return clampPosition({
    x: anchoredRight
      ? nextViewport.width - (previousViewport.width - position.x)
      : position.x,
    y: anchoredBottom
      ? nextViewport.height - (previousViewport.height - position.y)
      : position.y,
  });
}

function loadStoredPosition(): Position | null {
  try {
    const stored = localStorage.getItem(FAB_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<Position & {
      viewportWidth: number;
      viewportHeight: number;
    }>;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      if (
        typeof parsed.viewportWidth === 'number' &&
        typeof parsed.viewportHeight === 'number'
      ) {
        return repositionForViewport(
          { x: parsed.x, y: parsed.y },
          { width: parsed.viewportWidth, height: parsed.viewportHeight },
          { width: window.innerWidth, height: window.innerHeight },
        );
      }
      return clampPosition({ x: parsed.x, y: parsed.y });
    }
  } catch {
    // ignore invalid storage
  }
  return null;
}

function computeMenuStyle(
  fabPosition: Position,
  menuWidth: number,
  menuHeight: number,
): React.CSSProperties {
  let left = fabPosition.x + FAB_SIZE - menuWidth;
  if (left < VIEWPORT_MARGIN) {
    left = fabPosition.x;
  }
  left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(left, window.innerWidth - menuWidth - VIEWPORT_MARGIN),
  );

  let top = fabPosition.y - menuHeight - MENU_GAP;
  if (top < VIEWPORT_MARGIN) {
    top = fabPosition.y + FAB_SIZE + MENU_GAP;
  }
  top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(top, window.innerHeight - menuHeight - VIEWPORT_MARGIN),
  );

  return { left, top };
}

function readHelpWalkthroughsDeepLink(search?: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(search ?? window.location.search).get('help') === 'walkthroughs';
  } catch {
    return false;
  }
}

function clearHelpWalkthroughsDeepLink(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('help') !== 'walkthroughs') return;
    url.searchParams.delete('help');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore
  }
}

export const FeatureRequestFab: React.FC<FeatureRequestFabProps> = ({
  onSubmit,
  projectId = null,
  canSubmitWorkItems = true,
  'data-testid': rootTestId = 'apex-feature-request-fab',
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(() => Boolean(projectId) && readHelpWalkthroughsDeepLink());
  const [position, setPosition] = useState<Position | null>(() => {
    if (typeof window === 'undefined') return null;
    return loadStoredPosition() ?? getDefaultPosition();
  });
  const [isDragging, setIsDragging] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    startPosX: 0,
    startPosY: 0,
  });
  const suppressClickRef = useRef(false);
  const positionRef = useRef<Position | null>(null);
  const viewportRef = useRef<ViewportSize>({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  });
  const location = useLocation();

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const handleResize = () => {
      const previousViewport = viewportRef.current;
      const nextViewport = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      setPosition((prev) =>
        prev
          ? repositionForViewport(prev, previousViewport, nextViewport)
          : prev,
      );
      viewportRef.current = nextViewport;
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleMenu = useCallback(() => {
    if (chatOpen) return;
    setMenuOpen((prev) => !prev);
  }, [chatOpen]);

  const handleRequestFeature = useCallback(() => {
    setMenuOpen(false);
    onSubmit('feature');
  }, [onSubmit]);

  const handleReportIssue = useCallback(() => {
    setMenuOpen(false);
    onSubmit('issue');
  }, [onSubmit]);

  const handleAskApex = useCallback(() => {
    setMenuOpen(false);
    setChatOpen(true);
  }, []);

  const handleOpenWalkthroughs = useCallback(() => {
    setMenuOpen(false);
    setHelpOpen(true);
  }, []);

  const handleCloseChat = useCallback(() => {
    setChatOpen(false);
  }, []);

  useEffect(() => {
    if (!projectId || !readHelpWalkthroughsDeepLink(location.search)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync Help open from ?help=walkthroughs deep link
    setHelpOpen(true);
    clearHelpWalkthroughsDeepLink();
  }, [projectId, location.search]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (chatOpen || !position) return;
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      startPosX: position.x,
      startPosY: position.y,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [chatOpen, position]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active || !position) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    if (!dragRef.current.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      dragRef.current.moved = true;
      setIsDragging(true);
      setMenuOpen(false);
    }

    if (dragRef.current.moved) {
      setPosition(clampPosition({
        x: dragRef.current.startPosX + dx,
        y: dragRef.current.startPosY + dy,
      }));
    }
  }, [position]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active) return;

    const wasDrag = dragRef.current.moved;
    dragRef.current.active = false;
    dragRef.current.moved = false;
    setIsDragging(false);

    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }

    if (wasDrag) {
      const latest = positionRef.current;
      if (latest) {
        try {
          localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({
            ...latest,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          }));
        } catch {
          // ignore quota errors
        }
      }
      suppressClickRef.current = true;
      return;
    }
  }, []);

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    toggleMenu();
  }, [toggleMenu]);

  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    dragRef.current.moved = false;
    setIsDragging(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen || !position) {
      setMenuStyle({});
      return;
    }

    const updateMenuPosition = () => {
      const menuEl = menuRef.current;
      const menuWidth = menuEl?.offsetWidth ?? MENU_MIN_WIDTH;
      const menuHeight = menuEl?.offsetHeight ?? MENU_ESTIMATED_HEIGHT;
      setMenuStyle(computeMenuStyle(position, menuWidth, menuHeight));
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    return () => window.removeEventListener('resize', updateMenuPosition);
  }, [menuOpen, position]);

  if (!position) return null;

  const resolvedMenuStyle =
    menuOpen
      ? {
          ...computeMenuStyle(position, MENU_MIN_WIDTH, MENU_ESTIMATED_HEIGHT),
          ...menuStyle,
        }
      : undefined;

  return (
    <>
      <div
        className={styles.container}
        style={{ left: position.x, top: position.y }}
        {...{ 'data-testid': rootTestId }}
      >
        {menuOpen && (
          <>
            <div
              className={styles['menu-overlay']}
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
              // data-testid-exempt — decorative backdrop; menu items are the actionable controls
            />
            <div
              className={styles.menu}
              ref={menuRef}
              role="menu"
              style={resolvedMenuStyle}
              {...{ 'data-testid': 'apex-fab-menu' }}
            >
              {projectId && (
                <button
                  className={styles['menu-item']}
                  onClick={handleOpenWalkthroughs}
                  type="button"
                  role="menuitem"
                  {...{ 'data-testid': 'walkthrough-help-trigger' }}
                >
                  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" />
                  </svg>
                  Walkthroughs
                </button>
              )}
              {canSubmitWorkItems && (
                <button
                  className={styles['menu-item']}
                  onClick={handleRequestFeature}
                  type="button"
                  role="menuitem"
                  {...{ 'data-testid': 'apex-fab-request-feature' }}
                >
                  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1-.85.6V16h-4v-2.3l-.85-.6A4.997 4.997 0 0 1 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z" />
                  </svg>
                  Request New Apex Feature
                </button>
              )}
              <button
                className={styles['menu-item']}
                onClick={handleAskApex}
                type="button"
                role="menuitem"
                {...{ 'data-testid': 'apex-fab-ask-apex' }}
              >
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
                </svg>
                Ask Apex
              </button>
              {canSubmitWorkItems && (
                <button
                  className={styles['menu-item']}
                  onClick={handleReportIssue}
                  type="button"
                  role="menuitem"
                  {...{ 'data-testid': 'apex-fab-report-issue' }}
                >
                  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M12 2 1 21h22L12 2zm0 4 7.5 13h-15L12 6zm-1 4v5h2v-5h-2zm0 7v2h2v-2h-2z" />
                  </svg>
                  Report an Issue
                </button>
              )}
            </div>
          </>
        )}

        {!chatOpen && (
          <button
            className={`${styles.fab} ${isDragging ? styles.fabDragging : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onClick={handleClick}
            type="button"
            title="Apex Menu (drag to move)"
            aria-label="Open Apex menu"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            {...{ 'data-testid': 'apex-fab-trigger' }}
          >
            <BrandLogo
              variant="mark"
              beta={IS_BETA_RELEASE}
              className={styles.fabLogo}
            />
          </button>
        )}
      </div>

      {chatOpen && <AskApexChat onClose={handleCloseChat} />}

      {projectId && (
        <WalkthroughHelpHost
          projectId={projectId}
          open={helpOpen}
          onOpenChange={setHelpOpen}
        />
      )}
    </>
  );
};
