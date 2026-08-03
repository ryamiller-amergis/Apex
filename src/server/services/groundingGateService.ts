import type {
  GroundingGateEvaluation,
  GroundingGateId,
  GroundingGateResult,
  GroundingMetricSample,
} from '../../shared/types/groundingOperations';
import { applicationInsightsGroundingMetrics } from './applicationInsightsGroundingMetrics';

const DEFAULT_MINIMUM_SAMPLE_SIZE = 100;

export interface GroundingMetricSampleSource {
  loadSample(
    cohort: string,
    project?: string
  ): Promise<GroundingMetricSample | null>;
}

export interface GroundingGateService {
  evaluate(
    cohort: string,
    project?: string
  ): Promise<GroundingGateEvaluation>;
}

interface GateDefinition {
  id: GroundingGateId;
  label: string;
  threshold: number;
  comparison: GroundingGateResult['comparison'];
  read(sample: GroundingMetricSample): number | null;
  passes(value: number): boolean;
}

const GATES: GateDefinition[] = [
  {
    id: 'fallback-rate',
    label: 'Remote fallback rate',
    threshold: 0.02,
    comparison: '<',
    read: (sample) => sample.fallbackRate,
    passes: (value) => value < 0.02,
  },
  {
    id: 'warm-materialization-p95',
    label: 'Warm materialization P95',
    threshold: 10_000,
    comparison: '<',
    read: (sample) => sample.warmMaterializationP95Ms,
    passes: (value) => value < 10_000,
  },
  {
    id: 'cold-materialization-p95',
    label: 'Cold materialization P95',
    threshold: 60_000,
    comparison: '<',
    read: (sample) => sample.coldMaterializationP95Ms,
    passes: (value) => value < 60_000,
  },
  {
    id: 'mirror-hit-rate',
    label: 'Mirror hit rate',
    threshold: 0.9,
    comparison: '>',
    read: (sample) => sample.mirrorHitRate,
    passes: (value) => value > 0.9,
  },
  {
    id: 'grounding-failures',
    label: 'Grounding-caused failures',
    threshold: 0,
    comparison: '=',
    read: (sample) => sample.groundingFailureCount,
    passes: (value) => value === 0,
  },
];

function evaluateGates(
  sample: GroundingMetricSample | null,
  minimumSampleSize: number
): GroundingGateResult[] {
  const sampleEligible =
    sample !== null && sample.sampleSize >= minimumSampleSize;
  return GATES.map((definition) => {
    const value = sample ? definition.read(sample) : null;
    return {
      id: definition.id,
      label: definition.label,
      value,
      threshold: definition.threshold,
      comparison: definition.comparison,
      status:
        !sampleEligible || value === null || !Number.isFinite(value)
          ? 'unknown'
          : definition.passes(value)
            ? 'pass'
            : 'fail',
    };
  });
}

export function createGroundingGateService(
  source: GroundingMetricSampleSource,
  options: { minimumSampleSize?: number } = {}
): GroundingGateService {
  const minimumSampleSize =
    options.minimumSampleSize ?? DEFAULT_MINIMUM_SAMPLE_SIZE;

  return {
    async evaluate(cohort, project) {
      const sample = project
        ? await source.loadSample(cohort, project)
        : await source.loadSample(cohort);
      const gates = evaluateGates(sample, minimumSampleSize);
      const blockingGates = gates
        .filter((gate) => gate.status !== 'pass')
        .map((gate) => gate.id);
      return {
        cohort,
        sampleSize: sample?.sampleSize ?? 0,
        minimumSampleSize,
        gates,
        eligible: blockingGates.length === 0,
        blockingGates,
      };
    },
  };
}

export const groundingGateService = createGroundingGateService(
  applicationInsightsGroundingMetrics
);
