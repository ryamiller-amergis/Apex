'use strict';
// Stands in for runners/ai-runs-documents-v2/promptfoo/run.cjs in tests.
// A test description containing HANG never replies; CRASH exits without replying.
process.once('message', (request) => {
  const descriptions = request.tests.map((test) => test.description);
  if (descriptions.some((description) => description.includes('HANG'))) {
    setInterval(() => undefined, 1_000);
    return;
  }
  if (descriptions.some((description) => description.includes('CRASH'))) {
    process.stderr.write('runner blew up');
    process.exit(3);
  }
  const rows = request.tests.map((test, testIdx) => {
    const output = request.targets[test.target];
    const failures = test.assert
      .filter((assertion) => assertion.type === 'contains' && !output.includes(assertion.value))
      .map((assertion) => ({ type: assertion.type, reason: `Expected output to contain "${assertion.value}"` }));
    return { testIdx, success: failures.length === 0, failures };
  });
  process.send(
    { ok: true, rows, env: { proxy: process.env.HTTPS_PROXY, secret: process.env.AZURE_CLIENT_SECRET ?? null } },
    () => process.exit(0),
  );
});
