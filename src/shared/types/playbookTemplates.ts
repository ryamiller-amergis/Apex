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
  installPolicy: 'one-per-project';
  runInputSchema?: Record<string, unknown>;
  estimatedCostBand?: PlaybookTemplateCostBand;
}

export interface PlaybookTemplateSummary extends PlaybookTemplateCatalogEntry {
  installState: PlaybookTemplateInstallState;
  installedDefinitionId: string | null;
  installedTemplateVersion: number | null;
  stepSummary: string[];
}

export interface PlaybookTemplateDetail extends PlaybookTemplateSummary {
  graph: PlaybookGraph;
}
