const PROJECT_LISTING_KEY = 'apex-platform-project-listing';

export function markPlatformProjectListing(): void {
  try {
    sessionStorage.setItem(PROJECT_LISTING_KEY, '1');
  } catch {
    /* session storage can be unavailable */
  }
}

export function clearPlatformProjectListing(): void {
  try {
    sessionStorage.removeItem(PROJECT_LISTING_KEY);
  } catch {
    /* session storage can be unavailable */
  }
}

export function hasPlatformProjectListingChoice(): boolean {
  try {
    return sessionStorage.getItem(PROJECT_LISTING_KEY) === '1';
  } catch {
    return false;
  }
}
