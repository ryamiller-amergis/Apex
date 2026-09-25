/**
 * TBI-023 — the six structural guards — and FEAT-008 TBI-034's registry-backed gate rule.
 *
 * Covers VT-14 (a cycle is refused at publish, naming it), VT-15 (the step and agent-step caps
 * refuse at the limit and permit one below it), VT-16 (active-run cap), VT-17 (suspended-run
 * ceiling) and VT-18 (no guard touches the network or cost data). FEAT-008's own VT-10..VT-16 are
 * in the second half of this file.
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
import { z } from 'zod';
import { PLAYBOOK_GUARD_LIMITS } from '../../shared/types/playbook';
import type {
  PlaybookGraph,
  PlaybookStepSideEffect,
  PlaybookStepTypeDescriptor,
} from '../../shared/types/playbook';

/*
 * A stateful enough double for the publish path, because VT-15 and VT-16 run the real definition
 * service over the real guard. `db` stays an empty object for every other test here, which touches
 * no table at all.
 */
const mockPublishFindFirst = jest.fn();
const mockPublishSet = jest
  .fn()
  .mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
const mockPublishUpdate = jest.fn().mockReturnValue({ set: mockPublishSet });

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      playbookDefinitionVersions: {
        findFirst: (...args: unknown[]) => mockPublishFindFirst(...args),
      },
    },
    update: (...args: unknown[]) => mockPublishUpdate(...args),
  },
}));

import {
  PlaybookGraphNodeConfigError,
  PlaybookGraphStepTypeError,
  PlaybookGuardViolationError,
  assertGraphWithinGuards,
  assertStepGateSatisfied,
  countAgentSteps,
  findCycle,
  findUngatedLeavesApexSteps,
  maxFanOut,
} from '../services/playbookGuardService';
import { publishVersion } from '../services/playbookDefinitionService';

const DEMO_SKILL_PATH = '.cursor/skills/app-knowledge/SKILL.md';

/**
 * A config each production step type's input schema accepts.
 *
 * Publication now parses every node's config through the registry, so a graph built for a
 * structural test still has to be a graph the registry would accept. Anything invalid here would
 * make a cap test pass or fail for the wrong reason.
 */
function configFor(stepType: string, id: string): Record<string, unknown> {
  if (stepType === 'cursor-agent')
    return { skillPath: DEMO_SKILL_PATH, prompt: `Do the work for ${id}.` };
  if (stepType === 'notify') return { title: `Step ${id} finished` };
  return { subject: `Approve ${id}` };
}

function linearGraph(stepCount: number, stepType = 'notify'): PlaybookGraph {
  const nodes = Array.from({ length: stepCount }, (_, i) => ({
    id: `s${i}`,
    stepType,
    config: configFor(stepType, `s${i}`),
  }));
  const edges = nodes.slice(1).map((node, i) => ({ from: `s${i}`, to: node.id }));
  return { nodes, edges };
}

/** `approval-gate → cursor-agent`, repeated. The only linear shape the gate rule permits. */
function gatedAgentChain(agentCount: number): PlaybookGraph {
  const nodes = Array.from({ length: agentCount }, (_, i) => [
    { id: `g${i}`, stepType: 'approval-gate', config: configFor('approval-gate', `g${i}`) },
    { id: `a${i}`, stepType: 'cursor-agent', config: configFor('cursor-agent', `a${i}`) },
  ]).flat();
  const edges = nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id }));
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
    // Gated, because every agent step leaves Apex and TBI-034 requires a gate in front of each.
    const atCap = gatedAgentChain(PLAYBOOK_GUARD_LIMITS.maxAgentStepsPerRun);
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

  /*
   * The corrected Demo A and existing Demo B order. Legacy Demo A v1 led with the agent step and is
   * retained as immutable history; FEAT-008 publishes the corrected gate-first graph as v2.
   */
  it('accepts the gate-first three-step shape a demo definition uses', () => {
    const graph: PlaybookGraph = {
      nodes: [
        { id: 'a', stepType: 'approval-gate', config: configFor('approval-gate', 'a') },
        { id: 'b', stepType: 'cursor-agent', config: configFor('cursor-agent', 'b') },
        { id: 'c', stepType: 'notify', config: configFor('notify', 'c') },
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
      // Every graph guard, against a graph that exercises all of them.
      expect(() => assertGraphWithinGuards(gatedAgentChain(3))).not.toThrow();
      expect(() => findCycle(linearGraph(5))).not.toThrow();
      expect(() => maxFanOut(linearGraph(5))).not.toThrow();
      expect(() => countAgentSteps(linearGraph(5, 'cursor-agent'))).not.toThrow();
      expect(() => findUngatedLeavesApexSteps(gatedAgentChain(3))).not.toThrow();
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

// ── FEAT-008 S5 — TBI-034 / PBI-007: the registry-backed gate rule ────────────
//
// The rule is about edges, not about where a node sits in the array: a `leaves-apex` node is
// permitted only when it has inbound edges and every one of them comes from an approval gate. So
// the graphs below are built edge-first, including one that fans in from two directions — the shape
// that an order-based check would wave through.

/** A descriptor the registry never sees, for proving the rule reads data rather than type names. */
function fakeDescriptor(
  stepType: string,
  sideEffect: PlaybookStepSideEffect,
  gate = false
): PlaybookStepTypeDescriptor {
  const base = {
    stepType,
    isAgentStep: sideEffect === 'leaves-apex',
    sideEffect,
    requiredPermissions: ['playbooks:run'] as [string, ...string[]],
    inputSchema: z.object({}),
    outputSchema: z.object({}),
  };

  return gate
    ? {
        ...base,
        canSuspend: true,
        defaultDeadlineMs: 60_000,
        deadlineOverridable: true,
        suspendReason: 'approval_gate',
      }
    : { ...base, canSuspend: false };
}

function node(id: string, stepType: string) {
  return { id, stepType, config: configFor(stepType, id) };
}

describe('FEAT-008 VT-10..VT-14 (TBI-034) — a leaves-apex step needs a gate on every inbound edge', () => {
  it('VT-10 (TBI-034 a / PBI-007 AC-1): permits approval-gate → leaves-apex', () => {
    const graph: PlaybookGraph = {
      nodes: [node('gate', 'approval-gate'), node('agent', 'cursor-agent')],
      edges: [{ from: 'gate', to: 'agent' }],
    };

    expect(findUngatedLeavesApexSteps(graph)).toEqual([]);
    expect(() => assertGraphWithinGuards(graph)).not.toThrow();
  });

  it('VT-11 (TBI-034 b / PBI-007 AC-0): refuses writes-apex → leaves-apex and names the step', () => {
    const graph: PlaybookGraph = {
      nodes: [node('announce', 'notify'), node('agent', 'cursor-agent')],
      edges: [{ from: 'announce', to: 'agent' }],
    };

    expect(findUngatedLeavesApexSteps(graph)).toEqual(['agent']);

    try {
      assertGraphWithinGuards(graph);
      throw new Error('expected a refusal');
    } catch (error) {
      const violation = error as PlaybookGuardViolationError;
      expect(violation).toBeInstanceOf(PlaybookGuardViolationError);
      expect(violation.violation.kind).toBe('ungated-leaves-apex');
      // PBI-007's accessibility requirement: findable without a second lookup.
      expect(violation.message).toContain('agent');
    }
  });

  it('VT-12 (TBI-034 c / PBI-007 AC-2): refuses a leaves-apex entry node, which nothing precedes', () => {
    const graph: PlaybookGraph = {
      nodes: [node('agent', 'cursor-agent'), node('announce', 'notify')],
      edges: [{ from: 'agent', to: 'announce' }],
    };

    expect(findUngatedLeavesApexSteps(graph)).toEqual(['agent']);
    expect(() => assertGraphWithinGuards(graph)).toThrow(PlaybookGuardViolationError);
  });

  it('VT-13 (TBI-034 d / PBI-007 AC-3): permits a graph of only read and writes-apex steps', () => {
    const graph: PlaybookGraph = {
      nodes: [node('gate', 'approval-gate'), node('announce', 'notify')],
      edges: [{ from: 'gate', to: 'announce' }],
    };

    expect(findUngatedLeavesApexSteps(graph)).toEqual([]);
    expect(() => assertGraphWithinGuards(graph)).not.toThrow();
  });

  it('VT-13: a writes-apex step needs no gate, with or without one in front of it', () => {
    // The rule is a floor, not a ceiling: a voluntary gate is as valid as none at all.
    const ungated: PlaybookGraph = {
      nodes: [node('first', 'notify'), node('second', 'notify')],
      edges: [{ from: 'first', to: 'second' }],
    };
    const voluntarilyGated: PlaybookGraph = {
      nodes: [node('gate', 'approval-gate'), node('announce', 'notify')],
      edges: [{ from: 'gate', to: 'announce' }],
    };

    expect(() => assertGraphWithinGuards(ungated)).not.toThrow();
    expect(() => assertGraphWithinGuards(voluntarilyGated)).not.toThrow();
  });

  it('VT-14 (TBI-034 b): refuses a leaves-apex step reached by one gated and one bypass path', () => {
    const graph: PlaybookGraph = {
      nodes: [node('gate', 'approval-gate'), node('bypass', 'notify'), node('agent', 'cursor-agent')],
      edges: [
        { from: 'gate', to: 'agent' },
        { from: 'bypass', to: 'agent' },
      ],
    };

    // Fan-in, not fan-out: neither predecessor branches, so the Phase 0 width guard is silent and
    // the refusal has to come from the gate rule.
    expect(maxFanOut(graph)).toBe(1);
    expect(findUngatedLeavesApexSteps(graph)).toEqual(['agent']);
    expect(() => assertGraphWithinGuards(graph)).toThrow(/agent/);
  });

  it('names every offending step, not merely the first one found', () => {
    const graph: PlaybookGraph = {
      nodes: [node('first-agent', 'cursor-agent'), node('second-agent', 'cursor-agent')],
      edges: [{ from: 'first-agent', to: 'second-agent' }],
    };

    expect(findUngatedLeavesApexSteps(graph)).toEqual(['first-agent', 'second-agent']);

    try {
      assertGraphWithinGuards(graph);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain('first-agent');
      expect((error as Error).message).toContain('second-agent');
    }
  });

  it('reads the classification from the descriptor lookup rather than from step-type names', () => {
    const lookup = (stepType: string) =>
      ({
        'fake-gate': fakeDescriptor('fake-gate', 'read', true),
        'fake-external': fakeDescriptor('fake-external', 'leaves-apex'),
      })[stepType];

    const gated: PlaybookGraph = {
      nodes: [
        { id: 'g', stepType: 'fake-gate' },
        { id: 'x', stepType: 'fake-external' },
      ],
      edges: [{ from: 'g', to: 'x' }],
    };
    const ungated: PlaybookGraph = {
      nodes: [{ id: 'x', stepType: 'fake-external' }],
      edges: [],
    };

    expect(findUngatedLeavesApexSteps(gated, lookup)).toEqual([]);
    expect(findUngatedLeavesApexSteps(ungated, lookup)).toEqual(['x']);
  });

  it('treats a predecessor the lookup does not recognise as a bypass', () => {
    const graph: PlaybookGraph = {
      nodes: [{ id: 'mystery', stepType: 'teleport' }, node('agent', 'cursor-agent')],
      edges: [{ from: 'mystery', to: 'agent' }],
    };

    expect(findUngatedLeavesApexSteps(graph)).toEqual(['agent']);
  });

  it('neither mutates the graph nor adds a gate to it', () => {
    const graph = gatedAgentChain(2);
    graph.nodes.push(node('agent-ungated', 'cursor-agent'));
    const before = JSON.parse(JSON.stringify(graph));

    expect(findUngatedLeavesApexSteps(graph)).toEqual(['agent-ungated']);
    expect(() => assertGraphWithinGuards(graph)).toThrow(PlaybookGuardViolationError);
    expect(graph).toEqual(before);
  });

  it('stays synchronous and well inside the 500ms publish budget at the step cap', () => {
    const graph = gatedAgentChain(PLAYBOOK_GUARD_LIMITS.maxAgentStepsPerRun);

    const started = Date.now();
    const offending = findUngatedLeavesApexSteps(graph);
    assertGraphWithinGuards(graph);
    const elapsed = Date.now() - started;

    expect(offending).toEqual([]);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('FEAT-008 (TBI-034) — the node-level rule the runtime reuses', () => {
  const gated: PlaybookGraph = {
    nodes: [node('gate', 'approval-gate'), node('agent', 'cursor-agent'), node('announce', 'notify')],
    edges: [
      { from: 'gate', to: 'agent' },
      { from: 'agent', to: 'announce' },
    ],
  };

  const bypassed: PlaybookGraph = {
    nodes: [node('announce', 'notify'), node('agent', 'cursor-agent')],
    edges: [{ from: 'announce', to: 'agent' }],
  };

  it('passes for a gated leaves-apex node and for nodes the rule does not cover', () => {
    for (const stepId of ['gate', 'agent', 'announce']) {
      expect(() => assertStepGateSatisfied(gated, stepId)).not.toThrow();
    }
  });

  it('refuses the one node it is asked about, naming it', () => {
    try {
      assertStepGateSatisfied(bypassed, 'agent');
      throw new Error('expected a refusal');
    } catch (error) {
      const violation = error as PlaybookGuardViolationError;
      expect(violation).toBeInstanceOf(PlaybookGuardViolationError);
      expect(violation.violation.kind).toBe('ungated-leaves-apex');
      expect(violation.message).toContain('agent');
    }

    // The node in front of the offending one is not itself a violation.
    expect(() => assertStepGateSatisfied(bypassed, 'announce')).not.toThrow();
  });

  it('accepts an injected descriptor lookup, as the runtime will pass the current registry', () => {
    const lookup = (stepType: string) =>
      stepType === 'fake-external' ? fakeDescriptor('fake-external', 'leaves-apex') : undefined;
    const graph: PlaybookGraph = { nodes: [{ id: 'x', stepType: 'fake-external' }], edges: [] };

    expect(() => assertStepGateSatisfied(graph, 'x', lookup)).toThrow(PlaybookGuardViolationError);
  });

  it('refuses a step id that is not in the graph rather than reporting it satisfied', () => {
    expect(() => assertStepGateSatisfied(gated, 'nowhere')).toThrow(/nowhere/);
  });
});

describe('FEAT-008 (TBI-034) — publication resolves every node through the registry', () => {
  it('refuses an unregistered step type, naming the node and the type', () => {
    const graph: PlaybookGraph = {
      nodes: [{ id: 'mystery', stepType: 'teleport', config: {} }],
      edges: [],
    };

    expect(() => assertGraphWithinGuards(graph)).toThrow(PlaybookGraphStepTypeError);
    expect(() => assertGraphWithinGuards(graph)).toThrow(/mystery/);
    expect(() => assertGraphWithinGuards(graph)).toThrow(/teleport/);
  });

  it('refuses a node whose config its step type would reject, naming the node', () => {
    const graph: PlaybookGraph = {
      nodes: [{ id: 'announce', stepType: 'notify', config: { body: 'no title' } }],
      edges: [],
    };

    expect(() => assertGraphWithinGuards(graph)).toThrow(PlaybookGraphNodeConfigError);
    expect(() => assertGraphWithinGuards(graph)).toThrow(/announce/);
    expect(() => assertGraphWithinGuards(graph)).toThrow(/title/);
  });

  it('treats a missing config as an empty one, which some step types accept', () => {
    const graph: PlaybookGraph = {
      nodes: [{ id: 'gate', stepType: 'approval-gate' }],
      edges: [],
    };

    expect(() => assertGraphWithinGuards(graph)).not.toThrow();
  });
});

describe('FEAT-008 VT-15/VT-16 (TBI-034 / PBI-007) — publishing through the definition service', () => {
  beforeEach(() => {
    mockPublishFindFirst.mockReset();
    mockPublishUpdate.mockClear();
    mockPublishSet.mockClear();
  });

  function draftIs(graph: PlaybookGraph): void {
    mockPublishFindFirst.mockResolvedValue({ status: 'draft', graph });
  }

  it('VT-15 (PBI-007 AC-0): refuses an ungated leaves-apex draft and writes no version', async () => {
    draftIs({
      nodes: [node('announce', 'notify'), node('agent', 'cursor-agent')],
      edges: [{ from: 'announce', to: 'agent' }],
    });

    await expect(publishVersion('ver-1', 'author-oid')).rejects.toThrow(
      PlaybookGuardViolationError
    );
    await expect(publishVersion('ver-1', 'author-oid')).rejects.toThrow(/agent/);
    expect(mockPublishUpdate).not.toHaveBeenCalled();
  });

  it('VT-16 (PBI-007 AC-1): publishes the same draft once a gate is put in front', async () => {
    const agent = node('agent', 'cursor-agent');
    agent.config = { ...agent.config, mcpProfile: 'repository-read-only' };
    draftIs({
      nodes: [node('gate', 'approval-gate'), agent],
      edges: [{ from: 'gate', to: 'agent' }],
    });

    await expect(publishVersion('ver-1', 'author-oid')).resolves.toBeUndefined();
    expect(mockPublishUpdate).toHaveBeenCalledTimes(1);
    expect(mockPublishSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published', publishedBy: 'author-oid' })
    );
  });

  it('refuses synchronously, before anything is written', async () => {
    draftIs({ nodes: [node('agent', 'cursor-agent')], edges: [] });

    await expect(publishVersion('ver-1', 'author-oid')).rejects.toThrow(
      PlaybookGuardViolationError
    );
    expect(mockPublishUpdate).not.toHaveBeenCalled();
  });
});
