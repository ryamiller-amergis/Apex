import type { RunCheckKind, RunCheckResult } from '../types/agentRunLifecycle';

/**
 * Grades a finished cloud-agent run from the prompt and the signals Apex
 * already stores. The export script writes these grades for promptfoo.
 * Instructions sit at the front of the prompt, so the head is enough to see
 * which rules were sent. Design files after that are left out of the case.
 */
export const CLOUD_AGENT_EVAL_PROMPT_HEAD_CHARS = 6000;

export type CloudAgentEvalKind =
  | 'implementation'
  | 'guided-fix'
  | 'guided-analysis';

export type CloudAgentEvalGrade = 'pass' | 'fail' | 'gap';

export interface CloudAgentEvalCase {
  runId: string;
  project: string;
  finishedAt: string;
  kind: CloudAgentEvalKind;
  title: string;
  status: 'completed' | 'failed' | 'cancelled';
  terminalReason: string | null;
  lastError: string | null;
  model: string | null;
  skillPath: string | null;
  workItemId: number | null;
  branchName: string | null;
  prUrl: string | null;
  prStatus: string | null;
  checkResults: RunCheckResult[] | null;
  /** True when this run is still the session's current run, so leftover work belongs to it. */
  leftoverApplies: boolean;
  incompleteAcceptanceCriteria: string[];
  promptHead: string;
  promptChars: number;
  customPrompt: string | null;
  task: string | null;
}

export interface CloudAgentEvalFinding {
  id: string;
  label: string;
  grade: CloudAgentEvalGrade;
  detail?: string;
}

export interface CloudAgentEvalScore {
  grade: CloudAgentEvalGrade;
  findings: CloudAgentEvalFinding[];
  promptRules: CloudAgentEvalFinding[];
}

export interface CloudAgentEvalRunInput {
  runId: string;
  project: string | null;
  finishedAt: string;
  status: 'completed' | 'failed' | 'cancelled';
  terminalReason: string | null;
  lastError: string | null;
  prompt: string | null;
  model: string | null;
  skillPath: string | null;
  workItemId: number | null;
  workItemTitle: string | null;
  task: string | null;
  branchName: string | null;
  prUrl: string | null;
  prStatus: string | null;
  delivery: 'implementation' | 'guided' | null;
  opensPullRequest: boolean | null;
  checkResults: RunCheckResult[] | null;
  leftoverApplies: boolean;
  incompleteAcceptanceCriteria: string[];
  customPrompt: string | null;
}

export interface CloudAgentEvalSummary {
  total: number;
  pass: number;
  fail: number;
  gap: number;
  byKind: Record<CloudAgentEvalKind, { total: number; pass: number; fail: number; gap: number }>;
  outcomeMisses: Array<{ id: string; label: string; fail: number; gap: number }>;
  promptMisses: Array<{ id: string; label: string; count: number }>;
}

const CHECK_KINDS: readonly RunCheckKind[] = ['unit', 'e2e', 'wcag'];
const DETAIL_CHARS = 500;

const FINDING_LABELS = {
  finished: 'The run finished',
  'pull-request': 'A pull request was opened',
  checks: 'Test results passed',
  'acceptance-criteria': 'Acceptance criteria were covered',
  'analysis-pull-request': 'The analysis run did not open a pull request',
} as const;

interface PromptRule {
  id: string;
  label: string;
  pattern: RegExp;
}

const IMPLEMENTATION_PROMPT_RULES: PromptRule[] = [
  { id: 'prompt-branch', label: 'Prompt locks the branch', pattern: /no other branch/i },
  {
    id: 'prompt-ado-state',
    label: 'Prompt leaves Azure DevOps work item state alone',
    pattern: /do not change azure devops work item state/i,
  },
  {
    id: 'prompt-checks',
    label: 'Prompt asks for unit, e2e, and WCAG checks',
    pattern: /unit, e2e, and wcag/i,
  },
  { id: 'prompt-pull-request', label: 'Prompt asks for a pull request', pattern: /pull request/i },
  { id: 'prompt-skill', label: 'Prompt tells the agent to load the skill', pattern: /load the skill/i },
];

const GUIDED_PROMPT_RULES: PromptRule[] = [
  { id: 'prompt-branch', label: 'Prompt locks the branch', pattern: /no other branch/i },
  {
    id: 'prompt-stop',
    label: 'Prompt says to stop when the cause is unclear',
    pattern: /do not change production code/i,
  },
  { id: 'prompt-regression', label: 'Prompt asks for a regression test', pattern: /regression test/i },
  { id: 'prompt-pull-request', label: 'Prompt asks for a pull request', pattern: /pull request/i },
  { id: 'prompt-skill', label: 'Prompt tells the agent to load the skill', pattern: /load `/i },
];

const PROMPT_RULES: Record<CloudAgentEvalKind, PromptRule[]> = {
  implementation: IMPLEMENTATION_PROMPT_RULES,
  'guided-fix': GUIDED_PROMPT_RULES,
  'guided-analysis': GUIDED_PROMPT_RULES,
};

export function cloudAgentEvalKind(input: {
  delivery?: 'implementation' | 'guided' | null;
  opensPullRequest?: boolean | null;
}): CloudAgentEvalKind {
  if (input.delivery === 'guided') {
    return input.opensPullRequest === true ? 'guided-fix' : 'guided-analysis';
  }
  return 'implementation';
}

function blank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function clip(value: string | null | undefined, max: number): string | null {
  const trimmed = blank(value);
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function shortTitle(value: string | null | undefined, fallback: string): string {
  return clip(value, 80) ?? fallback;
}

function caseTitle(input: CloudAgentEvalRunInput, kind: CloudAgentEvalKind): string {
  if (kind === 'guided-fix' || kind === 'guided-analysis') {
    return shortTitle(input.task, 'Site report');
  }
  if (input.workItemId) return `Work item ${input.workItemId}`;
  return shortTitle(input.workItemTitle, 'Implementation run');
}

function readCloudAgentEvalChecks(
  value: RunCheckResult[] | null | undefined,
): RunCheckResult[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const checks = value.filter((item) => (
    !!item
    && (item.kind === 'unit' || item.kind === 'e2e' || item.kind === 'wcag')
    && (item.outcome === 'passed' || item.outcome === 'failed')
  ));
  return checks.length > 0 ? checks : null;
}

export function toCloudAgentEvalCase(input: CloudAgentEvalRunInput): CloudAgentEvalCase {
  const kind = cloudAgentEvalKind({
    delivery: input.delivery,
    opensPullRequest: input.opensPullRequest,
  });
  const prompt = input.prompt ?? '';
  const title = caseTitle(input, kind);
  return {
    runId: input.runId,
    project: blank(input.project) ?? 'unknown',
    finishedAt: input.finishedAt,
    kind,
    title,
    status: input.status,
    terminalReason: blank(input.terminalReason),
    lastError: clip(input.lastError, DETAIL_CHARS),
    model: blank(input.model),
    skillPath: blank(input.skillPath),
    workItemId: input.workItemId,
    branchName: blank(input.branchName),
    prUrl: blank(input.prUrl),
    prStatus: blank(input.prStatus),
    checkResults: readCloudAgentEvalChecks(input.checkResults),
    leftoverApplies: input.leftoverApplies,
    incompleteAcceptanceCriteria: input.leftoverApplies
      ? input.incompleteAcceptanceCriteria.filter((item) => item.trim())
      : [],
    promptHead: prompt.slice(0, CLOUD_AGENT_EVAL_PROMPT_HEAD_CHARS),
    promptChars: prompt.length,
    customPrompt: clip(input.customPrompt, DETAIL_CHARS),
    task: clip(input.task, DETAIL_CHARS),
  };
}

function finding(
  id: keyof typeof FINDING_LABELS,
  grade: CloudAgentEvalGrade,
  detail?: string,
): CloudAgentEvalFinding {
  return {
    id,
    label: FINDING_LABELS[id],
    grade,
    ...(detail ? { detail } : {}),
  };
}

function rollup(findings: CloudAgentEvalFinding[]): CloudAgentEvalGrade {
  if (findings.some((item) => item.grade === 'fail')) return 'fail';
  if (findings.some((item) => item.grade === 'gap')) return 'gap';
  return 'pass';
}

function scoreFinished(evalCase: CloudAgentEvalCase): CloudAgentEvalFinding {
  if (evalCase.status === 'completed') return finding('finished', 'pass');
  const detail = evalCase.lastError
    ?? (evalCase.terminalReason ? `Terminal reason: ${evalCase.terminalReason}.` : `Status: ${evalCase.status}.`);
  return finding('finished', 'fail', detail);
}

function scorePullRequest(evalCase: CloudAgentEvalCase): CloudAgentEvalFinding {
  if (evalCase.prUrl) return finding('pull-request', 'pass', evalCase.prUrl);
  return finding('pull-request', 'fail', 'No pull request url was stored.');
}

function scoreAnalysisPullRequest(evalCase: CloudAgentEvalCase): CloudAgentEvalFinding {
  if (!evalCase.prUrl) return finding('analysis-pull-request', 'pass');
  return finding('analysis-pull-request', 'fail', evalCase.prUrl);
}

function scoreChecks(evalCase: CloudAgentEvalCase): CloudAgentEvalFinding {
  const results = evalCase.checkResults ?? [];
  if (results.length === 0) {
    return finding('checks', 'gap', 'No test results were stored.');
  }
  const failed = results.filter((result) => result.outcome === 'failed').map((result) => result.kind);
  if (failed.length > 0) {
    return finding('checks', 'fail', `Failed: ${failed.join(', ')}.`);
  }
  if (evalCase.kind === 'implementation') {
    const present = new Set(results.map((result) => result.kind));
    const missing = CHECK_KINDS.filter((kind) => !present.has(kind));
    if (missing.length > 0) {
      return finding('checks', 'gap', `Missing: ${missing.join(', ')}.`);
    }
  }
  return finding('checks', 'pass');
}

function scoreAcceptanceCriteria(evalCase: CloudAgentEvalCase): CloudAgentEvalFinding {
  if (evalCase.incompleteAcceptanceCriteria.length === 0) {
    return finding('acceptance-criteria', 'pass');
  }
  return finding(
    'acceptance-criteria',
    'fail',
    `Left incomplete: ${evalCase.incompleteAcceptanceCriteria.join(', ')}.`,
  );
}

function scorePromptRules(evalCase: CloudAgentEvalCase): CloudAgentEvalFinding[] {
  return PROMPT_RULES[evalCase.kind].map((rule) => {
    const present = rule.pattern.test(evalCase.promptHead);
    return {
      id: rule.id,
      label: rule.label,
      grade: present ? 'pass' : 'gap',
      ...(present ? {} : { detail: 'This text is not in the saved prompt.' }),
    };
  });
}

export function scoreCloudAgentEvalCase(evalCase: CloudAgentEvalCase): CloudAgentEvalScore {
  const findings: CloudAgentEvalFinding[] = [scoreFinished(evalCase)];
  if (evalCase.kind === 'guided-analysis') {
    findings.push(scoreAnalysisPullRequest(evalCase));
    if (evalCase.checkResults) findings.push(scoreChecks(evalCase));
  } else {
    findings.push(scorePullRequest(evalCase));
    findings.push(scoreChecks(evalCase));
  }
  if (evalCase.leftoverApplies) findings.push(scoreAcceptanceCriteria(evalCase));
  return {
    grade: rollup(findings),
    findings,
    promptRules: scorePromptRules(evalCase),
  };
}

function emptyKindCounts(): CloudAgentEvalSummary['byKind'] {
  return {
    implementation: { total: 0, pass: 0, fail: 0, gap: 0 },
    'guided-fix': { total: 0, pass: 0, fail: 0, gap: 0 },
    'guided-analysis': { total: 0, pass: 0, fail: 0, gap: 0 },
  };
}

export function summarizeCloudAgentEval(
  rows: Array<{ kind: CloudAgentEvalKind; score: CloudAgentEvalScore }>,
): CloudAgentEvalSummary {
  const summary: CloudAgentEvalSummary = {
    total: rows.length,
    pass: 0,
    fail: 0,
    gap: 0,
    byKind: emptyKindCounts(),
    outcomeMisses: [],
    promptMisses: [],
  };
  const outcomes = new Map<string, { id: string; label: string; fail: number; gap: number }>();
  const prompts = new Map<string, { id: string; label: string; count: number }>();
  for (const row of rows) {
    summary[row.score.grade] += 1;
    const kindCount = summary.byKind[row.kind];
    kindCount.total += 1;
    kindCount[row.score.grade] += 1;
    for (const item of row.score.findings) {
      if (item.grade === 'pass') continue;
      const current = outcomes.get(item.id) ?? { id: item.id, label: item.label, fail: 0, gap: 0 };
      current[item.grade] += 1;
      outcomes.set(item.id, current);
    }
    for (const rule of row.score.promptRules) {
      if (rule.grade === 'pass') continue;
      const current = prompts.get(rule.id) ?? { id: rule.id, label: rule.label, count: 0 };
      current.count += 1;
      prompts.set(rule.id, current);
    }
  }
  summary.outcomeMisses = [...outcomes.values()];
  summary.promptMisses = [...prompts.values()];
  return summary;
}

function escapePromptfoo(text: string): string {
  return text.split('{{').join('{ {');
}

function listFindings(title: string, findings: CloudAgentEvalFinding[], grade: CloudAgentEvalGrade): string[] {
  const matched = findings.filter((item) => item.grade === grade);
  if (matched.length === 0) return [];
  return [
    title,
    ...matched.map((item) => `- ${item.label}${item.detail ? ` — ${item.detail}` : ''}`),
    '',
  ];
}

export function formatCloudAgentEvalReport(
  evalCase: CloudAgentEvalCase,
  score: CloudAgentEvalScore,
): string {
  const present = score.promptRules.filter((rule) => rule.grade === 'pass').map((rule) => rule.label);
  const missing = score.promptRules.filter((rule) => rule.grade !== 'pass');
  const lines = [
    `${evalCase.kind} · ${evalCase.title} · ${evalCase.runId}`,
    `Project ${evalCase.project} · model ${evalCase.model ?? 'unknown'} · ${evalCase.status}`,
    evalCase.prUrl ? `Pull request: ${evalCase.prUrl}` : 'Pull request: none',
    `Outcome: ${score.grade}`,
    '',
    ...listFindings('Failed', score.findings, 'fail'),
    ...listFindings('Gaps', score.findings, 'gap'),
    ...listFindings('Passed', score.findings, 'pass'),
    'Prompt rules',
    present.length > 0 ? `Present: ${present.join('; ')}` : 'Present: none',
    ...missing.map((rule) => `- Missing: ${rule.label}`),
    '',
    `Prompt (${evalCase.promptChars} characters, first ${evalCase.promptHead.length} shown)`,
    evalCase.promptHead || '(no prompt stored)',
  ];
  return escapePromptfoo(lines.join('\n'));
}

function sampleCase(overrides: Partial<CloudAgentEvalRunInput> & Pick<CloudAgentEvalRunInput, 'runId' | 'status'>): CloudAgentEvalCase {
  return toCloudAgentEvalCase({
    project: 'Apex',
    finishedAt: '2026-10-26T12:00:00.000Z',
    terminalReason: null,
    lastError: null,
    prompt: null,
    model: 'composer-2.5',
    skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
    workItemId: 1842,
    workItemTitle: 'Example',
    task: null,
    branchName: 'feature/apex-1842-example',
    prUrl: 'https://dev.azure.com/example/pullrequest/10',
    prStatus: 'open',
    delivery: null,
    opensPullRequest: null,
    checkResults: [
      { kind: 'unit', outcome: 'passed' },
      { kind: 'e2e', outcome: 'passed' },
      { kind: 'wcag', outcome: 'passed' },
    ],
    leftoverApplies: true,
    incompleteAcceptanceCriteria: [],
    customPrompt: null,
    ...overrides,
  });
}

const IMPLEMENTATION_PROMPT = [
  '/dev-orchestrator',
  'Load the skill from the repository and follow it exactly.',
  'Run unit, e2e, and WCAG checks before opening a pull request.',
  'Work on branch `feature/apex-1842-example` and no other branch.',
  'Open a pull request titled `[APEX] apex-1842-example`.',
  'Do not change Azure DevOps work item state, due date, or due date reason.',
].join('\n');

const GUIDED_PROMPT = [
  '/issue-analysis',
  'Load `.cursor/skills/issue-analysis/SKILL.md` from the repository and follow it.',
  'If you cannot reproduce the problem, do not change production code.',
  'Add a regression test that fails without the fix and passes with it.',
  'Work on branch `feature/apex-site-1` and no other branch.',
  'Open a pull request titled `[APEX] site-1`.',
].join('\n');

/** Synthetic runs so the scorecard can be opened before the database has any. */
export function sampleCloudAgentEvalCases(): CloudAgentEvalCase[] {
  return [
    sampleCase({
      runId: 'sample-pass',
      status: 'completed',
      prompt: IMPLEMENTATION_PROMPT,
    }),
    sampleCase({
      runId: 'sample-fail',
      status: 'failed',
      lastError: 'The cloud agent exited before opening a pull request.',
      prompt: IMPLEMENTATION_PROMPT.replace('Run unit, e2e, and WCAG checks before opening a pull request.\n', ''),
      prUrl: null,
      checkResults: [
        { kind: 'unit', outcome: 'passed' },
        { kind: 'e2e', outcome: 'failed' },
        { kind: 'wcag', outcome: 'passed' },
      ],
      incompleteAcceptanceCriteria: ['AC-9'],
    }),
    sampleCase({
      runId: 'sample-gap',
      status: 'completed',
      prompt: IMPLEMENTATION_PROMPT,
      checkResults: null,
    }),
    sampleCase({
      runId: 'sample-analysis',
      status: 'completed',
      prompt: GUIDED_PROMPT,
      delivery: 'guided',
      opensPullRequest: false,
      workItemId: null,
      task: 'The save button does nothing on the profile page.',
      prUrl: null,
      checkResults: null,
      leftoverApplies: false,
    }),
  ];
}
