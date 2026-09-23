import type {
  InteractiveClass,
  InteractiveDispatchOutboxPayload,
} from '../../../shared/types/durableInteractiveTurn';

export interface InteractiveActorDispatchClient {
  dispatch(payload: InteractiveDispatchOutboxPayload): Promise<void>;
}

export type InteractiveActorDispatchClientOptions = Readonly<{
  fastUrl?: string | null;
  agenticUrl?: string | null;
  fetchImpl?: typeof fetch;
}>;

function normalizeUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\/+$/, '') ?? '';
  return normalized || null;
}

function endpointForClass(
  interactiveClass: InteractiveClass,
  endpoints: Readonly<Record<InteractiveClass, string | null>>,
): string {
  let endpoint: string | null;
  switch (interactiveClass) {
    case 'fast':
      endpoint = endpoints.fast;
      break;
    case 'agentic':
      endpoint = endpoints.agentic;
      break;
    default: {
      const unhandled: never = interactiveClass;
      throw new Error(`Unsupported interactive class: ${String(unhandled)}`);
    }
  }
  if (!endpoint) {
    throw new Error(
      `Interactive ${interactiveClass} dispatch endpoint is not configured`,
    );
  }
  return `${endpoint}/dispatch`;
}

export function createInteractiveActorDispatchClient(
  options: InteractiveActorDispatchClientOptions,
): InteractiveActorDispatchClient {
  const endpoints: Readonly<Record<InteractiveClass, string | null>> = {
    fast: normalizeUrl(options.fastUrl),
    agentic: normalizeUrl(options.agenticUrl),
  };
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async dispatch(payload: InteractiveDispatchOutboxPayload): Promise<void> {
      const url = endpointForClass(payload.interactiveClass, endpoints);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(
          `Interactive ${payload.interactiveClass} dispatch failed with status ${response.status}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (
        body === null ||
        typeof body !== 'object' ||
        (body as { accepted?: unknown }).accepted !== true
      ) {
        throw new Error(
          `Interactive ${payload.interactiveClass} dispatch was not accepted`,
        );
      }
    },
  };
}
