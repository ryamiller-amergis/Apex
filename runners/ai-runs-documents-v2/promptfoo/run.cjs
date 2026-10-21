'use strict';
/**
 * Child process the document worker forks to run one Promptfoo suite
 * (src/server/services/aiRunsV2Worker/promptfooExecution.ts).
 *
 * It resolves `promptfoo` from this folder's own pinned install, receives one
 * request over IPC, replies once and exits. The parent sets the environment:
 * Promptfoo's off switches and a proxy on a closed port.
 */

function rowFor(result) {
  const componentResults = (result.gradingResult && result.gradingResult.componentResults) || [];
  return {
    testIdx: typeof result.testIdx === 'number' ? result.testIdx : undefined,
    description: result.testCase && result.testCase.description,
    success: result.success === true,
    error: result.error ? String(result.error) : null,
    failures: componentResults
      .filter((component) => !component.pass)
      .map((component) => ({
        type: component.assertion && component.assertion.type,
        reason: component.reason ? String(component.reason) : undefined,
      })),
  };
}

async function run(request) {
  const loaded = await import('promptfoo');
  const promptfoo = loaded.default || loaded;
  const evaluation = await promptfoo.evaluate(
    {
      prompts: ['{{output}}'],
      providers: ['echo'],
      tests: request.tests.map((test) => ({
        description: test.description,
        vars: { output: request.targets[test.target] },
        assert: test.assert,
      })),
      writeLatestResults: false,
      sharing: false,
    },
    { maxConcurrency: 1, cache: false, showProgressBar: false, writeLatestResults: false },
  );
  const summary = await evaluation.toEvaluateSummary();
  return { ok: true, rows: summary.results.map(rowFor) };
}

function reply(message, exitCode) {
  process.send(message, () => process.exit(exitCode));
}

process.once('message', (request) => {
  run(request).then(
    (result) => reply(result, 0),
    (error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1),
  );
});
