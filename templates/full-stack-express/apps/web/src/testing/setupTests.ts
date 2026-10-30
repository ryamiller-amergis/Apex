import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(async () => {
  if (typeof window === 'undefined') {
    return;
  }
  await import('@testing-library/jest-dom/vitest');
  const { setViewport } = await import('./setViewport');
  setViewport(1280);
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.title = '';
});

afterEach(async () => {
  if (typeof window !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
