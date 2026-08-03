/**
 * Loads Nutrient Web SDK as a classic UMD script.
 *
 * The published `@nutrient-sdk/viewer` entry is UMD/CJS. Vite's dep optimizer
 * corrupts it, and serving the raw file has no ESM `default` export. Loading
 * the official CDN script (same major/minor as the installed package) and
 * reading `window.NutrientViewer` matches Nutrient's Vite CDN guidance.
 */
import type NutrientViewerDefault from '@nutrient-sdk/viewer';

export type NutrientViewerModule = typeof NutrientViewerDefault;

declare global {
  interface Window {
    NutrientViewer?: NutrientViewerModule;
  }
}

/** Keep in sync with `@nutrient-sdk/viewer` in package.json. */
const NUTRIENT_SCRIPT_SRC =
  'https://cdn.cloud.nutrient.io/pspdfkit-web@1.18.0/nutrient-viewer.js';

let loadPromise: Promise<NutrientViewerModule> | null = null;

export function getNutrientViewer(): Promise<NutrientViewerModule> {
  if (typeof window !== 'undefined' && window.NutrientViewer) {
    return Promise.resolve(window.NutrientViewer);
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<NutrientViewerModule>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-nutrient-sdk="viewer"]'
    );
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.NutrientViewer) resolve(window.NutrientViewer);
        else {
          loadPromise = null;
          reject(
            new Error(
              'Nutrient Web SDK script finished loading but window.NutrientViewer is missing.'
            )
          );
        }
      });
      existing.addEventListener('error', () => {
        loadPromise = null;
        reject(new Error('Failed to load Nutrient Web SDK from CDN.'));
      });
      return;
    }

    const script = document.createElement('script');
    script.src = NUTRIENT_SCRIPT_SRC;
    script.async = true;
    script.dataset.nutrientSdk = 'viewer';
    script.onload = () => {
      if (!window.NutrientViewer) {
        loadPromise = null;
        reject(
          new Error(
            'Nutrient Web SDK loaded but window.NutrientViewer is missing.'
          )
        );
        return;
      }
      resolve(window.NutrientViewer);
    };
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Failed to load Nutrient Web SDK from CDN.'));
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}

export function getNutrientViewerSync(): NutrientViewerModule | null {
  return typeof window !== 'undefined' ? window.NutrientViewer ?? null : null;
}
