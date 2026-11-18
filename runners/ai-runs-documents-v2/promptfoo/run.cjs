'use strict';
/**
 * Child process the document worker forks to run one Promptfoo suite
 * (src/server/services/aiRunsV2Worker/promptfooExecution.ts).
 *
 * It resolves `promptfoo` from this folder's own pinned install, receives one
 * request over IPC, replies once and exits. The parent sets the environment:
 * Promptfoo's off switches and a proxy on a closed port.
 *
 * Model-graded assertions (llm-rubric) are graded by the parent: each grading
 * prompt goes up as `{ type: 'grade', id, prompt }` and the answer comes back as
 * `{ type: 'grade-result', id, output | error }`. This process holds no
 * credentials and cannot reach a model itself.
 */

const MODEL_GRADED_TYPES = new Set(['llm-rubric']);
const pendingGrades = new Map();
let nextGradeId = 0;

const parentGrader = {
  id: () => 'apex-worker-grader',
  callApi: (prompt) => new Promise((resolve) => {
    const id = String(nextGradeId++);
    pendingGrades.set(id, resolve);
    process.send({ type: 'grade', id, prompt: String(prompt) });
  }),
};

function onGradeResult(message) {
  const resolve = pendingGrades.get(message.id);
  if (!resolve) return;
  pendingGrades.delete(message.id);
  resolve(typeof message.output === 'string' ? { output: message.output } : { error: String(message.error || 'Grading failed') });
}

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

function withGrader(assertion, gradingEnabled) {
  if (!MODEL_GRADED_TYPES.has(assertion.type)) return assertion;
  if (!gradingEnabled) throw new Error(`Assertion ${assertion.type} needs a grader and none was given`);
  return { ...assertion, provider: parentGrader };
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
        assert: test.assert.map((assertion) => withGrader(assertion, request.gradingEnabled === true)),
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

let started = false;
process.on('message', (message) => {
  if (message && message.type === 'grade-result') {
    onGradeResult(message);
    return;
  }
  if (started) return;
  started = true;
  run(message).then(
    (result) => reply(result, 0),
    (error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1),
  );
});
