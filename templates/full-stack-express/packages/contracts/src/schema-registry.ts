import { z } from 'zod';

export interface ContractSchemaMeta {
  id: string;
  description?: string;
}

// Package-local rather than z.globalRegistry: the global registry throws when
// the same id is registered twice, which happens when a test runner evaluates
// this package more than once against one shared zod instance.
export const contractSchemas = z.registry<ContractSchemaMeta>();
