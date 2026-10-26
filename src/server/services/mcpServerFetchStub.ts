export interface McpServerFetchStubResult {
  status: number;
  body: string;
}

export type McpServerFetchStub = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<McpServerFetchStubResult>;

let current: McpServerFetchStub | null = null;

export function setMcpServerFetchStub(stub: McpServerFetchStub | null): void {
  current = stub;
}

export function getMcpServerFetchStub(): McpServerFetchStub | null {
  return current;
}

/** Canned Clerk reads for the integrations e2e journey. Never calls the network. */
export async function clerkTicketFetchStub(url: string): Promise<McpServerFetchStubResult> {
  if (url.startsWith('https://api.clerk.com/v1/users?limit=1')) {
    return { status: 200, body: '{"data":[]}' };
  }
  if (url.startsWith('https://api.clerk.com/v1/users?email_address=')) {
    return {
      status: 200,
      body: '[{"id":"user_9","email":"jane@example.com","name":"Jane Ticket"}]',
    };
  }
  return { status: 404, body: '{"error":"integration stub has no response for this URL"}' };
}
