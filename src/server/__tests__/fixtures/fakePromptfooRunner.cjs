'use strict';
// Stands in for runners/ai-runs-documents-v2/promptfoo/run.cjs in tests.
// A test description containing HANG never replies; CRASH exits without replying.
// An llm-rubric assertion is sent to the parent to grade; the answer is `{ pass, reason }` JSON.
const pending = new Map();
let nextId = 0;

function grade(prompt) {
  return new Promise((resolve) => {
    const id = String(nextId++);
    pending.set(id, resolve);
    process.send({ type: 'grade', id, prompt });
  });
}

async function run(request) {
  const descriptions = request.tests.map((test) => test.description);
  if (descriptions.some((description) => description.includes('HANG'))) {
    setInterval(() => undefined, 1_000);
    return;
  }
  if (descriptions.some((description) => description.includes('CRASH'))) {
    process.stderr.write('runner blew up');
    process.exit(3);
  }
  const rows = [];
  for (const [testIdx, test] of request.tests.entries()) {
    const output = request.targets[test.target];
    const failures = [];
    for (const assertion of test.assert) {
      if (assertion.type === 'contains' && !output.includes(assertion.value)) {
        failures.push({ type: assertion.type, reason: `Expected output to contain "${assertion.value}"` });
      }
      if (assertion.type === 'llm-rubric') {
        const answer = await grade(`Rubric: ${assertion.value}\nOutput: ${output}`);
        const verdict = answer.output ? JSON.parse(answer.output) : { pass: false, reason: answer.error };
        if (!verdict.pass) failures.push({ type: assertion.type, reason: verdict.reason });
      }
    }
    rows.push({ testIdx, success: failures.length === 0, failures });
  }
  process.send(
    {
      ok: true,
      rows,
      gradingEnabled: request.gradingEnabled,
      env: { proxy: process.env.HTTPS_PROXY, secret: process.env.AZURE_CLIENT_SECRET ?? null },
    },
    () => process.exit(0),
  );
}

let started = false;
process.on('message', (message) => {
  if (message && message.type === 'grade-result') {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (resolve) resolve(message);
    return;
  }
  if (started) return;
  started = true;
  void run(message);
});
