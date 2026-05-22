import React, { useState, useEffect } from 'react';
import styles from './Changelog.module.css';

interface ChangelogChange {
  type: 'feature' | 'improvement' | 'bugfix' | 'breaking';
  description: string;
}

interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  changes: ChangelogChange[];
}

interface ChangelogProps {
  isOpen: boolean;
  onClose: () => void;
  onMarkAsRead: () => void;
  showOnLogin: boolean;
  onToggleShowOnLogin: (show: boolean) => void;
}

export const Changelog: React.FC<ChangelogProps> = ({ isOpen, onClose, onMarkAsRead, showOnLogin, onToggleShowOnLogin }) => {
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/CHANGELOG.json')
      .then(res => res.json())
      .then(data => {
        setChangelog(data);
        if (data.length > 0) setExpandedVersions(new Set([data[0].version]));
      })
      .catch(err => console.error('Failed to load changelog:', err));
  }, []);

  const toggleVersion = (version: string) => {
    const newExpanded = new Set(expandedVersions);
    if (newExpanded.has(version)) newExpanded.delete(version);
    else newExpanded.add(version);
    setExpandedVersions(newExpanded);
  };

  const handleClose = () => { onMarkAsRead(); onClose(); };

  const getChangeIcon = (type: string) => {
    const icons: Record<string, string> = { feature: '✨', improvement: '🚀', bugfix: '🐛', breaking: '⚠️' };
    return icons[type] || '•';
  };

  const getChangeClass = (type: string): string => {
    const map: Record<string, string> = {
      feature: styles['change-feature'],
      improvement: styles['change-improvement'],
      bugfix: styles['change-bugfix'],
      breaking: styles['change-breaking'],
    };
    return map[type] || '';
  };

  if (!isOpen) return null;

  return (
    <>
      <div className={styles['changelog-overlay']} onClick={handleClose} />
      <div className={styles['changelog-modal']}>
        <div className={styles['changelog-header']}>
          <div>
            <h2>What's New</h2>
            <p className={styles['changelog-subtitle']}>Recent updates and improvements</p>
          </div>
          <button onClick={handleClose} className={styles['changelog-close-btn']}>×</button>
        </div>

        <div className={styles['changelog-content']}>
          {changelog.length === 0 ? (
            <div className={styles['changelog-loading']}>Loading changelog...</div>
          ) : (
            <div className={styles['changelog-list']}>
              {changelog.map((entry, index) => (
                <div key={entry.version} className={styles['changelog-entry']}>
                  <div
                    className={styles['changelog-entry-header']}
                    onClick={() => toggleVersion(entry.version)}
                  >
                    <div className={styles['changelog-entry-info']}>
                      <div className={styles['changelog-version-row']}>
                        <span className={styles['changelog-version']}>v{entry.version}</span>
                        {index === 0 && <span className={styles['changelog-new-badge']}>NEW</span>}
                      </div>
                      <h3 className={styles['changelog-title']}>{entry.title}</h3>
                      <span className={styles['changelog-date']}>
                        {new Date(entry.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                      </span>
                    </div>
                    <span className={styles['changelog-toggle']}>
                      {expandedVersions.has(entry.version) ? '▼' : '▶'}
                    </span>
                  </div>

                  {expandedVersions.has(entry.version) && (
                    <div className={styles['changelog-changes']}>
                      {entry.changes.map((change, changeIndex) => (
                        <div key={changeIndex} className={`${styles['changelog-change']} ${getChangeClass(change.type)}`}>
                          <span className={styles['change-icon']}>{getChangeIcon(change.type)}</span>
                          <span className={styles['change-description']}>{change.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={styles['changelog-footer']}>
          <label className={styles['changelog-show-toggle']}>
            <input
              type="checkbox"
              checked={showOnLogin}
              onChange={(e) => onToggleShowOnLogin(e.target.checked)}
            />
            Show automatically on login
          </label>
          <button onClick={handleClose} className={styles['changelog-done-btn']}>Got it!</button>
        </div>
      </div>
    </>
  );
};
