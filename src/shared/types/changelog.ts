export type ChangelogChangeType = 'feature' | 'improvement' | 'bugfix' | 'breaking';

export interface ChangelogChange {
  type: ChangelogChangeType;
  description: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  changes: ChangelogChange[];
}

export interface ChangelogResponse {
  currentVersion: string;
  entries: ChangelogEntry[];
}
