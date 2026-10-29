export const EXTERNAL_ADAPTER_NOT_REGISTERED_MESSAGE =
  'AUTH_MODE=external requires an adapter registered in apps/api/src/identity/registry.ts.';

/** Any identity configuration problem that must stop startup before the port opens. */
export class IdentityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigurationError';
  }
}

export class DevelopmentAdapterInProductionError extends IdentityConfigurationError {
  constructor() {
    super(
      'Invalid environment: AUTH_MODE=development is not allowed when NODE_ENV=production.'
    );
    this.name = 'DevelopmentAdapterInProductionError';
  }
}

export class ExternalAdapterNotRegisteredError extends IdentityConfigurationError {
  constructor() {
    super(EXTERNAL_ADAPTER_NOT_REGISTERED_MESSAGE);
    this.name = 'ExternalAdapterNotRegisteredError';
  }
}
