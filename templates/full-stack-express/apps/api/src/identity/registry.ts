import type { Env } from '../config/env.ts';
import type { IdentityLogger, IdentityProviderAdapter } from './adapter.ts';
import { createDevelopmentAdapter } from './developmentAdapter.ts';
import {
  DevelopmentAdapterInProductionError,
  ExternalAdapterNotRegisteredError,
  IdentityConfigurationError,
} from './errors.ts';

export interface IdentityDeps {
  logger: IdentityLogger;
}

export type ExternalAdapterFactory = (
  deps: IdentityDeps
) => IdentityProviderAdapter;

/**
 * The production identity provider plugs in here, and only here. Replace
 * `undefined` with a factory that returns your IdentityProviderAdapter, then
 * deploy with AUTH_MODE=external. Route handlers do not change.
 */
const registeredExternalAdapter: ExternalAdapterFactory | undefined = undefined;

export interface CreateIdentityAdapterDeps extends IdentityDeps {
  /** Overrides the registered external adapter; for tests. */
  external?: ExternalAdapterFactory;
}

/**
 * Picks the adapter from AUTH_MODE. Call it after loadEnv() and before
 * app.listen(), so a bad configuration stops the process with no port open.
 */
export function createIdentityAdapter(
  env: Pick<Env, 'AUTH_MODE' | 'NODE_ENV'>,
  deps: CreateIdentityAdapterDeps
): IdentityProviderAdapter {
  const mode = env.AUTH_MODE;
  switch (mode) {
    case 'development':
      if (env.NODE_ENV === 'production') {
        throw new DevelopmentAdapterInProductionError();
      }
      return createDevelopmentAdapter({
        nodeEnv: env.NODE_ENV,
        logger: deps.logger,
      });
    case 'external': {
      const factory = deps.external ?? registeredExternalAdapter;
      if (factory === undefined) {
        throw new ExternalAdapterNotRegisteredError();
      }
      return factory({ logger: deps.logger });
    }
    default: {
      const unhandled: never = mode;
      throw new IdentityConfigurationError(
        `Unhandled AUTH_MODE: ${String(unhandled)}`
      );
    }
  }
}
