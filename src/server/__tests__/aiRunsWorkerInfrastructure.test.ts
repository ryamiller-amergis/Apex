import fs from 'node:fs';
import path from 'node:path';

/**
 * FEAT-003 / TBI-003 / PBI-003 — static Terraform contract assertions.
 * Maps to VT-01, VT-05, VT-07, DoD-0..4, BR-003 (plan-shape checks without apply).
 */
const infraRoot = path.resolve(process.cwd(), 'infra');

function readTf(name: string): string {
  return fs.readFileSync(path.join(infraRoot, name), 'utf8');
}

const workerTf = readTf('ai-runs-worker.tf');
const entraTf = readTf('ai-runs-worker-entra.tf');
const variablesTf = readTf('variables.tf');
const outputsTf = readTf('outputs.tf');
const deployWorkflow = fs.readFileSync(
  path.resolve(process.cwd(), '.github/workflows/deploy.yml'),
  'utf8',
);
const prWorkflow = fs.readFileSync(
  path.resolve(process.cwd(), '.github/workflows/pr-tests.yml'),
  'utf8',
);
const publishScript = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/ci/publish-ai-runs-runner.sh'),
  'utf8',
);

describe('FEAT-003 Secure Ephemeral Background Worker Infrastructure', () => {
  describe('S1 variables & outputs / VT-05', () => {
    it('DoD / VT-05 declares ai_runs_max_in_flight default 10 (governor lockstep)', () => {
      expect(variablesTf).toMatch(
        /variable\s+"ai_runs_max_in_flight"[\s\S]*?default\s*=\s*10/,
      );
    });

    it('S1 / VT-05 outputs the shared cap and API app-setting contract', () => {
      expect(outputsTf).toMatch(/output\s+"ai_runs_max_in_flight"/);
      expect(outputsTf).toMatch(
        /inflight_limit\s*=\s*"AI_RUNS_BACKGROUND_INFLIGHT_LIMIT"/,
      );
      expect(outputsTf).toMatch(
        /background_queue\s*=\s*"AI_RUNS_BACKGROUND_QUEUE_NAME"/,
      );
      expect(outputsTf).toMatch(
        /servicebus_namespace\s*=\s*"AI_RUNS_SERVICEBUS_NAMESPACE"/,
      );
    });

    it('S1 gates AiRun.Runner Entra resources behind enable_ai_runs_entra_app', () => {
      expect(variablesTf).toMatch(/variable\s+"enable_ai_runs_entra_app"/);
    });
  });

  describe('S2 queue + Job + KEDA / VT-01 / AC-0 / AC-2 / BR-003 / DoD-0 / DoD-1', () => {
    it('DoD-0 / VT-01 adds ai-runs-background on the shared AI namespace (not load-test)', () => {
      expect(workerTf).toMatch(
        /azurerm_servicebus_namespace"\s+"ai_runs"/,
      );
      expect(workerTf).toMatch(
        /coalesce\(var\.ai_runs_servicebus_namespace_name,\s*"sbns-apex-ai-\$\{var\.environment\}"\)/,
      );
      expect(workerTf).toMatch(
        /azurerm_servicebus_queue"\s+"ai_runs_background"/,
      );
      expect(workerTf).toMatch(
        /coalesce\(var\.ai_runs_background_queue_name,\s*"ai-runs-background"\)/,
      );
      expect(workerTf).toMatch(/dead_lettering_on_message_expiration\s*=\s*true/);
      expect(workerTf).not.toMatch(/azurerm_servicebus_namespace\.load_test/);
    });

    it('DoD-1 / AC-0 / AC-2 / VT-01 Job is one-message-per-execution with shared cap', () => {
      expect(workerTf).toMatch(/azurerm_container_app_job"\s+"ai_runs_runner"/);
      expect(workerTf).toMatch(/parallelism\s*=\s*1/);
      expect(workerTf).toMatch(/replica_completion_count\s*=\s*1/);
      expect(workerTf).toMatch(/min_executions\s*=\s*0/);
      expect(workerTf).toMatch(/max_executions\s*=\s*var\.ai_runs_max_in_flight/);
      expect(workerTf).toMatch(/messageCount\s*=\s*"1"/);
      expect(workerTf).toMatch(/custom_rule_type\s*=\s*"azure-servicebus"/);
    });
  });

  describe('S3 + S6 RBAC and KEDA auth / VT-07 / DoD-2 / DoD-3 / AC-3', () => {
    it('DoD-2 / DoD-3 / VT-07 scopes receiver and sender to the queue id', () => {
      expect(workerTf).toMatch(
        /azurerm_role_assignment"\s+"ai_runs_runner_sb_receiver"[\s\S]*?scope\s*=\s*azurerm_servicebus_queue\.ai_runs_background\.id[\s\S]*?Azure Service Bus Data Receiver/,
      );
      expect(workerTf).toMatch(
        /azurerm_role_assignment"\s+"ai_runs_api_sb_sender"[\s\S]*?scope\s*=\s*azurerm_servicebus_queue\.ai_runs_background\.id[\s\S]*?Azure Service Bus Data Sender/,
      );
      expect(workerTf).not.toMatch(
        /ai_runs_api_sb_sender[\s\S]*?Azure Service Bus Data Receiver/,
      );
    });

    it('DoD-2 grants Key Vault Secrets User and AcrPull on load-test ACR', () => {
      expect(workerTf).toMatch(
        /azurerm_key_vault"\s+"ai_runs"[\s\S]*?enable_rbac_authorization\s*=\s*true/,
      );
      expect(workerTf).toMatch(
        /azurerm_key_vault_secret"\s+"ai_runs_cursor_api_key"[\s\S]*?value\s*=\s*var\.cursor_api_key/,
      );
      expect(workerTf).toMatch(
        /azurerm_role_assignment"\s+"ai_runs_runner_kv_secrets_user"[\s\S]*?Key Vault Secrets User/,
      );
      expect(workerTf).toMatch(
        /azurerm_role_assignment"\s+"ai_runs_runner_acr_pull"[\s\S]*?scope\s*=\s*azurerm_container_registry\.lt\.id[\s\S]*?AcrPull/,
      );
      expect(workerTf).toMatch(/ai_runs_image_repository\s*=\s*"apex-ai-runs"/);
      expect(workerTf).toMatch(
        /key_vault_secret_id\s*=\s*local\.ai_runs_cursor_api_key_secret_id/,
      );
    });

    it('S6 / VT-01 uses queue-scoped Manage SAS for KEDA poll (not namespace Manage)', () => {
      expect(workerTf).toMatch(
        /azurerm_servicebus_queue_authorization_rule"\s+"ai_runs_keda"/,
      );
      expect(workerTf).toMatch(/manage\s*=\s*true/);
      expect(workerTf).toMatch(
        /secret_name\s*=\s*"ai-runs-keda-sb-connection"/,
      );
      expect(workerTf).not.toMatch(
        /azurerm_servicebus_namespace_authorization_rule"\s+"ai_runs/,
      );
    });
  });

  describe('S4 AiRun.Runner Entra / DoD-4 / AC-3', () => {
    it('DoD-4 provisions AiRun.Runner app role gated by enable_ai_runs_entra_app', () => {
      expect(entraTf).toMatch(/value\s*=\s*"AiRun\.Runner"/);
      expect(entraTf).toMatch(/display_name\s*=\s*"AiRun\.Runner"/);
      expect(entraTf).toMatch(
        /count\s*=\s*var\.enable_ai_runs_entra_app\s*\?\s*1\s*:\s*0/,
      );
      expect(entraTf).toMatch(
        /azuread_app_role_assignment"\s+"ai_runs_runner_ingest"/,
      );
    });
  });

  describe('S5 Azure Files mount / DoD-2', () => {
    it('DoD-2 mounts shared Azure Files at /home/data/ai-pilot/workspaces', () => {
      expect(workerTf).toMatch(/azurerm_storage_share"\s+"ai_runs_workspace"/);
      expect(workerTf).toMatch(
        /azurerm_container_app_environment_storage"\s+"ai_runs_workspace"/,
      );
      expect(variablesTf).toMatch(
        /variable\s+"ai_runs_workspace_mount_path"[\s\S]*?default\s*=\s*"\/home\/data\/ai-pilot\/workspaces"/,
      );
      expect(variablesTf).toMatch(
        /endswith\(\s*var\.ai_runs_workspace_mount_path\s*,\s*"\/workspaces"\s*\)/,
      );
      expect(workerTf).toMatch(/path\s*=\s*var\.ai_runs_workspace_mount_path/);
      // Mount must be the workspaces path, not the data-root parent used for AI_PILOT_DATA_DIR.
      expect(workerTf).not.toMatch(
        /volume_mounts\s*\{[^}]*path\s*=\s*local\.ai_runs_data_dir/s,
      );
      expect(workerTf).toMatch(/AI_PILOT_DATA_DIR/);
      expect(workerTf).toMatch(/value\s*=\s*local\.ai_runs_data_dir/);
    });
  });

  describe('S7 config contract / VT-08 / BR-006', () => {
    it('VT-08 / BR-006 Job and API contract expose payload-free queue identity only', () => {
      expect(workerTf).toMatch(/AI_RUNS_SERVICEBUS_NAMESPACE/);
      expect(workerTf).toMatch(/AI_RUNS_BACKGROUND_QUEUE_NAME/);
      expect(outputsTf).toMatch(/output\s+"ai_runs_api_app_setting_names"/);
      // Prompt / snapshot must never appear as Job env or queue payload wiring.
      expect(workerTf).not.toMatch(/execution_snapshot|EXECUTION_SNAPSHOT|PROMPT/);
    });

    it('S7 wires non-secret AI-runs settings into lower and production deploys', () => {
      for (const workflow of [prWorkflow, deployWorkflow]) {
        expect(workflow).toMatch(
          /AI_RUNS_SERVICEBUS_NAMESPACE="\$\{\{\s*vars\.AI_RUNS_SERVICEBUS_NAMESPACE\s*\}\}"/,
        );
        expect(workflow).toMatch(
          /AI_RUNS_BACKGROUND_QUEUE_NAME="\$\{\{\s*vars\.AI_RUNS_BACKGROUND_QUEUE_NAME\s*\}\}"/,
        );
        expect(workflow).toMatch(
          /AI_RUNS_BACKGROUND_INFLIGHT_LIMIT="\$\{\{\s*vars\.AI_RUNS_BACKGROUND_INFLIGHT_LIMIT\s*\}\}"/,
        );
        expect(workflow).toMatch(
          /AI_RUNS_RUNNER_CALLBACK_TOKEN="\$\{\{\s*secrets\.AI_RUNS_RUNNER_CALLBACK_TOKEN\s*\}\}"/,
        );
      }
    });

    it('S7 publishes the FEAT-004 image only after its Dockerfile exists', () => {
      for (const workflow of [prWorkflow, deployWorkflow]) {
        expect(workflow).toMatch(
          /hashFiles\('runners\/ai-runs\/Dockerfile'\)\s*!=\s*''/,
        );
        expect(workflow).toMatch(
          /bash scripts\/ci\/publish-ai-runs-runner\.sh/,
        );
      }
      expect(publishScript).toMatch(
        /dist\/server\/services\/aiRunsWorker\/entrypoint\.js/,
      );
      expect(publishScript).toMatch(/az containerapp job update/);
      expect(publishScript).toMatch(
        /AI_RUNS_RUNNER_IMAGE_REPO:-apex-ai-runs/,
      );
    });
  });
});
