import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AI Platform V2 split interactive runtime (Terraform)', () => {
  const splitTf = readFileSync(
    resolve(__dirname, '../../../infra/ai-platform-v2-interactive-runtime.tf'),
    'utf8',
  );
  const identitiesTf = readFileSync(
    resolve(__dirname, '../../../infra/ai-platform-v2-identities.tf'),
    'utf8',
  );
  const interactiveTf = readFileSync(
    resolve(__dirname, '../../../infra/ai-runs-interactive.tf'),
    'utf8',
  );
  const runtimeTf = readFileSync(
    resolve(__dirname, '../../../infra/ai-platform-v2-runtime.tf'),
    'utf8',
  );

  it('provisions class-keyed actor hosts with distinct Dapr app IDs', () => {
    expect(splitTf).toMatch(/apex-ai-fast-interactive/);
    expect(splitTf).toMatch(/apex-ai-agentic/);
    expect(splitTf).toMatch(/external_enabled\s*=\s*false/);
    expect(splitTf).toMatch(/path\s*=\s*"\/health"/);
    expect(splitTf).toMatch(
      /container_app_environment_id\s*=\s*data\.azurerm_container_app_environment\.ai_platform_v2_host\[0\]\.id/,
    );
    expect(splitTf).not.toMatch(
      /azurerm_container_app_environment\.ai_runs\.id/,
    );
  });

  it('scopes shared Redis Dapr components to legacy + fast + agentic app IDs', () => {
    expect(interactiveTf).toMatch(
      /ai_platform_v2_interactive_dapr_app_ids\["fast-interactive"\]/,
    );
    expect(interactiveTf).toMatch(
      /ai_platform_v2_interactive_dapr_app_ids\["agentic"\]/,
    );
    expect(splitTf).toMatch(
      /azapi_update_resource" "ai_platform_v2_interactive_dapr_scopes"/,
    );
  });

  it('grants interactive class identities blob/KV/ACR without Service Bus queue receivers', () => {
    expect(identitiesTf).toMatch(/ai-runs-v2-document/);
    expect(identitiesTf).toMatch(/ai-runs-v2-visual/);
    expect(identitiesTf).not.toMatch(/ai-runs-v2-fast/);
    expect(identitiesTf).not.toMatch(/ai-runs-v2-agentic/);
    expect(splitTf).toMatch(/Key Vault Secrets User/);
    expect(splitTf).toMatch(/Storage Blob Data Contributor/);
  });

  it('wires orchestrator dispatch URLs and capacity env from split hosts', () => {
    expect(runtimeTf).toMatch(/AI_RUNS_INTERACTIVE_FAST_DISPATCH_URL/);
    expect(runtimeTf).toMatch(/AI_RUNS_INTERACTIVE_AGENTIC_DISPATCH_URL/);
    expect(runtimeTf).toMatch(/AI_ORCHESTRATOR_INTERACTIVE_CAP/);
    expect(runtimeTf).toMatch(/AI_ORCHESTRATOR_LANE_FLOOR_FAST/);
    expect(runtimeTf).toMatch(/AI_ORCHESTRATOR_LANE_FLOOR_AGENTIC/);
  });
});
