import {
  findWalkthroughAsset,
  getAssetDescription,
  isDarkFamilyTheme,
  resolveThemedImageUrl,
  WALKTHROUGH_ASSET_REGISTRY,
} from '../../shared/walkthroughAssets';

describe('walkthroughAssets', () => {
  describe('isDarkFamilyTheme', () => {
    it.each(['dark', 'amergis', 'midnight', 'dusk', 'aurora'])(
      'returns true for dark-family theme "%s"',
      (theme) => {
        expect(isDarkFamilyTheme(theme)).toBe(true);
      },
    );

    it('returns false for light theme', () => {
      expect(isDarkFamilyTheme('light')).toBe(false);
    });

    it('returns false for unknown themes', () => {
      expect(isDarkFamilyTheme('custom')).toBe(false);
    });
  });

  describe('findWalkthroughAsset', () => {
    it('finds entry by default URL', () => {
      const entry = findWalkthroughAsset('/brand-lockup.svg');
      expect(entry).not.toBeNull();
      expect(entry!.description).toBe('Apex logo');
    });

    it('finds entry by inverse URL', () => {
      const entry = findWalkthroughAsset('/brand-lockup-inverse.svg');
      expect(entry).not.toBeNull();
      expect(entry!.description).toBe('Apex logo');
    });

    it('finds beta entry', () => {
      const entry = findWalkthroughAsset('/brand-lockup-beta.svg');
      expect(entry).not.toBeNull();
      expect(entry!.description).toBe('Apex logo (beta)');
    });

    it('returns null for non-registry URL', () => {
      expect(findWalkthroughAsset('/some-other-image.png')).toBeNull();
    });
  });

  describe('resolveThemedImageUrl', () => {
    it('returns default variant for light theme', () => {
      expect(resolveThemedImageUrl('/brand-lockup.svg', 'light')).toBe('/brand-lockup.svg');
    });

    it('returns inverse variant for dark theme', () => {
      expect(resolveThemedImageUrl('/brand-lockup.svg', 'dark')).toBe('/brand-lockup-inverse.svg');
    });

    it('returns inverse variant for amergis theme', () => {
      expect(resolveThemedImageUrl('/brand-lockup.svg', 'amergis')).toBe(
        '/brand-lockup-inverse.svg',
      );
    });

    it('returns inverse variant for midnight theme', () => {
      expect(resolveThemedImageUrl('/brand-lockup.svg', 'midnight')).toBe(
        '/brand-lockup-inverse.svg',
      );
    });

    it('returns inverse variant for dusk theme', () => {
      expect(resolveThemedImageUrl('/brand-lockup-beta.svg', 'dusk')).toBe(
        '/brand-lockup-inverse-beta.svg',
      );
    });

    it('returns inverse variant for aurora theme', () => {
      expect(resolveThemedImageUrl('/brand-lockup-beta.svg', 'aurora')).toBe(
        '/brand-lockup-inverse-beta.svg',
      );
    });

    it('resolves from inverse URL back to default for light theme', () => {
      expect(resolveThemedImageUrl('/brand-lockup-inverse.svg', 'light')).toBe(
        '/brand-lockup.svg',
      );
    });

    it('passes through non-registry URLs unchanged', () => {
      expect(resolveThemedImageUrl('/custom/banner.png', 'dark')).toBe('/custom/banner.png');
      expect(resolveThemedImageUrl('https://example.com/img.svg', 'light')).toBe(
        'https://example.com/img.svg',
      );
    });
  });

  describe('getAssetDescription', () => {
    it('returns description for a curated asset', () => {
      expect(getAssetDescription('/brand-lockup.svg')).toBe('Apex logo');
      expect(getAssetDescription('/brand-lockup-inverse-beta.svg')).toBe('Apex logo (beta)');
    });

    it('returns null for non-registry URLs', () => {
      expect(getAssetDescription('/random.png')).toBeNull();
    });
  });

  describe('registry completeness', () => {
    it('contains at least the brand lockup and beta entries', () => {
      expect(WALKTHROUGH_ASSET_REGISTRY.length).toBeGreaterThanOrEqual(2);
    });

    it('every entry has both default and inverse URLs', () => {
      for (const entry of WALKTHROUGH_ASSET_REGISTRY) {
        expect(entry.defaultUrl).toBeTruthy();
        expect(entry.inverseUrl).toBeTruthy();
        expect(entry.defaultUrl).not.toBe(entry.inverseUrl);
      }
    });
  });
});
