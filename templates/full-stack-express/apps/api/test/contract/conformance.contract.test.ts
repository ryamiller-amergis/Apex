import {
  problemContentType,
  problemDetailsSchema,
  requestIdHeader,
} from '@project-scope/contracts';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../support/createTestApp.ts';
import {
  listOperations,
  loadOpenApiDocument,
  missingScenarioKeys,
  responseSchema,
  routeFor,
  scenarios,
  schemaErrors,
  subjectHeader,
  type Arrange,
  type Scenario,
} from './scenarios.ts';

const document = loadOpenApiDocument();

function appFor(arrange: Arrange): Express {
  if (arrange === 'not-ready') {
    return createTestApp({
      ping: () => Promise.reject(new Error('connect db.internal:5432')),
    }).app;
  }
  const harness = createTestApp();
  if (arrange === 'throw') {
    harness.persistence.override('findBySubject', () => {
      throw new Error('syntax error at db.internal select app_users');
    });
  }
  return harness.app;
}

async function runScenario(
  operationId: keyof typeof scenarios,
  scenario: Scenario
) {
  const route = routeFor(operationId);
  const app = appFor(scenario.arrange);
  const agent = request(app)[route.method](route.path);
  const headers = subjectHeader(scenario.subject);
  for (const [key, value] of Object.entries(headers)) {
    agent.set(key, value);
  }
  if (scenario.body !== undefined && scenario.body !== null) {
    agent.send(scenario.body as object);
  }
  return agent;
}

describe('contract coverage (TBI-026 VT-28)', () => {
  it('VT-28 TBI-026 DoD-0 every committed operation has a scenario, and a missing key names the operation', () => {
    expect(missingScenarioKeys(document, scenarios)).toEqual([]);
    const operations = listOperations(document);
    expect(operations.length).toBeGreaterThan(0);
    const planted: Record<string, readonly Scenario[]> = { ...scenarios };
    delete planted.getMe;
    const missing = missingScenarioKeys(document, planted);
    expect(missing.some((line) => line.includes('getMe'))).toBe(true);
    expect(missing.some((line) => line.includes('/api/v1/me'))).toBe(true);
  });
});

describe('contract responses (TBI-026 VT-29 VT-30)', () => {
  it('VT-30 TBI-026 DoD-2 error responses match Problem Details, use application/problem+json, and carry a request ID', async () => {
    const cases: { operationId: keyof typeof scenarios; scenarioId: string }[] =
      [
        { operationId: 'getMe', scenarioId: 'unauthenticated' },
        { operationId: 'putMe', scenarioId: 'validation' },
        { operationId: 'getMe', scenarioId: 'failure' },
        { operationId: 'getHealthReady', scenarioId: 'not-ready' },
      ];
    for (const item of cases) {
      const scenario = scenarios[item.operationId].find(
        (row) => row.id === item.scenarioId
      );
      if (!scenario) {
        throw new Error(`missing scenario ${item.scenarioId}`);
      }
      const response = await runScenario(item.operationId, scenario);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers['content-type']).toContain(problemContentType);
      expect(response.headers[requestIdHeader.toLowerCase()]).toMatch(
        /^[A-Za-z0-9._-]+$/
      );
      expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
      const route = routeFor(item.operationId);
      const check = responseSchema(
        document,
        route.method,
        route.path,
        response.status
      );
      expect(check, `${item.operationId} ${response.status}`).not.toBeNull();
      const valid = check?.validate(response.body) ?? false;
      expect(valid, schemaErrors(check!.validate)).toBe(true);
    }
  });

  it('VT-29 TBI-026 DoD-1 a profile whose displayName is a number fails and names the schema path', async () => {
    const response = await runScenario('getMe', scenarios.getMe[0]);
    expect(response.status).toBe(200);
    const check = responseSchema(document, 'get', '/api/v1/me', 200);
    expect(check).not.toBeNull();
    const mutated = { ...response.body, displayName: 1 };
    const valid = check?.validate(mutated) ?? true;
    expect(valid).toBe(false);
    expect(schemaErrors(check!.validate)).toMatch(/displayName/i);
  });

  it('VT-04 TBI-026 DoD-0 success responses match the committed schema and carry a request ID', async () => {
    for (const operation of listOperations(document)) {
      const scenario = scenarios[
        operation.operationId as keyof typeof scenarios
      ].find(
        (row) =>
          row.arrange === 'ok' &&
          row.id !== 'unauthenticated' &&
          row.id !== 'validation'
      );
      if (!scenario) {
        continue;
      }
      const response = await runScenario(
        operation.operationId as keyof typeof scenarios,
        scenario
      );
      expect(response.headers[requestIdHeader.toLowerCase()]).toBeTruthy();
      if (response.status < 400) {
        const check = responseSchema(
          document,
          operation.method,
          operation.path,
          response.status
        );
        expect(check).not.toBeNull();
        expect(
          check?.validate(response.body),
          schemaErrors(check!.validate)
        ).toBe(true);
      }
    }
  });
});
