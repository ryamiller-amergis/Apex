import {
  cloudAgentEvalKind,
  formatCloudAgentEvalReport,
  sampleCloudAgentEvalCases,
  scoreCloudAgentEvalCase,
  summarizeCloudAgentEval,
  toCloudAgentEvalCase,
} from '../cloudAgentEval';

describe('cloudAgentEvalKind', () => {
  it('treats an omitted delivery as an implementation run', () => {
    expect(cloudAgentEvalKind({ delivery: null, opensPullRequest: null })).toBe('implementation');
  });

  it('keeps a guided run in analysis until it is marked to open a pull request', () => {
    expect(cloudAgentEvalKind({ delivery: 'guided', opensPullRequest: null })).toBe('guided-analysis');
    expect(cloudAgentEvalKind({ delivery: 'guided', opensPullRequest: true })).toBe('guided-fix');
  });
});

describe('scoreCloudAgentEvalCase', () => {
  const samples = Object.fromEntries(
    sampleCloudAgentEvalCases().map((evalCase) => [evalCase.runId, evalCase]),
  );

  it('passes an implementation run that finished, opened a pull request, and reported all checks', () => {
    const score = scoreCloudAgentEvalCase(samples['sample-pass']);
    expect(score.grade).toBe('pass');
    expect(score.promptRules.every((rule) => rule.grade === 'pass')).toBe(true);
  });

  it('fails when the run stopped, skipped the pull request, failed e2e, and left an acceptance criterion', () => {
    const score = scoreCloudAgentEvalCase(samples['sample-fail']);
    expect(score.grade).toBe('fail');
    expect(score.findings.find((item) => item.id === 'checks')?.detail).toBe('Failed: e2e.');
    expect(score.findings.find((item) => item.id === 'acceptance-criteria')?.detail).toContain('AC-9');
    expect(score.promptRules.find((rule) => rule.id === 'prompt-checks')?.grade).toBe('gap');
  });

  it('marks missing test results as a gap when the run otherwise finished', () => {
    expect(scoreCloudAgentEvalCase(samples['sample-gap']).grade).toBe('gap');
  });

  it('passes a guided analysis run that finished without a pull request', () => {
    const score = scoreCloudAgentEvalCase(samples['sample-analysis']);
    expect(score.grade).toBe('pass');
    expect(samples['sample-analysis'].title).toBe('The save button does nothing on the profile page.');
  });

  it('fails a guided analysis run that opened a pull request', () => {
    const score = scoreCloudAgentEvalCase({
      ...samples['sample-analysis'],
      prUrl: 'https://dev.azure.com/example/pullrequest/11',
    });
    expect(score.grade).toBe('fail');
    expect(score.findings.find((item) => item.id === 'analysis-pull-request')?.grade).toBe('fail');
  });

  it('names the failed checks in the report', () => {
    const evalCase = samples['sample-fail'];
    const report = formatCloudAgentEvalReport(evalCase, scoreCloudAgentEvalCase(evalCase));
    expect(report).toContain('Failed: e2e.');
    expect(report).toContain('Missing: Prompt asks for unit, e2e, and WCAG checks');
  });
});

describe('toCloudAgentEvalCase', () => {
  it('ignores leftover work that belongs to a later run on the same session', () => {
    const evalCase = toCloudAgentEvalCase({
      runId: 'run-1',
      project: 'Apex',
      finishedAt: '2026-10-26T12:00:00.000Z',
      status: 'completed',
      terminalReason: null,
      lastError: null,
      prompt: 'Load the skill',
      model: 'composer-2.5',
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      workItemId: 10,
      workItemTitle: 'Example',
      task: null,
      branchName: 'feature/apex-10-example',
      prUrl: 'https://example.test/pr/1',
      prStatus: 'open',
      delivery: null,
      opensPullRequest: null,
      checkResults: [{ kind: 'unit', outcome: 'passed' }],
      leftoverApplies: false,
      incompleteAcceptanceCriteria: ['AC-1'],
      customPrompt: null,
    });
    expect(evalCase.incompleteAcceptanceCriteria).toEqual([]);
    expect(evalCase.title).toBe('Work item 10');
  });
});

describe('summarizeCloudAgentEval', () => {
  it('counts outcome misses and missing prompt rules across the sample runs', () => {
    const summary = summarizeCloudAgentEval(
      sampleCloudAgentEvalCases().map((evalCase) => ({
        kind: evalCase.kind,
        score: scoreCloudAgentEvalCase(evalCase),
      })),
    );
    expect(summary).toMatchObject({ total: 4, pass: 2, fail: 1, gap: 1 });
    expect(summary.outcomeMisses.find((miss) => miss.id === 'checks')).toMatchObject({
      fail: 1,
      gap: 1,
    });
    expect(summary.promptMisses.find((miss) => miss.id === 'prompt-checks')?.count).toBe(1);
  });
});
