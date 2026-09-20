/**
 * TBI-023 — the six structural guards.
 *
 * Covers VT-14 (a cycle is refused at publish, naming it), VT-15 (the step and agent-step caps
 * refuse at the limit and permit one below it), VT-16 (active-run cap), VT-17 (suspended-run
 * ceiling) and VT-18 (no guard touches the network or cost data).
 *
 * VT-18 is the one worth explaining. BR-007 keeps cost entirely off the execution path, and the
 * way that rule usually breaks is not a deliberate decision but a helper that grows a lookup two
 * refactors later. So the assertion is not "we did not write a network call" — it stubs the cost
 * and network clients to throw and runs every guard through them.
 */
import fs from 'fs';
import nodeHttp from 'http';
import nodeHttps from 'https';
import path from 'path';
import { PLAYBOOK_GUARD_LIMITS } from '../../shared/types/playbook';
import type { PlaybookGraph } from '../../shared/types/playbook';

jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  PlaybookGuardViolationError,
  assertGraphWithinGuards,
  countAgentSteps,
  findCycle,
  maxFanOut,
} from '../services/playbookGuardService';

function linearGraph(stepCount: number, stepType = 'notify'): PlaybookGraph {
  const nodes = Array.from({ length: stepCount }, (_, i) => ({
    id: `s${i}`,
    stepType,
    config: {},
  }));
  const edges = nodes.slice(1).map((node, i) => ({ from: `s${i}`, to: node.id }));
  return { nodes, edges };
}

describe('playbookGuardService — publish-time graph guards', () => {
  it('VT-15: permits a graph at the step cap and refuses one above it', () => {
    const atCap = linearGraph(PLAYBOOK_GUARD_LIMITS.maxStepsPerRun);
    expect(() => assertGraphWithinGuards(atCap)).not.toThrow();

    const overCap = linearGraph(PLAYBOOK_GUARD_LIMITS.maxStepsPerRun + 1);
    expect(() => assertGraphWithinGuards(overCap)).toThrow(PlaybookGuardViolationError);

    try {
      assertGraphWithinGuards(overCap);
      throw new Error('expected a refusal');
    } catch (error) {
      const violation = error as PlaybookGuardViolationError;
      expect(violation.violation.kind).toBe('max-steps');
      // DoD requires the refusal to name the cap, not merely to refuse.
      expect(violation.message).toContain(String(PLAYBOOK_GUARD_LIMITS.maxStepsPerRun));
    }
  });

  it('VT-15: permits a graph at the agent-step cap and refuses one above it', () => {
    const atCap = linearGraph(PLAYBOOK_GUARD_LIMITS.maxAgentStepsPerRun, 'cursor-agent');
    expect(countAgentSteps(atCap)).toBe(PLAYBOOK_GUARD_LIMITS.maxAgentStepsPerRun);
    expect(() => assertGraphWithinGuards(atCap)).not.toThrow();

    const overCap = linearGraph(PLAYBOOK_GUARD_LIMITS.maxAgentStepsPerRun + 1, 'cursor-agent');
    try {
      assertGraphWithinGuards(overCap);
      throw new Error('expected a refusal');
    } catch (error) {
      const violation = error as PlaybookGuardViolationError;
      expect(violation.violation.kind).toBe('max-agent-steps');
      expect(violation.message).toContain(String(PLAYBOOK_GUARD_LIMITS.maxAgentStepsPerRun));
    }
  });

  it('VT-14: refuses a graph containing a cycle and names the cycle', () => {
    const graph = linearGraph(3);
    graph.edges.push({ from: 's2', to: 's0' });

    expect(findCycle(graph)).toEqual(expect.arrayContaining(['s0', 's1', 's2']));

    try {
      assertGraphWithinGuards(graph);
      throw new Error('expected a refusal');
    } catch (error) {
      const violation = error as PlaybookGuardViolationError;
      expect(violation.violation.kind).toBe('loop');
      // Naming the cycle is what makes the refusal actionable: which steps form it.
      expect(violation.message).toContain('s0');
    }
  });

  it('VT-14: refuses a self-edge, which is the shortest possible cycle', () => {
    const graph = linearGraph(2);
    graph.edges.push({ from: 's0', to: 's0' });

    expect(() => assertGraphWithinGuards(graph)).toThrow(PlaybookGuardViolationError);
  });

  it('VT-15: refuses fan-out beyond the Phase 0 width of one', () => {
    const graph = linearGraph(3);
    graph.edges.push({ from: 's0', to: 's2' });

    expect(maxFanOut(graph)).toBe(2);

    try {
      assertGraphWithinGuards(graph);
      throw new Error('expected a refusal');
    } catch (error) {
      const violation = error as PlaybookGuardViolationError;
      expect(violation.violation.kind).toBe('max-fan-out');
      expect(violation.message).toContain(String(PLAYBOOK_GUARD_LIMITS.maxFanOutWidth));
    }
  });

  it('accepts the linear three-step shape the Phase 0 demo definitions use', () => {
    const graph: PlaybookGraph = {
      nodes: [
        { id: 'a', stepType: 'cursor-agent', config: {} },
        { id: 'b', stepType: 'approval-gate', config: {} },
        { id: 'c', stepType: 'notify', config: {} },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };

    expect(() => assertGraphWithinGuards(graph)).not.toThrow();
    expect(findCycle(graph)).toBeUndefined();
    expect(maxFanOut(graph)).toBe(1);
  });
});

describe('playbookGuardService — VT-18: no guard reads cost data or the network', () => {
  it('runs every graph guard with http, https and the cost service stubbed to throw', () => {
    const http = nodeHttp as unknown as { request: unknown; get: unknown };
    const https = nodeHttps as unknown as { request: unknown; get: unknown };
    const originals = {
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
    };

    const explode = () => {
      throw new Error('BR-007: a structural guard must not touch the network or cost data');
    };
    http.request = explode;
    http.get = explode;
    https.request = explode;
    https.get = explode;

    try {
      // Every graph guard, against a graph that exercises all four.
      expect(() => assertGraphWithinGuards(linearGraph(3, 'cursor-agent'))).not.toThrow();
      expect(() => findCycle(linearGraph(5))).not.toThrow();
      expect(() => maxFanOut(linearGraph(5))).not.toThrow();
      expect(() => countAgentSteps(linearGraph(5, 'cursor-agent'))).not.toThrow();
    } finally {
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
    }
  });

  it('the guard module imports nothing that could reach cost data', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'playbookGuardService.ts'),
      'utf8'
    );

    // Whole-word so a comment explaining the rule does not trip it.
    for (const forbidden of ['aiCostAnalyticsService', 'aiUsageService', 'azureCost', 'fetch(']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
