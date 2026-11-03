import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  correlationId: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();
const byRequest = new WeakMap<object, RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  req: object,
  fn: () => T
): T {
  byRequest.set(req, context);
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

// Response listeners such as 'finish' can run outside the request's async
// context, so code that holds the request object reads the context from it.
export function requestContextOf(req: object): RequestContext | undefined {
  return byRequest.get(req);
}
