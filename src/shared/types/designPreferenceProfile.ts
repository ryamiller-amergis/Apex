export const DESIGN_PREFERENCE_PROPOSAL_SOURCES = [
  'build_preview',
  'build_revision',
  'prototype_revision',
  'ui_lab',
  'manual',
] as const;

export type DesignPreferenceProposalSource =
  (typeof DESIGN_PREFERENCE_PROPOSAL_SOURCES)[number];

export const DESIGN_PREFERENCE_PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'superseded',
] as const;

export type DesignPreferenceProposalStatus =
  (typeof DESIGN_PREFERENCE_PROPOSAL_STATUSES)[number];

export type DesignPreferenceVisualTone = 'professional' | 'modern' | 'compact';
export type DesignPreferenceDensity = 'comfortable' | 'compact';
export type DesignPreferenceNavigationPattern = 'sidebar' | 'top';
export type DesignPreferenceIconPreference = 'mui-outlined' | 'custom';

export interface DesignPreferenceProfile {
  appName: string | null;
  productName: string | null;
  visualTone: DesignPreferenceVisualTone | null;
  density: DesignPreferenceDensity | null;
  navigationPattern: DesignPreferenceNavigationPattern | null;
  iconPreference: DesignPreferenceIconPreference | null;
  preferredPatterns: string[];
  avoidedPatterns: string[];
  logoPath: string | null;
  faviconPath: string | null;
}

export interface DesignPreferenceProfileResponse {
  settingsId: string;
  project: string;
  profile: DesignPreferenceProfile;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface DesignPreferenceProposalView {
  id: string;
  settingsId: string;
  proposedProfile: DesignPreferenceProfile;
  source: DesignPreferenceProposalSource;
  sourceRef: string | null;
  feedbackExcerpt: string | null;
  status: DesignPreferenceProposalStatus;
  createdAt: string;
  createdBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

export function emptyDesignPreferenceProfile(): DesignPreferenceProfile {
  return {
    appName: null,
    productName: null,
    visualTone: 'professional',
    density: 'comfortable',
    navigationPattern: 'sidebar',
    iconPreference: 'mui-outlined',
    preferredPatterns: [],
    avoidedPatterns: [],
    logoPath: null,
    faviconPath: null,
  };
}
