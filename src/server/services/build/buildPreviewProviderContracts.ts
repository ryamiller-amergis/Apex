export type ProviderIdempotencyKey = string;
export type ProviderOperationId = string;
export type ProviderHandle = string;
export type ContentDigest = string;
export type OpaqueGrantRef = string;

export type ProviderAsyncPhase =
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type ProviderErrorCode =
  | 'invalid_argument'
  | 'conflict'
  | 'not_found'
  | 'not_ready'
  | 'timeout'
  | 'quota_exceeded'
  | 'policy_denied'
  | 'provider_unavailable'
  | 'internal_error';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, string>;
}

export interface ProviderMutationRequest {
  idempotencyKey: ProviderIdempotencyKey;
}

export type ProviderMutationResult =
  | {
      ok: true;
      accepted: {
        operationId: ProviderOperationId;
        phase: 'accepted' | 'running';
        handle?: ProviderHandle;
        retryAfterMs?: number;
      };
    }
  | {
      ok: false;
      error: ProviderError;
    };

export interface ProviderInspectResult<TSnapshot> {
  handle: ProviderHandle;
  phase: ProviderAsyncPhase;
  snapshot: TSnapshot | null;
  error: ProviderError | null;
  observedAt: string;
}

export interface ApexPreviewCorrelation {
  previewInstanceId: string;
  buildRunId: string;
  revisionId: string;
  revisionNumber: number;
  validatedCommit: string;
  templateVersion: string;
}

export interface PreviewArtifactBuildSpec {
  correlation: ApexPreviewCorrelation;
  launchSnapshotDigest: ContentDigest;
  buildRecipeDigest: ContentDigest;
}

export interface PreviewArtifactBuildSnapshot {
  spec: PreviewArtifactBuildSpec;
  attestation: {
    digest: ContentDigest;
    sizeBytes: number;
    contentRef: OpaqueGrantRef;
    builtAt: string;
  } | null;
  failureCode: ProviderErrorCode | null;
}

export interface PreviewArtifactProvider {
  startBuild(
    input: ProviderMutationRequest & { spec: PreviewArtifactBuildSpec }
  ): Promise<ProviderMutationResult>;
  inspectBuild(input: {
    handle: ProviderHandle;
  }): Promise<ProviderInspectResult<PreviewArtifactBuildSnapshot>>;
  cancelBuild(
    input: ProviderMutationRequest & { handle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
}

export type SandboxLifecyclePhase =
  | 'provisioning'
  | 'starting'
  | 'running'
  | 'suspended'
  | 'terminating'
  | 'terminated'
  | 'failed'
  | 'expired';

export interface SandboxApplicationTarget {
  upstreamRef: OpaqueGrantRef;
  health: {
    livenessPath: string;
    readinessPath: string;
    applicationPort: number;
  };
}

export interface SandboxProvisionSpec {
  correlation: ApexPreviewCorrelation;
  artifactDigest: ContentDigest;
  runtimeBundleDigest: ContentDigest;
  expiresAt: string;
  policy: {
    egress: 'denied' | 'allowlist';
    allowlistedHosts?: readonly string[];
    maxRuntimeSeconds: number;
  };
}

export interface SandboxSnapshot {
  spec: SandboxProvisionSpec;
  lifecycle: SandboxLifecyclePhase;
  applicationTarget: SandboxApplicationTarget | null;
  bootstrapChannelRef: OpaqueGrantRef | null;
  expiresAt: string;
  failureCode: ProviderErrorCode | null;
}

export interface SandboxProvider {
  provision(
    input: ProviderMutationRequest & { spec: SandboxProvisionSpec }
  ): Promise<ProviderMutationResult>;
  inspect(input: {
    handle: ProviderHandle;
  }): Promise<ProviderInspectResult<SandboxSnapshot>>;
  renew(
    input: ProviderMutationRequest & {
      handle: ProviderHandle;
      expiresAt: string;
    }
  ): Promise<ProviderMutationResult>;
  suspend(
    input: ProviderMutationRequest & { handle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
  resume(
    input: ProviderMutationRequest & { handle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
  destroy(
    input: ProviderMutationRequest & { handle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
}

export type SandboxDataPhase =
  | 'creating'
  | 'migrating'
  | 'seeding'
  | 'ready'
  | 'destroying'
  | 'destroyed'
  | 'failed';

export interface SandboxDataSnapshot {
  phase: SandboxDataPhase;
  databaseHandle: ProviderHandle;
  migrationDigest: ContentDigest | null;
  seedChecksum: ContentDigest | null;
  failureCode: ProviderErrorCode | null;
}

export interface SandboxDataProvider {
  create(
    input: ProviderMutationRequest & {
      correlation: ApexPreviewCorrelation;
      expiresAt: string;
    }
  ): Promise<ProviderMutationResult>;
  migrate(
    input: ProviderMutationRequest & {
      databaseHandle: ProviderHandle;
      migrationArtifactDigest: ContentDigest;
    }
  ): Promise<ProviderMutationResult>;
  seed(
    input: ProviderMutationRequest & {
      databaseHandle: ProviderHandle;
      seedRecipeDigest: ContentDigest;
    }
  ): Promise<ProviderMutationResult>;
  destroy(
    input: ProviderMutationRequest & { databaseHandle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
  inspect(input: {
    databaseHandle: ProviderHandle;
  }): Promise<ProviderInspectResult<SandboxDataSnapshot>>;
}

export interface PreviewGatewayProvider {
  createRoute(
    input: ProviderMutationRequest & {
      correlation: ApexPreviewCorrelation;
      upstream: SandboxApplicationTarget;
      expiresAt: string;
    }
  ): Promise<ProviderMutationResult>;
  inspectRoute(input: { routeHandle: ProviderHandle }): Promise<
    ProviderInspectResult<{
      phase: 'unpublished' | 'published' | 'revoked' | 'failed';
      activePreviewInstanceId: string | null;
    }>
  >;
  probeTransportHealth(input: { routeHandle: ProviderHandle }): Promise<{
    ok: boolean;
    checkedAt: string;
    checks: Readonly<Record<string, 'pass' | 'fail' | 'skipped'>>;
    failureCode: ProviderErrorCode | null;
  }>;
  publish(
    input: ProviderMutationRequest & { routeHandle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
  swap(
    input: ProviderMutationRequest & {
      routeHandle: ProviderHandle;
      previewInstanceId: string;
      artifactDigest: ContentDigest;
      upstream: SandboxApplicationTarget;
    }
  ): Promise<ProviderMutationResult>;
  revoke(
    input: ProviderMutationRequest & { routeHandle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
}

export const EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION = 1;

export const EDITABLE_PREVIEW_REQUIRED_TRANSPORTS = [
  'http',
  'websocket',
  'vite_hmr',
] as const;

export type EditablePreviewTransport =
  (typeof EDITABLE_PREVIEW_REQUIRED_TRANSPORTS)[number];

export type EditablePreviewSessionLifecycle =
  | 'requested'
  | 'materializing'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'applying_change'
  | 'restarting'
  | 'suspended'
  | 'terminating'
  | 'terminated'
  | 'failed'
  | 'expired';

export interface EditablePreviewSessionCorrelation {
  sessionId: string;
  buildRunId: string;
  baseRevisionId: string;
  draftRevisionId: string;
  revisionNumber: number;
  baseCommit: string;
  templateVersion: string;
}

export interface EditablePreviewChangeSet {
  digest: ContentDigest;
  contentRef: OpaqueGrantRef;
}

export interface EditablePreviewSessionSpec {
  contractVersion: typeof EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION;
  correlation: EditablePreviewSessionCorrelation;
  source: {
    snapshotDigest: ContentDigest;
    snapshotRef: OpaqueGrantRef;
  };
  developmentManifestDigest: ContentDigest;
  databaseGrantRef: OpaqueGrantRef;
  expiresAt: string;
  policy: {
    egress: 'denied' | 'allowlist';
    allowlistedHosts?: readonly string[];
    maxRuntimeSeconds: number;
    writableWorkspace: true;
  };
  requiredTransports: readonly EditablePreviewTransport[];
}

export interface EditablePreviewWorkspaceSnapshot {
  writable: boolean;
  version: number;
  baseSnapshotDigest: ContentDigest;
  appliedChangeSets: readonly EditablePreviewChangeSet[];
}

export interface EditablePreviewTransportSnapshot {
  upstreamRef: OpaqueGrantRef;
  checks: Readonly<
    Record<EditablePreviewTransport, 'pending' | 'ready' | 'failed'>
  >;
}

export interface EditablePreviewSessionSnapshot {
  spec: EditablePreviewSessionSpec;
  lifecycle: EditablePreviewSessionLifecycle;
  workspace: EditablePreviewWorkspaceSnapshot;
  transport: EditablePreviewTransportSnapshot | null;
  expiresAt: string;
  failureCode: ProviderErrorCode | null;
}

export type EditablePreviewTask =
  | 'typecheck'
  | 'unit_test'
  | 'quality_check'
  | 'production_build';

export interface EditablePreviewSessionProvider {
  /**
   * Ensures the session identified by spec.correlation.sessionId exists.
   * Adapters must return the existing healthy session after an Apex process
   * restart. A local adapter reconciles its runtime resources; a cloud adapter
   * resolves the same identity through its durable provider control plane.
   */
  start(
    input: ProviderMutationRequest & { spec: EditablePreviewSessionSpec }
  ): Promise<ProviderMutationResult>;
  inspect(input: {
    handle: ProviderHandle;
  }): Promise<ProviderInspectResult<EditablePreviewSessionSnapshot>>;
  applyChangeSet(
    input: ProviderMutationRequest & {
      handle: ProviderHandle;
      expectedWorkspaceVersion: number;
      changeSet: EditablePreviewChangeSet;
    }
  ): Promise<ProviderMutationResult>;
  runTask(
    input: ProviderMutationRequest & {
      handle: ProviderHandle;
      expectedWorkspaceVersion: number;
      task: EditablePreviewTask;
    }
  ): Promise<ProviderMutationResult>;
  renew(
    input: ProviderMutationRequest & {
      handle: ProviderHandle;
      expiresAt: string;
    }
  ): Promise<ProviderMutationResult>;
  suspend(
    input: ProviderMutationRequest & { handle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
  resume(
    input: ProviderMutationRequest & { handle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
  destroy(
    input: ProviderMutationRequest & { handle: ProviderHandle }
  ): Promise<ProviderMutationResult>;
}

export type EditablePreviewReadiness =
  | { ready: true }
  | {
      ready: false;
      reason:
        | 'session_not_ready'
        | 'workspace_not_writable'
        | 'source_not_recoverable'
        | 'transport_missing'
        | 'transport_not_ready'
        | 'provider_location_exposed';
    };

function isProviderNeutralRef(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
    !/^file:/i.test(value) &&
    !/^[a-z]:[\\/]/i.test(value) &&
    !value.startsWith('/') &&
    !value.startsWith('\\\\')
  );
}

export function evaluateEditablePreviewReadiness(
  snapshot: EditablePreviewSessionSnapshot
): EditablePreviewReadiness {
  if (snapshot.lifecycle !== 'ready') {
    return { ready: false, reason: 'session_not_ready' };
  }
  if (!snapshot.workspace.writable) {
    return { ready: false, reason: 'workspace_not_writable' };
  }
  if (
    snapshot.workspace.baseSnapshotDigest !==
      snapshot.spec.source.snapshotDigest ||
    snapshot.workspace.version !== snapshot.workspace.appliedChangeSets.length
  ) {
    return { ready: false, reason: 'source_not_recoverable' };
  }
  if (!snapshot.transport) {
    return { ready: false, reason: 'transport_missing' };
  }
  if (
    !isProviderNeutralRef(snapshot.spec.source.snapshotRef) ||
    !isProviderNeutralRef(snapshot.spec.databaseGrantRef) ||
    !isProviderNeutralRef(snapshot.transport.upstreamRef) ||
    snapshot.workspace.appliedChangeSets.some(
      (changeSet) => !isProviderNeutralRef(changeSet.contentRef)
    )
  ) {
    return { ready: false, reason: 'provider_location_exposed' };
  }
  if (
    EDITABLE_PREVIEW_REQUIRED_TRANSPORTS.some(
      (transport) =>
        !snapshot.spec.requiredTransports.includes(transport) ||
        snapshot.transport?.checks[transport] !== 'ready'
    )
  ) {
    return { ready: false, reason: 'transport_not_ready' };
  }
  return { ready: true };
}
