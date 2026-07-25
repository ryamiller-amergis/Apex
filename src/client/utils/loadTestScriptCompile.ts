import type {
  FlowStep,
  LoadProfile,
  LoadTestFlowType,
  Threshold,
} from '../../shared/types/loadTest';

/** Client-only guided form shape used by the definition builder. */
export type GuidedFormStep = {
  method: string;
  path: string;
  headersText?: string;
  body?: string;
  tag?: string;
  extractions?: Array<{
    name: string;
    source: 'json_path' | 'regex';
    expression: string;
  }>;
};

export type GuidedFormState = {
  flowType: LoadTestFlowType;
  steps: GuidedFormStep[];
  loadProfile: LoadProfile;
  clientThresholds: Threshold[];
  /** Base URL placeholder used in compiled script (actual target set on save). */
  targetUrlPlaceholder?: string;
};

export type CompiledGuidedScript = {
  script: string;
  loadProfile: LoadProfile;
  clientThresholds: Threshold[];
  flowSteps: FlowStep[];
};

function parseHeaders(headersText?: string): Record<string, string> | undefined {
  if (!headersText?.trim()) return undefined;
  try {
    const parsed = JSON.parse(headersText) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to line-based parsing
  }
  const headers: Record<string, string> = {};
  for (const line of headersText.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function toFlowSteps(steps: GuidedFormStep[]): FlowStep[] {
  return steps.map((step, index) => ({
    method: step.method.trim().toUpperCase(),
    path: step.path.trim(),
    headers: parseHeaders(step.headersText),
    body: step.body?.trim() ? step.body : undefined,
    extractions: step.extractions?.filter((e) => e.name.trim() && e.expression.trim()),
    tag: step.tag?.trim() || `step_${index + 1}`,
  }));
}

function escapeForTemplate(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function compileExtractionLines(step: FlowStep, responseVar: string): string[] {
  const lines: string[] = [];
  for (const extraction of step.extractions ?? []) {
    if (extraction.source === 'json_path') {
      lines.push(
        `  vars['${escapeForTemplate(extraction.name)}'] = ${responseVar}.json('${escapeForTemplate(extraction.expression)}');`,
      );
    } else {
      lines.push(
        `  {`,
        `    const m = String(${responseVar}.body).match(${JSON.stringify(extraction.expression)});`,
        `    vars['${escapeForTemplate(extraction.name)}'] = m ? m[1] ?? m[0] : undefined;`,
        `  }`,
      );
    }
  }
  return lines;
}

function compileStepRequest(step: FlowStep, index: number): string {
  const tag = step.tag || `step_${index + 1}`;
  const method = step.method.toLowerCase();
  const pathExpr = step.path.startsWith('http')
    ? `\`${escapeForTemplate(step.path)}\``
    : `\`\${__ENV.TARGET_URL}${escapeForTemplate(step.path)}\``;
  const paramsParts = [`tags: { name: '${escapeForTemplate(tag)}' }`];
  if (step.headers) {
    paramsParts.push(`headers: ${JSON.stringify(step.headers)}`);
  }
  const params = `{ ${paramsParts.join(', ')} }`;
  const bodyArg =
    step.body !== undefined ? `\`${escapeForTemplate(step.body)}\`` : 'null';

  const responseVar = `res${index + 1}`;
  const call =
    method === 'get' || method === 'del' || method === 'delete' || method === 'head'
      ? `http.${method === 'delete' ? 'del' : method}(${pathExpr}, ${params})`
      : `http.${method}(${pathExpr}, ${bodyArg}, ${params})`;

  const lines = [
    `  // ${tag}`,
    `  const ${responseVar} = ${call};`,
    `  check(${responseVar}, { '${escapeForTemplate(tag)} status is 2xx': (r) => r.status >= 200 && r.status < 300 });`,
    ...compileExtractionLines(step, responseVar),
  ];
  return lines.join('\n');
}

function thresholdsObject(thresholds: Threshold[]): string {
  const entries = thresholds.map(
    (t) => `    '${escapeForTemplate(t.metric)}': ['${escapeForTemplate(t.expression)}'],`,
  );
  return `{\n${entries.join('\n')}\n  }`;
}

/**
 * Compiles guided builder state into a k6 script + structured profile/thresholds.
 * Persisted `script` is the execution source of truth (BR-005).
 */
export function compileGuidedFormToK6(form: GuidedFormState): CompiledGuidedScript {
  if (!form.steps?.length) {
    throw new Error('At least one step is required to compile a guided load test');
  }
  for (const step of form.steps) {
    if (!step.method?.trim() || !step.path?.trim()) {
      throw new Error('Each step requires a method and path');
    }
  }

  const flowSteps = toFlowSteps(form.steps);
  const profile = form.loadProfile;
  const thresholds = form.clientThresholds;

  const stages =
    profile.stages && profile.stages.length > 0
      ? profile.stages
      : [
          { duration: `${profile.durationMinutes}m`, target: profile.vus },
          { duration: '0s', target: 0 },
        ];

  const rpsLine =
    profile.rpsCap !== undefined
      ? `\n  // Advisory RPS cap: ${profile.rpsCap}`
      : '';

  const stepBlocks = flowSteps.map((step, i) => compileStepRequest(step, i)).join('\n\n');

  const script = `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: ${profile.vus},
  duration: '${profile.durationMinutes}m',
  stages: ${JSON.stringify(stages)},
  thresholds: ${thresholdsObject(thresholds)},
};${rpsLine}

export default function () {
  const vars = {};
${stepBlocks}

  sleep(1);
}
`;

  return {
    script,
    loadProfile: profile,
    clientThresholds: thresholds,
    flowSteps,
  };
}

/** True when regenerating from guided would overwrite a hand-edited raw script (BR-010). */
export function needsConfirmBeforeRegenerate(scriptSource: string | null | undefined): boolean {
  return scriptSource === 'raw';
}
