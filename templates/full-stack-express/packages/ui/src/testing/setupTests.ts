import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { setViewport } from './setViewport.js';

beforeEach(() => {
  setViewport(1280);
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-mui-color-scheme');
});

afterEach(() => {
  cleanup();
});
