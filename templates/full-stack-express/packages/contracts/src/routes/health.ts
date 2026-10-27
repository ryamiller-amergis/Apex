import { z } from 'zod';
import { problemDetailsSchema } from '../conventions/problem-details.ts';
import { defineRoute } from '../define-route.ts';
import { contractSchemas } from '../schema-registry.ts';

export const healthLiveSchema = z
  .strictObject({ status: z.literal('ok') })
  .register(contractSchemas, { id: 'HealthLive' });

export const healthReadySchema = z
  .strictObject({ status: z.literal('ready') })
  .register(contractSchemas, { id: 'HealthReady' });

export const getHealthLive = defineRoute({
  id: 'getHealthLive',
  method: 'get',
  path: '/health/live',
  auth: 'none',
  summary: 'Liveness probe',
  description: 'Returns 200 while the process can serve requests.',
  responses: {
    200: {
      description: 'The process is alive',
      body: healthLiveSchema,
      example: { status: 'ok' },
    },
  },
});

export const getHealthReady = defineRoute({
  id: 'getHealthReady',
  method: 'get',
  path: '/health/ready',
  auth: 'none',
  summary: 'Readiness probe',
  description:
    'Returns 200 when dependencies are reachable and 503 otherwise. The 503 body names no host, connection string, or error text.',
  responses: {
    200: {
      description: 'The service is ready',
      body: healthReadySchema,
      example: { status: 'ready' },
    },
    503: {
      description: 'The service is not ready',
      body: problemDetailsSchema,
    },
  },
});
