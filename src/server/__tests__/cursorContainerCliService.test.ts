import {
  buildContainerExecutionTemplate,
  mapContainerJobStatus,
  parseContainerActivityLogs,
  parseContainerCliLogs,
  resolveContainerObservation,
} from '../services/cursorContainerCliService';

describe('cursor container CLI', () => {
  it('reads the PR URL out of a JSON job log line', () => {
    const logs = '{"TimeStamp":"2026-09-28T13:06:07Z","Log":"APEX_PR_URL=https://dev.azure.com/Amergis/MaxView/_git/MaxView/pullrequest/4821"}';
    expect(parseContainerCliLogs(logs)).toEqual({
      prUrl: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView/pullrequest/4821',
      noChanges: false,
      branchName: null,
      baseBranch: null,
      summary: null,
      agentExitCode: null,
      settled: false,
      qualityGateFailed: false,
      checkResults: null,
    });
  });

  it('reads a non-zero Cursor CLI exit code', () => {
    const logs = [
      '{"Log":"APEX_AGENT_EXIT=1"}',
      '{"Log":"APEX_PR_URL=https://dev.azure.com/Amergis/MaxView/_git/MaxView/pullrequest/4821"}',
    ].join('\n');
    expect(parseContainerCliLogs(logs)).toEqual(expect.objectContaining({
      agentExitCode: 1,
      prUrl: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView/pullrequest/4821',
    }));
  });

  it('ignores a PR line with no pull request id', () => {
    const logs = '{"Log":"APEX_PR_URL=https://dev.azure.com/Amergis/MaxView/_git/MaxView/pullrequest/"}';
    expect(parseContainerCliLogs(logs).prUrl).toBeNull();
  });

  it('keeps a run live when the CLI exit marker appears before anything is published', () => {
    expect(resolveContainerObservation({
      jobStatus: 'Running',
      prUrl: null,
      noChanges: false,
      agentExitCode: 1,
      settled: false,
    })).toEqual({ status: 'running', resultText: null });
  });

  it('keeps a run live when the pull request is logged before the run has settled', () => {
    expect(resolveContainerObservation({
      jobStatus: 'Running',
      prUrl: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView/pullrequest/4821',
      noChanges: false,
      agentExitCode: null,
      settled: false,
    })).toEqual({ status: 'running', resultText: null });
  });

  it('fails a settled run when the CLI exited non-zero before a pull request exists', () => {
    expect(resolveContainerObservation({
      jobStatus: 'Running',
      prUrl: null,
      noChanges: false,
      agentExitCode: 1,
      settled: true,
    })).toEqual({
      status: 'failed',
      resultText: 'The Cursor CLI exited with code 1.',
    });
  });

  it('fails a settled run when the CLI exited non-zero, and keeps the pull request', () => {
    expect(resolveContainerObservation({
      jobStatus: 'Running',
      prUrl: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView/pullrequest/4821',
      noChanges: false,
      agentExitCode: 1,
      settled: true,
    })).toEqual({
      status: 'failed',
      resultText: 'The Cursor CLI exited with code 1. Its partial changes are in the pull request.',
    });
  });

  it('fails an enforced quality gate before a branch or pull request is created', () => {
    const parsed = parseContainerCliLogs([
      'APEX_CHECK_RESULTS=install=passed;lint=failed;unit=failed',
      'APEX_QUALITY_GATE_FAILED',
      'APEX_RUN_SETTLED',
    ].join('\n'));

    expect(parsed.qualityGateFailed).toBe(true);
    expect(resolveContainerObservation({
      jobStatus: 'Running',
      prUrl: null,
      noChanges: false,
      agentExitCode: null,
      settled: parsed.settled,
      qualityGateFailed: parsed.qualityGateFailed,
    })).toEqual({
      status: 'failed',
      resultText: 'Required quality checks failed. No branch or pull request was created.',
    });
  });

  it('completes a settled run that published a pull request and exited cleanly', () => {
    expect(resolveContainerObservation({
      jobStatus: 'Running',
      prUrl: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView/pullrequest/4821',
      noChanges: false,
      agentExitCode: null,
      settled: true,
    })).toEqual({ status: 'finished', resultText: null });
  });

  it('maps a finished job execution onto the cloud-agent status words', () => {
    expect(mapContainerJobStatus('Succeeded')).toBe('finished');
    expect(mapContainerJobStatus('Failed')).toBe('failed');
    expect(mapContainerJobStatus('Running')).toBe('running');
    expect(mapContainerJobStatus('Stopped')).toBe('cancelled');
  });

  it('replaces the worker command with the CLI script and keeps the Cursor key secret', () => {
    const template = buildContainerExecutionTemplate({
      containers: [{
        name: 'cursor-pool-worker',
        image: 'old',
        command: ['/bin/sh', '-lc'],
        args: ['exec agent worker start'],
        env: [{ name: 'CURSOR_API_KEY', secretRef: 'cursor-api-key' }],
      }],
    }, {
      image: 'example.azurecr.io/apex-cursor-worker:cli-run',
      repoUrl: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView',
      baseBranch: 'development',
      branchName: 'feature/apex-1-abcdef',
      model: 'composer-2.5',
      promptBlobUrl: 'https://stapexdevasync.blob.core.windows.net/cursor-prompts/prompts/abc.txt',
      adoPat: 'secret-pat',
      workItemId: 42,
      workItemTitle: 'Implement login',
      authorName: 'Jane Developer',
      authorEmail: 'jane@example.com',
      adoUserToken: 'developer-token',
    });

    const container = template.containers?.[0];
    expect(container?.command).toEqual(['/bin/bash', '/usr/local/bin/cursor-run-cli']);
    expect(container?.args).toEqual([]);
    expect(container?.image).toBe('example.azurecr.io/apex-cursor-worker:cli-run');
    expect(container?.env).toEqual(expect.arrayContaining([
      { name: 'CURSOR_API_KEY', secretRef: 'cursor-api-key' },
      { name: 'ADO_PAT', value: 'secret-pat' },
      { name: 'REPO_URL', value: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView' },
      { name: 'AGENT_WORK_ITEM_ID', value: '42' },
      { name: 'AGENT_WORK_ITEM_TITLE', value: 'Implement login' },
      { name: 'AGENT_AUTHOR_NAME', value: 'Jane Developer' },
      { name: 'AGENT_AUTHOR_EMAIL', value: 'jane@example.com' },
      { name: 'ADO_USER_TOKEN', value: 'developer-token' },
      { name: 'AGENT_PROMPT_BLOB_URL', value: 'https://stapexdevasync.blob.core.windows.net/cursor-prompts/prompts/abc.txt' },
    ]));
    expect(container?.env?.some((entry) => entry.name === 'AGENT_PROMPT' || entry.name === 'AGENT_SKILL')).toBe(false);
  });

  it('passes the project development skill to the CLI run', () => {
    const template = buildContainerExecutionTemplate({
      containers: [{ name: 'cursor-pool-worker', env: [] }],
    }, {
      image: 'example.azurecr.io/apex-cursor-worker:cli-run',
      repoUrl: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView',
      baseBranch: 'development',
      branchName: 'feature/apex-1-abcdef',
      model: 'composer-2.5',
      promptBlobUrl: 'https://stapexdevasync.blob.core.windows.net/cursor-prompts/prompts/abc.txt',
      adoPat: 'secret-pat',
      skillName: 'dev-orchestrator',
    });

    expect(template.containers?.[0]?.env).toEqual(expect.arrayContaining([
      { name: 'AGENT_SKILL', value: 'dev-orchestrator' },
    ]));
  });

  it('reads agent and tool activity out of container log lines', () => {
    const logs = [
      '{"Log":"APEX_ACTIVITY {\\"id\\":\\"init\\",\\"kind\\":\\"status\\",\\"title\\":\\"Agent started\\",\\"detail\\":\\"Composer\\",\\"status\\":\\"running\\"}"}',
      'APEX_ACTIVITY {"id":"tool:call-1:started","kind":"tool","title":"Read file","detail":"src/app.ts","status":"running"}',
      '{"Log":"not activity"}',
    ].join('\n');

    expect(parseContainerActivityLogs(logs)).toEqual([
      {
        id: 'init',
        kind: 'status',
        title: 'Agent started',
        detail: 'Composer',
        status: 'running',
      },
      {
        id: 'tool:call-1:started',
        kind: 'tool',
        title: 'Read file',
        detail: 'src/app.ts',
        status: 'running',
      },
    ]);
  });

  it('reads the suite check marker without treating a failed check as a missing run', () => {
    const logs = [
      '{"Log":"APEX_CHECK_RESULTS=install=passed;lint=failed;typecheck=passed;unit=passed;build=failed;migrations=passed;e2e=failed;wcag=passed;security=passed"}',
    ].join('\n');

    expect(parseContainerCliLogs(logs).checkResults).toEqual([
      { kind: 'install', outcome: 'passed' },
      { kind: 'lint', outcome: 'failed' },
      { kind: 'typecheck', outcome: 'passed' },
      { kind: 'unit', outcome: 'passed' },
      { kind: 'build', outcome: 'failed' },
      { kind: 'migrations', outcome: 'passed' },
      { kind: 'e2e', outcome: 'failed' },
      { kind: 'wcag', outcome: 'passed' },
      { kind: 'security', outcome: 'passed' },
    ]);
  });

  it('passes draft, required reviewer, and enforced checks only when the run asks for them', () => {
    const drafted = buildContainerExecutionTemplate({
      containers: [{ name: 'cursor-pool-worker', env: [] }],
    }, {
      image: 'example.azurecr.io/apex-cursor-worker:cli-run',
      repoUrl: 'https://dev.azure.com/Amergis/Apex%20-%20Apps/_git/benefits-tracker',
      baseBranch: 'main',
      branchName: 'feature/apex-77-abcdef',
      model: 'composer-2.5',
      promptBlobUrl: 'https://stapexdevasync.blob.core.windows.net/cursor-prompts/prompts/abc.txt',
      adoPat: 'secret-pat',
      draftPullRequest: true,
      requiredReviewerId: 'ryan-oid',
      enforceChecks: true,
    });
    expect(drafted.containers?.[0]?.env).toEqual(expect.arrayContaining([
      { name: 'AGENT_DRAFT_PR', value: '1' },
      { name: 'AGENT_REQUIRED_REVIEWER_ID', value: 'ryan-oid' },
      { name: 'AGENT_ENFORCE_CHECKS', value: '1' },
    ]));

    const plain = buildContainerExecutionTemplate({
      containers: [{ name: 'cursor-pool-worker', env: [] }],
    }, {
      image: 'example.azurecr.io/apex-cursor-worker:cli-run',
      repoUrl: 'https://dev.azure.com/Amergis/MaxView/_git/MaxView',
      baseBranch: 'development',
      branchName: 'feature/apex-1-abcdef',
      model: 'composer-2.5',
      promptBlobUrl: 'https://stapexdevasync.blob.core.windows.net/cursor-prompts/prompts/abc.txt',
      adoPat: 'secret-pat',
    });
    const names = (plain.containers?.[0]?.env ?? []).map((entry) => entry.name);
    expect(names).not.toContain('AGENT_DRAFT_PR');
    expect(names).not.toContain('AGENT_REQUIRED_REVIEWER_ID');
    expect(names).not.toContain('AGENT_ENFORCE_CHECKS');
  });

  it('reads the pushed branch and summary Apex uses to open the pull request', () => {
    const logs = [
      '{"Log":"APEX_BRANCH_PUSHED=feature/apex-42-abc"}',
      '{"Log":"APEX_BASE_BRANCH=development"}',
      '{"Log":"APEX_SUMMARY=Added the login form."}',
    ].join('\n');
    expect(parseContainerCliLogs(logs)).toEqual(expect.objectContaining({
      prUrl: null,
      branchName: 'feature/apex-42-abc',
      baseBranch: 'development',
      summary: 'Added the login form.',
    }));
  });
});
