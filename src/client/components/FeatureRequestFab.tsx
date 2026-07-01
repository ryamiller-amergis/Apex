import React, { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { IS_BETA_RELEASE } from '../config/release';
import { BrandLogo } from './BrandLogo';
import { AskApexChat } from './AskApexChat';
import styles from './FeatureRequestFab.module.css';

const FAB_SIZE = 48;
const FAB_MARGIN = 24;
const FAB_STORAGE_KEY = 'apex-fab-position';
const DRAG_THRESHOLD = 6;
const MENU_MIN_WIDTH = 220;
const MENU_ESTIMATED_HEIGHT = 96;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

interface Position {
  x: number;
  y: number;
}

interface FeatureRequestFabProps {
  onRequestFeature: () => void;
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

function loadStoredPosition(): Position | null {
  try {
    const stored = localStorage.getItem(FAB_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<Position>;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
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

export const FeatureRequestFab: React.FC<FeatureRequestFabProps> = ({ onRequestFeature }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
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

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const handleResize = () => {
      setPosition((prev) => (prev ? clampPosition(prev) : prev));
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
    onRequestFeature();
  }, [onRequestFeature]);

  const handleAskApex = useCallback(() => {
    setMenuOpen(false);
    setChatOpen(true);
  }, []);

  const handleCloseChat = useCallback(() => {
    setChatOpen(false);
  }, []);

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
          localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify(latest));
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
      >
        {menuOpen && (
          <>
            <div
              className={styles['menu-overlay']}
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />
            <div
              className={styles.menu}
              ref={menuRef}
              role="menu"
              style={resolvedMenuStyle}
            >
              <button
                className={styles['menu-item']}
                onClick={handleRequestFeature}
                type="button"
                role="menuitem"
              >
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1-.85.6V16h-4v-2.3l-.85-.6A4.997 4.997 0 0 1 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z" />
                </svg>
                Request New Apex Feature
              </button>
              <button
                className={styles['menu-item']}
                onClick={handleAskApex}
                type="button"
                role="menuitem"
              >
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
                </svg>
                Ask Apex
              </button>
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
    </>
  );
};
