/**
 * VT-08 — fail-closed observability-capture snapshot.
 */
jest.mock('../services/featureFlagService', () => ({
  isFeatureOperational: jest.fn(),
}));

import { isFeatureOperational } from '../services/featureFlagService';
import {
  isObservabilityCaptureEnabled,
  refreshObservabilityCaptureSnapshot,
  setObservabilityCaptureSnapshotForTests,
  stopObservabilityCaptureFlagSnapshot,
} from '../services/observabilityCaptureFlagSnapshot';
import { OBSERVABILITY_CAPTURE_FLAG } from '../../shared/types/observability';

const mockOperational = isFeatureOperational as jest.MockedFunction<typeof isFeatureOperational>;

describe('observabilityCaptureFlagSnapshot', () => {
  afterEach(() => {
    stopObservabilityCaptureFlagSnapshot();
    setObservabilityCaptureSnapshotForTests(false);
    mockOperational.mockReset();
  });

  it('VT-08 fail-closes when flag lookup throws', async () => {
    mockOperational.mockRejectedValue(new Error('db down'));
    await refreshObservabilityCaptureSnapshot();
    expect(isObservabilityCaptureEnabled()).toBe(false);
    expect(mockOperational).toHaveBeenCalledWith(OBSERVABILITY_CAPTURE_FLAG);
  });

  it('enables only after a successful operational snapshot', async () => {
    mockOperational.mockResolvedValue(true);
    await refreshObservabilityCaptureSnapshot();
    expect(isObservabilityCaptureEnabled()).toBe(true);
  });
});
