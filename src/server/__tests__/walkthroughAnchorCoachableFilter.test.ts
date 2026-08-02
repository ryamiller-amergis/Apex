import {
  isCoachableWalkthroughDiscovery,
  isExcludedWalkthroughScanPath,
  isExcludedWalkthroughTestId,
} from '../services/walkthroughAnchorCoachableFilter';

describe('walkthroughAnchorCoachableFilter', () => {
  it('excludes platform-admin and walkthrough management paths', () => {
    expect(
      isExcludedWalkthroughScanPath(
        'src/client/components/WalkthroughAnchorManagement.tsx'
      )
    ).toBe(true);
    expect(
      isExcludedWalkthroughScanPath('src/client/components/PlatformAdmin.tsx')
    ).toBe(true);
    expect(
      isExcludedWalkthroughScanPath('src/client/components/UserMenu.tsx')
    ).toBe(false);
    expect(
      isExcludedWalkthroughScanPath('src/client/components/AdminRoles.tsx')
    ).toBe(false);
  });

  it('excludes walkthrough chrome test ids but keeps product surfaces', () => {
    expect(
      isExcludedWalkthroughTestId('walkthrough-anchor-sync-enrichment-idle')
    ).toBe(true);
    expect(isExcludedWalkthroughTestId('platform-admin-nav')).toBe(true);
    expect(isExcludedWalkthroughTestId('user-menu-trigger')).toBe(false);
    expect(isExcludedWalkthroughTestId('confirm-dialog')).toBe(false);
  });

  it('allows plain data-testid unless excluded (no token allowlist)', () => {
    expect(
      isCoachableWalkthroughDiscovery({
        testId: 'design-module-add-btn',
        sourceKind: 'data_testid',
        sourceLocations: [
          { filePath: 'src/client/components/DesignModuleView.tsx' },
        ],
      })
    ).toBe(true);
    expect(
      isCoachableWalkthroughDiscovery({
        testId: 'xy-zz-1',
        sourceKind: 'data_testid',
        sourceLocations: [{ filePath: 'src/client/components/Foo.tsx' }],
      })
    ).toBe(true);
    expect(
      isCoachableWalkthroughDiscovery({
        testId: 'ado-create-error',
        sourceKind: 'data_testid',
        sourceLocations: [
          { filePath: 'src/client/components/CreateAdoItemsModal.tsx' },
        ],
      })
    ).toBe(true);
    expect(
      isCoachableWalkthroughDiscovery({
        testId: 'walkthrough-anchor-sync-select',
        sourceKind: 'data_testid',
        sourceLocations: [
          { filePath: 'src/client/components/DesignModuleView.tsx' },
        ],
      })
    ).toBe(false);
    expect(
      isCoachableWalkthroughDiscovery({
        testId: 'obscure-widget-x',
        sourceKind: 'explicit',
        sourceLocations: [{ filePath: 'src/client/components/Foo.tsx' }],
      })
    ).toBe(true);
  });
});
