import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type QueueContract = {
  kind: 'command' | 'checkpoint' | 'result';
  requiresDuplicateDetection: boolean;
  requiresSession: boolean;
};

type AiPlatformV2Contracts = {
  hostReuse: boolean;
  locationsByEnvironment: Record<string, string>;
  sku: string;
  artifactContainer: string;
  artifactLifecycleDays: number;
  identities: string[];
  queues: Record<string, QueueContract>;
  queueDefaults: {
    maxDeliveryCount: number;
    deadLetteringOnMessageExpiration: boolean;
    lockDuration: string;
    duplicateDetectionHistoryTimeWindow: string;
  };
  cutover: {
    additiveOnly: boolean;
    reuseExistingResourceGroup: boolean;
    reuseExistingServiceBusNamespace: boolean;
    reuseExistingSharedStorage: boolean;
    reuseExistingContainerAppEnvironment: boolean;
  };
};

const contractsPath = resolve(
  __dirname,
  '../../../infra/ai-platform-v2-contracts.json'
);

function loadContracts(): AiPlatformV2Contracts {
  return JSON.parse(
    readFileSync(contractsPath, 'utf8')
  ) as AiPlatformV2Contracts;
}

describe('AI Platform V2 infrastructure contracts', () => {
  const contracts = loadContracts();
  const platformTf = readFileSync(
    resolve(__dirname, '../../../infra/ai-platform-v2.tf'),
    'utf8',
  );

  it('reuses the existing host platform (DEV East US, PROD Central US)', () => {
    expect(contracts.hostReuse).toBe(true);
    expect(contracts.locationsByEnvironment).toEqual({
      dev: 'eastus',
      prd: 'centralus',
    });
    expect(contracts.sku).toBe('Standard');
    expect(platformTf).toMatch(
      /data "azurerm_servicebus_namespace" "ai_platform_v2_host"/,
    );
    expect(platformTf).toMatch(
      /data "azurerm_storage_account" "ai_platform_v2_host"/,
    );
    expect(platformTf).toMatch(
      /data "azurerm_container_app_environment" "ai_platform_v2_host"/,
    );
    expect(platformTf).not.toMatch(
      /resource "azurerm_resource_group" "ai_platform_v2"/,
    );
    expect(platformTf).not.toMatch(
      /resource "azurerm_servicebus_namespace" "ai_platform_v2"/,
    );
    expect(platformTf).not.toMatch(
      /resource "azurerm_storage_account" "ai_platform_v2/,
    );
    expect(platformTf).not.toMatch(/resource "azapi_resource" "ai_platform_v2_cae"/);
  });

  it('enables duplicate detection on command and result queues only', () => {
    const commandAndResult = Object.entries(contracts.queues).filter(
      ([, cfg]) => cfg.kind === 'command' || cfg.kind === 'result'
    );
    const checkpoints = Object.entries(contracts.queues).filter(
      ([, cfg]) => cfg.kind === 'checkpoint'
    );

    expect(commandAndResult.length).toBeGreaterThanOrEqual(3);
    for (const [name, cfg] of commandAndResult) {
      expect(cfg.requiresDuplicateDetection).toBe(true);
      expect(cfg.requiresSession).toBe(false);
      expect(name).toMatch(/^ai-runs-v2-/);
    }

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0][1].requiresDuplicateDetection).toBe(false);
    expect(checkpoints[0][1].requiresSession).toBe(false);
  });

  it('keeps sessions disabled on every V2 queue', () => {
    for (const cfg of Object.values(contracts.queues)) {
      expect(cfg.requiresSession).toBe(false);
    }
  });

  it('defines the private artifact container and lifecycle window', () => {
    expect(contracts.artifactContainer).toBe('ai-run-artifacts');
    expect(contracts.artifactLifecycleDays).toBe(90);
  });

  it('lists the five control-plane identities', () => {
    expect(contracts.identities).toEqual([
      'orchestrator',
      'document',
      'visual',
      'fast-interactive',
      'agentic',
    ]);
  });

  it('records host-reuse cutover (no parallel V2 RG/SB/storage/CAE)', () => {
    expect(contracts.cutover).toEqual({
      additiveOnly: true,
      reuseExistingResourceGroup: true,
      reuseExistingServiceBusNamespace: true,
      reuseExistingSharedStorage: true,
      reuseExistingContainerAppEnvironment: true,
    });
  });

  it('uses V1-compatible queue lock and DLQ defaults', () => {
    expect(contracts.queueDefaults).toEqual({
      maxDeliveryCount: 5,
      deadLetteringOnMessageExpiration: true,
      lockDuration: 'PT5M',
      duplicateDetectionHistoryTimeWindow: 'PT30M',
    });
  });

  it('does not provision Service Bus command queues for interactive classes', () => {
    expect(contracts.queues['ai-runs-v2-fast']).toBeUndefined();
    expect(contracts.queues['ai-runs-v2-agentic']).toBeUndefined();
    expect(Object.keys(contracts.queues)).toEqual([
      'ai-runs-v2-document',
      'ai-runs-v2-visual',
      'ai-runs-v2-checkpoint',
      'ai-runs-v2-result',
    ]);
  });

  it('creates V2 queues on the host namespace data source', () => {
    expect(platformTf).toMatch(
      /namespace_id\s*=\s*data\.azurerm_servicebus_namespace\.ai_platform_v2_host\[0\]\.id/,
    );
  });
});
