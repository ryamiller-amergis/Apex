import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type QueueContract = {
  kind: 'command' | 'checkpoint' | 'result';
  requiresDuplicateDetection: boolean;
  requiresSession: boolean;
};

type AiPlatformV2Contracts = {
  location: string;
  sku: string;
  zoneRedundant: boolean;
  publicEndpointsForFirstSmoke: boolean;
  privateEndpointsDeferred: boolean;
  workloadProfiles: Array<{
    name: string;
    workloadProfileType: string;
    minimumCount?: number;
    maximumCount?: number;
  }>;
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
    retainEastUsV1ServiceBus: boolean;
    retainEastUsSharedStorage: boolean;
    stopAndDeleteOldOnlyAfterProdProof: boolean;
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

  it('targets Central US with Standard SKU and zone redundancy at creation', () => {
    expect(contracts.location).toBe('centralus');
    expect(contracts.sku).toBe('Standard');
    expect(contracts.zoneRedundant).toBe(true);
  });

  it('declares Consumption and repo-read workload profiles', () => {
    expect(contracts.workloadProfiles.map((profile) => profile.name)).toEqual([
      'Consumption',
      'repo-read',
    ]);
    expect(contracts.workloadProfiles[0].workloadProfileType).toBe(
      'Consumption'
    );
    expect(contracts.workloadProfiles[1]).toMatchObject({
      workloadProfileType: 'D4',
      minimumCount: 1,
      maximumCount: 2,
    });
  });

  it('enables duplicate detection on command and result queues only', () => {
    const commandAndResult = Object.entries(contracts.queues).filter(
      ([, cfg]) => cfg.kind === 'command' || cfg.kind === 'result'
    );
    const checkpoints = Object.entries(contracts.queues).filter(
      ([, cfg]) => cfg.kind === 'checkpoint'
    );

    expect(commandAndResult.length).toBeGreaterThanOrEqual(5);
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

  it('records additive cutover: retain East US V1 until prod proof', () => {
    expect(contracts.cutover).toEqual({
      additiveOnly: true,
      retainEastUsV1ServiceBus: true,
      retainEastUsSharedStorage: true,
      stopAndDeleteOldOnlyAfterProdProof: true,
    });
    expect(contracts.publicEndpointsForFirstSmoke).toBe(true);
    expect(contracts.privateEndpointsDeferred).toBe(true);
  });

  it('uses V1-compatible queue lock and DLQ defaults', () => {
    expect(contracts.queueDefaults).toEqual({
      maxDeliveryCount: 5,
      deadLetteringOnMessageExpiration: true,
      lockDuration: 'PT5M',
      duplicateDetectionHistoryTimeWindow: 'PT30M',
    });
  });
});
