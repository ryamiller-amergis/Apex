import React, { useState, useCallback, useEffect, useRef } from 'react';
import { AskApexChat } from './AskApexChat';
import styles from './FeatureRequestFab.module.css';

interface FeatureRequestFabProps {
  onRequestFeature: () => void;
}

export const FeatureRequestFab: React.FC<FeatureRequestFabProps> = ({ onRequestFeature }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen]);

  return (
    <>
      <div className={styles.container}>
        {menuOpen && (
          <>
            <div
              className={styles['menu-overlay']}
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />
            <div className={styles.menu} ref={menuRef} role="menu">
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
            className={styles.fab}
            onClick={toggleMenu}
            type="button"
            title="Apex Menu"
            aria-label="Open Apex menu"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1-.85.6V16h-4v-2.3l-.85-.6A4.997 4.997 0 0 1 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z" />
            </svg>
          </button>
        )}
      </div>

      {chatOpen && <AskApexChat onClose={handleCloseChat} />}
    </>
  );
};
