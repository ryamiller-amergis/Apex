import type { RouteLocation } from '@project-scope/contracts';
import type { Express, Router } from 'express';

// Express 5 layers do not keep the path a router was mounted at, so mount()
// records it here. `null` marks a router that serves no API routes, such as
// the built web client.
const mountPaths = new WeakMap<object, string | null>();

/** Records the prefix of a router; call it for every router given to app.use. */
export function mountedAt<R extends Router>(router: R, prefix: string | null): R {
  mountPaths.set(router, prefix);
  return router;
}

interface Layer {
  name?: string;
  handle?: { stack?: Layer[] };
  route?: { path: unknown; methods: Record<string, boolean> };
}

function walk(stack: readonly Layer[], prefix: string, found: RouteLocation[]) {
  for (const layer of stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) {
          found.push({
            method: method === '_all' ? 'ALL' : method.toUpperCase(),
            path: `${prefix}${String(layer.route.path)}`,
          });
        }
      }
      continue;
    }
    const inner = layer.handle?.stack;
    if (inner === undefined) {
      continue;
    }
    if (!mountPaths.has(layer.handle!)) {
      throw new Error(
        'listRegisteredRoutes: a router was mounted without mountedAt(), so its routes cannot be listed'
      );
    }
    const mount = mountPaths.get(layer.handle!);
    if (mount !== null) {
      walk(inner, `${prefix}${mount ?? ''}`, found);
    }
  }
}

/** Every method and path the app answers, read from Express's own router. */
export function listRegisteredRoutes(app: Express): RouteLocation[] {
  const found: RouteLocation[] = [];
  const router = (app as unknown as { router: { stack: Layer[] } }).router;
  walk(router.stack, '', found);
  return found;
}
