/**
 * FEAT-002 — Injectable Microsoft Graph avatar source.
 *
 * Wave 1+2 ships disabled-by-default: avatarResolverService falls through
 * straight to the initials fallback. The interface exists so Graph wiring
 * can be added later (e.g. reading a delegated/app-only Graph client) without
 * touching the resolver's precedence logic.
 */
export interface GraphAvatarSource {
  getProfilePhoto(userOid: string): Promise<{ bytes: Buffer; contentType: string } | null>;
}

export class DisabledGraphAvatarSource implements GraphAvatarSource {
  async getProfilePhoto(): Promise<null> {
    return null;
  }
}

let configuredSource: GraphAvatarSource | undefined;

export function getGraphAvatarSource(): GraphAvatarSource {
  configuredSource ??= new DisabledGraphAvatarSource();
  return configuredSource;
}

export function setGraphAvatarSourceForTests(source?: GraphAvatarSource): void {
  configuredSource = source;
}
