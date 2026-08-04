import { evaluateNativeReadCapability } from '../services/nativeReadCapabilityService';

describe('TBI-006 S1 native-read capability proof', () => {
  it('VT-01 proves capability only for a usable SHA-pinned checkout with confinement guards active', () => {
    // Arrange
    const evidence = {
      usableShaPinnedCheckout: true,
      pathConfinementGuardsActive: true,
    };

    // Act
    const first = evaluateNativeReadCapability(evidence);
    const second = evaluateNativeReadCapability(evidence);

    // Assert
    expect(first).toEqual({
      proven: true,
      reason: 'pinned-checkout-confined',
    });
    expect(second).toEqual({
      proven: true,
      reason: 'pinned-checkout-confined',
    });
    expect(second).not.toBe(first);

    first.reason = 'mutated';

    expect(evaluateNativeReadCapability(evidence)).toEqual({
      proven: true,
      reason: 'pinned-checkout-confined',
    });
  });

  it.each([
    {
      evidence: {
        usableShaPinnedCheckout: false,
        pathConfinementGuardsActive: true,
      },
      reason: 'checkout-unusable',
    },
    {
      evidence: {
        usableShaPinnedCheckout: true,
        pathConfinementGuardsActive: false,
      },
      reason: 'path-confinement-unproven',
    },
    {
      evidence: {
        usableShaPinnedCheckout: false,
        pathConfinementGuardsActive: false,
      },
      reason: 'checkout-unusable',
    },
  ])(
    'VT-02 fails closed with $reason',
    ({ evidence, reason }) => {
      // Act
      const result = evaluateNativeReadCapability(evidence);

      // Assert
      expect(result).toEqual({ proven: false, reason });
    }
  );
});
