import React, { useState, useEffect, useCallback } from 'react';
import {
  useProjectMenuConfig,
  useAllProjectMenuConfigs,
  useUpsertProjectMenuConfig,
} from '../hooks/useProjectMenuConfig';
import { CONFIGURABLE_MENU_ITEMS } from '../../shared/types/menuSettings';
import type { MenuItemKey } from '../../shared/types/menuSettings';
import styles from './AdminMenuSettings.module.css';

interface AdminMenuSettingsProps {
  selectedProject: string;
  availableProjects: string[];
}

export const AdminMenuSettings: React.FC<AdminMenuSettingsProps> = ({
  selectedProject,
  availableProjects,
}) => {
  const { enabledViews, isLoading } = useProjectMenuConfig(selectedProject);
  const { data: allConfigs = [], isLoading: allLoading } = useAllProjectMenuConfigs();
  const upsert = useUpsertProjectMenuConfig();

  const [localViews, setLocalViews] = useState<MenuItemKey[]>([]);

  useEffect(() => {
    setLocalViews(enabledViews);
  }, [enabledViews]);

  const handleToggle = useCallback((key: MenuItemKey) => {
    setLocalViews((prev) =>
      prev.includes(key) ? prev.filter((v) => v !== key) : [...prev, key],
    );
  }, []);

  const handleSave = useCallback(async () => {
    await upsert.mutateAsync({
      project: selectedProject,
      body: { enabledViews: localViews },
    });
  }, [upsert, selectedProject, localViews]);

  if (isLoading || allLoading) {
    return <div className={styles.loading}>Loading menu settings…</div>;
  }

  const otherConfigured = allConfigs.filter(
    (c) => c.project !== selectedProject && availableProjects.includes(c.project),
  );

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Menu Visibility</h1>
          <p className={styles.pageSubtitle}>
            Choose which views are visible in the navigation for{' '}
            <strong>{selectedProject}</strong>. Unconfigured projects show only Home.
          </p>
        </div>

        <div className={styles.formCard}>
          <p className={styles.formTitle}>{selectedProject}</p>
          <p className={styles.formHint}>
            Check each view to make it visible in the nav bar for users on this project.
          </p>

          <div className={styles.checkboxList}>
            {CONFIGURABLE_MENU_ITEMS.map((item) => {
              const checked = localViews.includes(item.key);
              return (
                <label
                  key={item.key}
                  className={`${styles.checkboxRow} ${checked ? styles.checkboxRowChecked : ''}`}
                >
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={checked}
                    onChange={() => handleToggle(item.key)}
                    disabled={upsert.isPending}
                  />
                  <span className={styles.checkboxLabel}>{item.label}</span>
                </label>
              );
            })}
          </div>

          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={() => void handleSave()}
              disabled={upsert.isPending}
            >
              {upsert.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {otherConfigured.length > 0 && (
          <div className={styles.summarySection}>
            <p className={styles.summaryTitle}>Other configured projects</p>
            <div className={styles.summaryList}>
              {otherConfigured.map((c) => (
                <div key={c.project} className={styles.summaryItem}>
                  <span className={styles.summaryProject}>{c.project}</span>
                  <span className={styles.summaryViews}>
                    {c.enabledViews.length > 0
                      ? c.enabledViews.join(', ')
                      : '(none enabled)'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
