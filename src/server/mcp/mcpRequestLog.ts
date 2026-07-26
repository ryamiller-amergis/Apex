/**
 * Shared helpers for Streamable HTTP MCP Express mounts (github-repo, ado-skills, etc.).
 */

export function summarizeMcpRpc(body: unknown): string {
  if (!body || typeof body !== 'object') return 'unknown';
  const record = body as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : 'request';
  const params = record.params && typeof record.params === 'object'
    ? record.params as Record<string, unknown>
    : undefined;
  const name = params && typeof params.name === 'string' ? params.name : undefined;
  return name ? `${method}:${name}` : method;
}

export async function handleMcpPost(
  label: string,
  reqBody: unknown,
  run: () => Promise<void>,
): Promise<void> {
  const started = Date.now();
  const summary = summarizeMcpRpc(reqBody);
  console.log(`[${label}] start ${summary}`);
  try {
    await run();
    console.log(`[${label}] ok ${summary} (${Date.now() - started}ms)`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${label}] error ${summary} (${Date.now() - started}ms):`, message);
    throw err;
  }
}
