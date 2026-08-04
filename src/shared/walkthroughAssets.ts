/**
 * Curated walkthrough asset registry (FEAT-004 step 5).
 * Pairs default/inverse logo variants and resolves the correct one by theme.
 */

export interface WalkthroughAssetEntry {
  defaultUrl: string;
  inverseUrl: string;
  description: string;
}

const DARK_FAMILY_THEMES = new Set([
  'dark',
  'amergis',
  'slate',
  'ocean',
  'midnight',
  'dusk',
  'aurora',
  'glacier',
  'ember',
  'haze',
  'neon',
  'volt',
  'plasma',
  'pink',
  'ice',
  'flare',
]);

export const WALKTHROUGH_ASSET_REGISTRY: WalkthroughAssetEntry[] = [
  {
    defaultUrl: '/brand-lockup.svg',
    inverseUrl: '/brand-lockup-inverse.svg',
    description: 'Apex logo',
  },
  {
    defaultUrl: '/brand-lockup-beta.svg',
    inverseUrl: '/brand-lockup-inverse-beta.svg',
    description: 'Apex logo (beta)',
  },
];

/**
 * Returns true when the theme belongs to the dark family.
 * Light-family themes (light, pearl) use the default logo variant.
 */
export function isDarkFamilyTheme(theme: string): boolean {
  return DARK_FAMILY_THEMES.has(theme);
}

/**
 * Find the registry entry whose default or inverse URL matches the given image URL.
 */
export function findWalkthroughAsset(imageUrl: string): WalkthroughAssetEntry | null {
  return (
    WALKTHROUGH_ASSET_REGISTRY.find(
      (entry) => entry.defaultUrl === imageUrl || entry.inverseUrl === imageUrl,
    ) ?? null
  );
}

/**
 * Given an authored image URL and the current theme, return the theme-appropriate variant.
 * Non-registry images pass through unchanged.
 */
export function resolveThemedImageUrl(imageUrl: string, theme: string): string {
  const entry = findWalkthroughAsset(imageUrl);
  if (!entry) return imageUrl;
  return isDarkFamilyTheme(theme) ? entry.inverseUrl : entry.defaultUrl;
}

/**
 * If the imageUrl belongs to a curated asset, return its known description.
 * Otherwise return null (caller decides default).
 */
export function getAssetDescription(imageUrl: string): string | null {
  return findWalkthroughAsset(imageUrl)?.description ?? null;
}
