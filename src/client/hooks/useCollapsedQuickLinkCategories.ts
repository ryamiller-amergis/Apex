import { useCallback, useState } from 'react';

export const collapsedCategoriesStorageKey = (project: string) => `apex.quickLinks.collapsed.${project}`;

function read(project: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(collapsedCategoriesStorageKey(project));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Category sections the user collapsed in the Quick Links menu, remembered per project in
 * localStorage. Keys are opaque strings chosen by the caller (e.g. `project:Tools`).
 */
export function useCollapsedQuickLinkCategories(project: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => read(project));

  const toggle = useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          window.localStorage.setItem(collapsedCategoriesStorageKey(project), JSON.stringify(Array.from(next)));
        } catch {
          // Storage can be full or blocked; the menu still works for this session.
        }
        return next;
      });
    },
    [project],
  );

  return { collapsed, toggle };
}
