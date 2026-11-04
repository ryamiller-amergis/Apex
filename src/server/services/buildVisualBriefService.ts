import { getApprovedDesignPreferenceProfile, seedProfileFromProject } from './designPreferenceProfileService';
import {
  buildVisualBrief,
  formatVisualBriefForPrompt,
  injectVisualRequirements,
  type BuildVisualBrief,
} from '../../shared/buildVisualBrief';
import {
  classifyBuildTaskDomain,
  isUiHeavyDomain,
  type BuildTaskDomain,
} from '../../shared/buildUiClassifier';
import type { BuildRequirement, BuildRiskDecision } from '../../shared/types/build';

export interface PreparedVisualContract {
  domain: BuildTaskDomain;
  requirements: BuildRequirement[];
  brief: BuildVisualBrief | null;
  promptSection: string | null;
}

export async function prepareVisualContract(input: {
  buildRunId: string;
  project: string;
  prompt: string;
  requirements: BuildRequirement[];
  riskDecisions: BuildRiskDecision[];
  skillSettingsId: string | null;
}): Promise<PreparedVisualContract> {
  const domain = classifyBuildTaskDomain(input.prompt, input.requirements);
  if (!isUiHeavyDomain(domain)) {
    return {
      domain,
      requirements: input.requirements,
      brief: null,
      promptSection: null,
    };
  }

  const profileBundle = input.skillSettingsId
    ? await getApprovedDesignPreferenceProfile(input.skillSettingsId)
    : null;
  const profile =
    profileBundle?.profile ??
    seedProfileFromProject({
      friendlyName: null,
      project: input.project,
    });

  const requirements = injectVisualRequirements(input.requirements);
  const brief = buildVisualBrief({
    buildRunId: input.buildRunId,
    taskDomain: domain,
    prompt: input.prompt,
    profile,
  });

  return {
    domain,
    requirements,
    brief,
    promptSection: formatVisualBriefForPrompt(brief),
  };
}
