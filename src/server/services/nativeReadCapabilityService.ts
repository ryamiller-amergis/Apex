import type { NativeReadCapabilityResult } from '../../shared/types/groundingOperations';

export interface NativeReadCapabilityEvidence {
  usableShaPinnedCheckout: boolean;
  pathConfinementGuardsActive: boolean;
}

export function evaluateNativeReadCapability(
  evidence: NativeReadCapabilityEvidence
): NativeReadCapabilityResult {
  if (!evidence.usableShaPinnedCheckout) {
    return {
      proven: false,
      reason: 'checkout-unusable',
    };
  }

  if (!evidence.pathConfinementGuardsActive) {
    return {
      proven: false,
      reason: 'path-confinement-unproven',
    };
  }

  return {
    proven: true,
    reason: 'pinned-checkout-confined',
  };
}
