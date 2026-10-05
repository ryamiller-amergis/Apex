import {
  capabilitiesForAccess,
  isUiLabShareNotificationLink,
  resolveUiLabRouteAccess,
  uiLabShareDeepLink,
  uiLabShareDedupeKey,
} from '../../shared/types/uiLab';
import { sanitizeAuthReturnTo, buildLoginUrl } from '../../shared/utils/authReturnTo';

describe('uiLab share helpers', () => {
  it('builds a deep link with project query', () => {
    expect(uiLabShareDeepLink('abc-123', 'MaxView')).toBe('/ui-lab/abc-123?project=MaxView');
  });

  it('detects UI Lab share notification links', () => {
    expect(isUiLabShareNotificationLink('/ui-lab/abc-123?project=MaxView')).toBe(true);
    expect(isUiLabShareNotificationLink('/diagrams/abc')).toBe(false);
  });

  it('builds a stable dedupe key', () => {
    expect(uiLabShareDedupeKey('share-1')).toBe('ui-lab-share:share-1');
  });

  it('maps shared access to view/comment capabilities only', () => {
    const caps = capabilitiesForAccess('shared');
    expect(caps.canViewSource).toBe(true);
    expect(caps.canComment).toBe(true);
    expect(caps.canManage).toBe(false);
    expect(caps.canShare).toBe(false);
    expect(caps.canEditBoundary).toBe(false);
    expect(caps.canRegenerate).toBe(false);
    expect(caps.canDelete).toBe(false);
    expect(caps.canResolveComments).toBe(false);
  });

  it('maps manage access to full capabilities', () => {
    const caps = capabilitiesForAccess('manage');
    expect(caps.canManage).toBe(true);
    expect(caps.canShare).toBe(true);
    expect(caps.canEditBoundary).toBe(true);
  });
});

describe('sanitizeAuthReturnTo', () => {
  it('accepts internal Apex paths', () => {
    expect(sanitizeAuthReturnTo('/ui-lab/abc?project=MaxView')).toBe('/ui-lab/abc?project=MaxView');
    expect(sanitizeAuthReturnTo('/home')).toBe('/home');
  });

  it('rejects external and protocol-relative destinations', () => {
    expect(sanitizeAuthReturnTo('https://evil.example/phish')).toBeNull();
    expect(sanitizeAuthReturnTo('//evil.example/phish')).toBeNull();
    expect(sanitizeAuthReturnTo('/\\evil')).toBeNull();
    expect(sanitizeAuthReturnTo('not-a-path')).toBeNull();
  });

  it('builds a login URL with returnTo', () => {
    expect(buildLoginUrl('/ui-lab/abc?project=MaxView')).toBe(
      '/auth/login?returnTo=%2Fui-lab%2Fabc%3Fproject%3DMaxView',
    );
    expect(buildLoginUrl('https://evil.example')).toBe('/auth/login');
  });
});

describe('resolveUiLabRouteAccess', () => {
  const base = {
    isSuperAdmin: false,
    menuEnabled: true,
    canView: true,
    inUiUxGroup: false,
    isDesignDeepLink: false,
    hasShares: false,
    sharesPending: false,
    projectSwitchPending: false,
  };

  it('waits while the share list is still loading', () => {
    expect(resolveUiLabRouteAccess({ ...base, sharesPending: true })).toBe('wait');
  });

  it('waits while the link project has not been selected yet', () => {
    expect(resolveUiLabRouteAccess({
      ...base,
      isDesignDeepLink: true,
      projectSwitchPending: true,
    })).toBe('wait');
  });

  it('allows a design deep link without waiting for the share list', () => {
    expect(resolveUiLabRouteAccess({
      ...base,
      isDesignDeepLink: true,
      sharesPending: true,
    })).toBe('allow');
  });

  it('allows UI/UX members even without shares', () => {
    expect(resolveUiLabRouteAccess({ ...base, inUiUxGroup: true })).toBe('allow');
  });

  it('allows the shared list once shares have arrived', () => {
    expect(resolveUiLabRouteAccess({ ...base, hasShares: true })).toBe('allow');
  });

  it('denies the shared list when none exist', () => {
    expect(resolveUiLabRouteAccess(base)).toBe('deny');
  });

  it('denies when UI Lab is off for the resolved project', () => {
    expect(resolveUiLabRouteAccess({
      ...base,
      isDesignDeepLink: true,
      menuEnabled: false,
    })).toBe('deny');
  });
});
