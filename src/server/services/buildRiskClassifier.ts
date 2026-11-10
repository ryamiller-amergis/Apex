/**
 * Numbers brief requirements, rates the agent's risk candidates and classifies the build.
 *
 * Pure: no I/O, no clock, no randomness, and the input is never mutated. A high rating always
 * returns the fixed reversible option for its category, so no branch can emit a destructive one.
 */
import type {
  BuildBriefAnalysis,
  BuildClassificationResult,
  BuildIdCounters,
  BuildRequirement,
  BuildRequirementInput,
  BuildRiskCategory,
  BuildRiskDecision,
  BuildSupportCheckResult,
  BuildSupportStatus,
  RiskCandidate,
} from '../../shared/types/build';
import {
  BUILD_BRIEF_MAX_REQUIREMENTS,
  BUILD_REQUIREMENT_KINDS,
  BUILD_REQUIREMENT_PREFIXES,
  BUILD_REQUIREMENT_TEXT_MAX,
  BUILD_RISK_CATEGORIES,
  BUILD_RISK_DECISION_PREFIX,
  BUILD_RISK_RATINGS,
} from '../../shared/types/build';

export const REVERSIBLE_OPTIONS: Record<BuildRiskCategory, string> = {
  data: 'Use an additive or expand-then-contract migration.',
  access: 'Add the new permission and grant it to no role.',
  integration:
    'Put the new integration behind a feature flag that is off by default.',
  destructive:
    'Make no destructive data operation. Keep the data and mark it inactive.',
};

export class BuildBriefAnalysisError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The brief analysis is invalid: ${problems.join('; ')}`);
    this.name = 'BuildBriefAnalysisError';
    this.problems = problems;
  }
}

export interface AnalyzeBuildBriefInput {
  requirements: readonly BuildRequirementInput[];
  /** Omit to keep `previous.riskDecisions` unchanged (an edit). Pass to rate a fresh draft. */
  riskCandidates?: readonly RiskCandidate[];
  estimatedTasks: number | null;
  needsMigration: boolean;
  previous?: Pick<
    BuildBriefAnalysis,
    'requirements' | 'riskDecisions' | 'counters'
  > | null;
}

const EMPTY_COUNTERS: BuildIdCounters = { AC: 0, DOD: 0, BR: 0, NFR: 0, RD: 0 };
const ID_RE = /^([A-Z]+)-([1-9]\d*)$/;

const UNSUPPORTED_INFRA_RE =
  /\b(kubernetes|k8s|helm\s+chart|kafka\s+cluster|spark\s+cluster|gpu\s+worker|custom\s+vpc|private\s+vnet|multi-region\s+active-active)\b/i;
const CREDENTIALS_OR_WEBHOOK_RE =
  /\b(live\s+(?:api|credentials?|webhook)|oauth\s+client\s+secret|api\s+key|bearer\s+token|webhook\s+secret|workday|salesforce|servicenow|stripe\s+live|twilio|external\s+webhook)\b/i;

function textProblem(label: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${label} is empty`;
  if (value.length > BUILD_REQUIREMENT_TEXT_MAX)
    return `${label} is over ${BUILD_REQUIREMENT_TEXT_MAX} characters`;
  return null;
}

function numberRequirements(
  input: AnalyzeBuildBriefInput,
  counters: BuildIdCounters,
  problems: string[]
): BuildRequirement[] {
  if (input.requirements.length > BUILD_BRIEF_MAX_REQUIREMENTS) {
    problems.push(
      `a brief holds at most ${BUILD_BRIEF_MAX_REQUIREMENTS} requirements`
    );
  }
  const issued = new Set(
    (input.previous?.requirements ?? []).map((row) => row.id)
  );
  const seen = new Set<string>();
  const out: BuildRequirement[] = [];

  input.requirements.forEach((row, index) => {
    const label = `requirement ${index + 1}`;
    if (!BUILD_REQUIREMENT_KINDS.includes(row.kind)) {
      problems.push(`${label} has an unknown kind`);
      return;
    }
    const prefix = BUILD_REQUIREMENT_PREFIXES[
      row.kind
    ] as keyof BuildIdCounters;
    const problem = textProblem(label, row.text);
    if (problem) problems.push(problem);

    let id = row.id;
    if (id === null) {
      counters[prefix] += 1;
      id = `${prefix}-${counters[prefix]}`;
    } else {
      const match = ID_RE.exec(id);
      if (!match || match[1] !== prefix) {
        problems.push(`${label} has ID ${id}, which does not match its kind`);
        return;
      }
      if (input.previous && !issued.has(id)) {
        problems.push(`${label} has ID ${id}, which was never issued`);
        return;
      }
      counters[prefix] = Math.max(counters[prefix], Number(match[2]));
    }
    if (seen.has(id)) {
      problems.push(`${label} has duplicate ID ${id}`);
      return;
    }
    seen.add(id);
    out.push({
      id,
      kind: row.kind,
      text: typeof row.text === 'string' ? row.text.trim() : '',
      retired: false,
    });
  });
  return out;
}

function rateCandidates(
  candidates: readonly RiskCandidate[],
  counters: BuildIdCounters,
  problems: string[]
): BuildRiskDecision[] {
  const out: BuildRiskDecision[] = [];
  candidates.forEach((candidate, index) => {
    const label = `risk decision ${index + 1}`;
    const before = problems.length;
    if (!BUILD_RISK_CATEGORIES.includes(candidate.category))
      problems.push(`${label} has an unknown category`);
    if (!BUILD_RISK_RATINGS.includes(candidate.rating))
      problems.push(`${label} has an unknown rating`);
    const decisionProblem = textProblem(
      `${label} decision`,
      candidate.decision
    );
    if (decisionProblem) problems.push(decisionProblem);
    const rationaleProblem = textProblem(
      `${label} rationale`,
      candidate.rationale
    );
    if (rationaleProblem) problems.push(rationaleProblem);
    if (problems.length > before) return;

    counters.RD += 1;
    const id = `${BUILD_RISK_DECISION_PREFIX}-${counters.RD}`;
    const rating = candidate.destructive === true ? 'high' : candidate.rating;
    if (rating === 'high') {
      out.push({
        id,
        category: candidate.category,
        rating,
        decision: REVERSIBLE_OPTIONS[candidate.category],
        rationale: `${candidate.rationale.trim()} Agent proposed: ${candidate.decision.trim()}`,
        reversible: true,
      });
      return;
    }
    out.push({
      id,
      category: candidate.category,
      rating,
      decision: candidate.decision.trim(),
      rationale: candidate.rationale.trim(),
      reversible: false,
    });
  });
  return out;
}

export function classifyBuildSupport(input: {
  requirements: readonly Pick<BuildRequirement, 'text'>[];
  riskDecisions: readonly BuildRiskDecision[];
  prompt?: string;
}): BuildSupportCheckResult {
  const corpus = [
    input.prompt ?? '',
    ...input.requirements.map((row) => row.text),
    ...input.riskDecisions.map(
      (decision) => `${decision.decision} ${decision.rationale}`
    ),
  ].join('\n');

  const reasons: string[] = [];
  const requiredInputs: string[] = [];
  const approvalGates: string[] = [];

  for (const decision of input.riskDecisions) {
    if (decision.rating === 'high') {
      approvalGates.push(
        `${decision.id} (${decision.category}): ${decision.decision}`
      );
    }
  }

  if (UNSUPPORTED_INFRA_RE.test(corpus)) {
    reasons.push(
      'The request names infrastructure outside the managed full-stack Express + PostgreSQL runtime.'
    );
    requiredInputs.push(
      'Platform architecture review or scope adjustment to the standard Express + PostgreSQL stack.'
    );
    return {
      status: 'unsupported_infrastructure' satisfies BuildSupportStatus,
      reasons,
      requiredInputs,
      approvalGates,
    };
  }

  const hasIntegrationDecision = input.riskDecisions.some(
    (decision) => decision.category === 'integration'
  );
  if (hasIntegrationDecision || CREDENTIALS_OR_WEBHOOK_RE.test(corpus)) {
    reasons.push(
      'The request connects to an external third-party API or webhook that needs credentials or secret bindings.'
    );
    requiredInputs.push(
      'Configure third-party API credentials or use the local deterministic connector adapter until secrets are bound.'
    );
    if (
      !approvalGates.some((gate) => gate.toLowerCase().includes('integration'))
    ) {
      approvalGates.push(
        'Project admin approval for external integration and feature-flag rollout.'
      );
    }
    return {
      status: 'requires_access_or_credentials' satisfies BuildSupportStatus,
      reasons,
      requiredInputs,
      approvalGates,
    };
  }

  return {
    status: 'supported_now' satisfies BuildSupportStatus,
    reasons: [
      'Supported directly by the full-stack Express + PostgreSQL template.',
    ],
    requiredInputs: [],
    approvalGates,
  };
}

export function classifyBuild(
  riskDecisions: readonly BuildRiskDecision[],
  estimatedTasks: number | null,
  needsMigration: boolean
): BuildClassificationResult {
  const reasons: string[] = [];
  const highs = riskDecisions.filter((decision) => decision.rating === 'high');
  const estimateValid =
    typeof estimatedTasks === 'number' &&
    Number.isInteger(estimatedTasks) &&
    estimatedTasks >= 1;

  for (const decision of highs)
    reasons.push(`high-risk decision ${decision.id}`);
  if (needsMigration) reasons.push('migration needed');
  if (estimateValid) {
    reasons.push(
      `estimated ${estimatedTasks} ${estimatedTasks === 1 ? 'task' : 'tasks'}`
    );
  } else {
    reasons.push('task estimate missing');
  }

  const small =
    highs.length === 0 &&
    !needsMigration &&
    estimateValid &&
    (estimatedTasks as number) <= 2;
  return { value: small ? 'small' : 'full', reasons };
}

export function analyzeBuildBrief(
  input: AnalyzeBuildBriefInput
): BuildBriefAnalysis {
  const problems: string[] = [];
  const counters: BuildIdCounters = {
    ...EMPTY_COUNTERS,
    ...(input.previous?.counters ?? {}),
  };

  const requirements = numberRequirements(input, counters, problems);
  const riskDecisions = input.riskCandidates
    ? rateCandidates(input.riskCandidates, counters, problems)
    : (input.previous?.riskDecisions ?? []).map((decision) => ({
        ...decision,
      }));

  if (problems.length > 0) throw new BuildBriefAnalysisError(problems);

  return {
    requirements,
    riskDecisions,
    classification: classifyBuild(
      riskDecisions,
      input.estimatedTasks,
      input.needsMigration
    ),
    counters,
  };
}
