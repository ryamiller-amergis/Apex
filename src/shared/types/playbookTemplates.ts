import type { PlaybookGraph } from './playbook';

export const playbookTemplateInstallStates = [
  'not-installed',
  'draft-only',
  'published',
  'update-available',
] as const;

export type PlaybookTemplateInstallState = (typeof playbookTemplateInstallStates)[number];

export const playbookTemplateCostBands = ['low', 'medium', 'high'] as const;

export type PlaybookTemplateCostBand = (typeof playbookTemplateCostBands)[number];

export interface PlaybookTemplateCatalogEntry {
  templateKey: string;
  templateVersion: number;
  displayName: string;
  summary: string;
  category: string;
  tags: string[];
  graphFile: string;
  requiredFlags: string[];
  requiredPermissions: string[];
  /** Shipped templates install once per project. A shared template installs as many times as wanted. */
  installPolicy: 'one-per-project' | 'multiple';
  runInputSchema?: Record<string, unknown>;
  estimatedCostBand?: PlaybookTemplateCostBand;
}

export type PlaybookTemplateSource = 'shipped' | 'shared';

export interface PlaybookTemplateSummary extends PlaybookTemplateCatalogEntry {
  /** Absent on older responses; treat as shipped. */
  source?: PlaybookTemplateSource;
  /** Shared templates: who shared it and when. A snapshot, so later edits to the original never reach it. */
  sharedByName?: string | null;
  sharedAt?: string;
  sourceProject?: string;
  installState: PlaybookTemplateInstallState;
  installedDefinitionId: string | null;
  installedTemplateVersion: number | null;
  stepSummary: string[];
}

export interface PlaybookTemplateDetail extends PlaybookTemplateSummary {
  graph: PlaybookGraph;
}

/** Request body for sharing a published Playbook as a template. Both fields default to the Playbook's own. */
export interface SharePlaybookAsTemplateRequest {
  name?: string;
  summary?: string;
}

export interface SharePlaybookAsTemplateResponse {
  template: PlaybookTemplateSummary;
  /** Project-specific settings that were removed from the copy, one line each. */
  notes: string[];
}

export interface InstallPlaybookTemplateRequest {
  /** Shared templates only. Defaults to the template name; a number is added if the name is taken. */
  name?: string;
}
