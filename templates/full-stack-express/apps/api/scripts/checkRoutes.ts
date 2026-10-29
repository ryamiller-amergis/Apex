// routes:check — fails when the API registers a route the contracts package
// does not define, or the contracts define a route the API does not serve.
import { compareRouteInventory } from '@project-scope/contracts';
import { createApp } from '../src/app.ts';
import { createLogger } from '../src/observability/logger.ts';
import { listRegisteredRoutes } from '../src/routes/inventory.ts';

const unused = (): never => {
  throw new Error('routes:check never calls the database');
};

const app = createApp({
  logger: createLogger({ LOG_LEVEL: 'silent' }),
  identityAdapter: { authenticate: () => Promise.resolve(null) },
  persistence: {
    ping: unused,
    users: { findBySubject: unused, create: unused, updateBySubject: unused },
  },
  readinessTimeoutMs: 2000,
});

const registered = listRegisteredRoutes(app);
const result = compareRouteInventory(registered);

if (result.ok) {
  console.log(
    `routes:check: the ${registered.length} registered routes match the contracts`
  );
} else {
  for (const key of result.undocumented) {
    console.error(`routes:check: ${key} is registered but has no contract`);
  }
  for (const key of result.unimplemented) {
    console.error(`routes:check: ${key} has a contract but is not registered`);
  }
  process.exitCode = 1;
}
