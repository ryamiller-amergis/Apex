import type { UiLayoutPattern, UiMockDecision } from './backlog';

export type { UiLayoutPattern, UiMockDecision } from './backlog';

export type DesignPlanStatus =
  | 'generating'
  | 'generation_failed'
  | 'draft'
  | 'ready'
  | 'consumed';

/** How a single PBI is planned to contribute to its feature's UI surface. */
export interface DesignPlanPbiContribution {
  pbiTitle: string;
  /** One-line description of how this PBI shows up in the UI. */
  contribution: string;
}

/** The design decisions planned for a single feature, editable before generation. */
export interface DesignPlanFeature {
  /** Index of the feature within the PRD backlog (matches design_prototypes.featureIndex). */
  featureIndex: number;
  featureName: string;
  /**
   * Plain-English design brief written by the LLM and editable by the reviewer.
   * This is the primary content — describes what the screen looks like, user flows,
   * key interactions, and design decisions in language a UI/UX designer understands.
   * When present, this is the authoritative plan the prototype generator follows.
   */
  designBrief: string;
  /** Whether this feature is a brand-new page, an update to an existing page, or has no UI. */
  decision: UiMockDecision;
  /** Existing MaxView route this feature extends (for 'update-page'). */
  targetRoute?: string;
  /** Human-readable page title shown in the shell header. */
  targetPageTitle?: string;
  /** Broad visual/layout category for this surface. */
  layoutPattern?: UiLayoutPattern;
  /** Design-system component names recommended for this surface. */
  primaryComponents: string[];
  /** UI states to render, e.g. ['default', 'empty', 'error', 'loading']. */
  states: string[];
  /** Per-PBI planned contribution to this feature's surface. */
  pbiContributions: DesignPlanPbiContribution[];
  /** Why these decisions were made. */
  rationale: string;
  /** Free-text notes/instructions the reviewer wants honored during generation. */
  notes?: string;
}

export interface DesignPlanHistoryEntry {
  version: number;
  features: DesignPlanFeature[];
  /** Who saved this version (editor or 'system' for generated versions). */
  editedBy?: string;
  createdAt: string;
}

export interface DesignPlan {
  id: string;
  prdId: string;
  status: DesignPlanStatus;
  version: number;
  features: DesignPlanFeature[];
  /** Hash of the PRD backlogJson the plan was generated from, used for staleness detection. */
  backlogHash?: string | null;
  generationError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignPlanResponse {
  plan: DesignPlan;
  /** True when the PRD backlog has changed since the plan was generated. */
  stale: boolean;
}

export interface SaveDesignPlanRequest {
  features: DesignPlanFeature[];
}

export function designPlanStatusLabel(status: DesignPlanStatus): string {
  switch (status) {
    case 'generating': return 'Generating';
    case 'generation_failed': return 'Generation Failed';
    case 'draft': return 'Draft';
    case 'ready': return 'Ready';
    case 'consumed': return 'Designs Generated';
  }
}
