import type { EffortLevel } from '../../shared/types/effort';
import type {
  InteractiveCapability,
  InteractiveClass,
} from '../../shared/types/durableInteractiveTurn';

export type InteractiveClassificationInput = Readonly<{
  effort: EffortLevel | null;
  skillPath: string | null;
  capabilityMetadata:
    | Readonly<{
        status: 'known';
        capabilities: ReadonlyArray<InteractiveCapability>;
      }>
    | Readonly<{ status: 'unknown' | 'conflicting' | 'uncertain' }>;
}>;

export type InteractiveClassification = Readonly<{
  interactiveClass: InteractiveClass;
  reasons: ReadonlyArray<string>;
}>;

const SKILL_CAPABILITY_RULES = [
  {
    markers: [
      'app-knowledge',
      'grill-with-docs',
      'grill-design',
      'design-module-scoping',
      'walkthrough-',
      'k6-load-test-generation',
      'feature-request-analysis',
      'issue-analysis',
      'technical-analysis',
    ],
    capabilities: ['plain-chat', 'workspace', 'tool-heavy'],
  },
  {
    markers: ['daily-standup'],
    capabilities: ['plain-chat', 'ado', 'mcp', 'tool-heavy'],
  },
  {
    markers: [
      'adr-interview',
      'adr-finalize',
      'to-prd',
      'prd-spec-review',
      'prd-design-spec',
      'design-spec-review',
      'create-test-case',
    ],
    capabilities: ['plain-chat', 'workspace', 'mcp', 'tool-heavy'],
  },
] as const satisfies ReadonlyArray<
  Readonly<{
    markers: ReadonlyArray<string>;
    capabilities: ReadonlyArray<InteractiveCapability>;
  }>
>;

function normalizeSkillPath(skillPath: string | null): string | null {
  if (skillPath === null || skillPath.trim().length === 0) return null;
  return skillPath.trim().replace(/\\/g, '/').toLowerCase();
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

export function classifyInteractiveTurn(
  input: InteractiveClassificationInput
): InteractiveClassification {
  const reasons: string[] = [];
  const capabilities = new Set<InteractiveCapability>();
  const normalizedSkillPath = normalizeSkillPath(input.skillPath);

  if (input.capabilityMetadata.status === 'known') {
    for (const capability of input.capabilityMetadata.capabilities) {
      capabilities.add(capability);
    }
  } else {
    reasons.push(`capability-metadata:${input.capabilityMetadata.status}`);
  }

  if (normalizedSkillPath !== null) {
    const matchingRules = SKILL_CAPABILITY_RULES.filter((rule) =>
      rule.markers.some((marker) => normalizedSkillPath.includes(marker))
    );
    if (matchingRules.length === 0) {
      reasons.push('skill:unregistered');
    } else {
      for (const rule of matchingRules) {
        for (const capability of rule.capabilities) {
          capabilities.add(capability);
        }
      }
    }
  }

  if (input.effort === 'high') {
    reasons.push('effort:high');
  }

  if (
    input.capabilityMetadata.status === 'known' &&
    !capabilities.has('plain-chat')
  ) {
    reasons.push('capability:plain-chat-missing');
  }

  for (const capability of capabilities) {
    if (capability !== 'plain-chat') {
      reasons.push(`capability:${capability}`);
    }
  }

  const normalizedReasons = sortedUnique(reasons);
  if (normalizedReasons.length > 0) {
    return {
      interactiveClass: 'agentic',
      reasons: normalizedReasons,
    };
  }

  return {
    interactiveClass: 'fast',
    reasons: ['capability:plain-chat-only'],
  };
}
