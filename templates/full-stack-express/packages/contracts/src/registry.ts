import type { AnyRoute, HttpMethod } from './define-route.ts';
import { getHealthLive, getHealthReady } from './routes/health.ts';
import { getMe, putMe } from './routes/me.ts';

export const routes = {
  getHealthLive,
  getHealthReady,
  getMe,
  putMe,
} as const;

export const routeList: readonly AnyRoute[] = Object.freeze(
  Object.values(routes)
);

export interface RouteLocation {
  readonly method: HttpMethod | Uppercase<HttpMethod> | string;
  readonly path: string;
}

export function routeKey(route: RouteLocation): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}
