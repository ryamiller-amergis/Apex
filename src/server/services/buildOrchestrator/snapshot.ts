import type { BuildProfileRole, BuildSkillSnapshot, BuildSupportContact } from '../../../shared/types/build';
import type { FrozenBuildRunConfig } from '../../../shared/types/buildPreflight';

export function snapshotFromFrozen(
  config: FrozenBuildRunConfig,
  modelOverride: string | undefined,
): BuildSkillSnapshot {
  const role = (key: BuildProfileRole) => ({
    model: modelOverride ?? config.roles[key].model,
    skillPath: config.roles[key].skillPath,
    contentHash: config.roles[key].skillSha256,
  });
  const rule = config.standards.codingRules[0];
  if (!rule) {
    throw new Error('Preflight returned a build with no coding rules file.');
  }
  return {
    intake: role('intake'),
    planner: role('planner'),
    implementer: role('implementer'),
    qa: role('qa'),
    check: role('check'),
    designSystemFile: { path: config.standards.designSystem.path, hash: config.standards.designSystem.sha256 },
    codingRules: { path: rule.path, hash: rule.sha256 },
    codeMap: { path: config.standards.codeMap.path, hash: config.standards.codeMap.sha256 },
  };
}

export function contactsFromFrozen(config: FrozenBuildRunConfig): BuildSupportContact[] {
  return config.supportContacts.map((contact) => ({
    userId: contact.userId,
    displayName: contact.displayName,
    email: '',
  }));
}

export function capsFromFrozen(config: FrozenBuildRunConfig): {
  costCapUsd: string;
  elapsedCapSeconds: number;
  parallelismCap: number;
  revisionCap: number;
  qualityManifestSnapshot: FrozenBuildRunConfig['qualityManifest']['commands'];
} {
  return {
    costCapUsd: config.caps.costUsd.toFixed(4),
    elapsedCapSeconds: config.caps.elapsedMinutesPerRevision * 60,
    parallelismCap: config.caps.maxParallelism,
    revisionCap: config.caps.maxRevisions,
    qualityManifestSnapshot: config.qualityManifest.commands,
  };
}
