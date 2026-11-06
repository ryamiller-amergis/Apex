import type { Profile, UpdateProfileBody } from '@project-scope/contracts';
import { sampleProfile } from '../testing/profileFixture';

const previewProfile: Profile = { ...sampleProfile };

/** In-memory profile for Apex-hosted static previews (no API writes). */
export function readPreviewProfile(): Profile {
  return { ...previewProfile };
}

export function writePreviewProfile(body: UpdateProfileBody): Profile {
  previewProfile.displayName = body.displayName;
  previewProfile.email = body.email ?? null;
  return { ...previewProfile };
}
