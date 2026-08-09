import type { RepositoryIdentity } from './repoReader';

export type { RepositoryIdentity } from './repoReader';

declare const bundleKeyBrand: unique symbol;

/** Immutable, path-safe Blob key derived from a repository identity. */
export type BundleKey = string & { readonly [bundleKeyBrand]: true };

export interface BundleRef {
  container: string;
  key: BundleKey;
  sha: RepositoryIdentity['sha'];
}

export type MaterializeResult =
  | {
      status: 'materialized';
      source: 'workspace' | 'bundle' | 'repair';
    }
  | {
      status: 'remote-fallback';
      reason:
        | 'feature-disabled'
        | 'bundle-missing'
        | 'bundle-corrupt'
        | 'repair-failed';
    };
