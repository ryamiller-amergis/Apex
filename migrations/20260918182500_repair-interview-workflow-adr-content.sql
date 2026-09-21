-- Up Migration
DO $migration$
DECLARE
  updated_count integer;
BEGIN
  UPDATE adrs
  SET
    content = $adr$---
adr-number: ADR-pending
status: Proposed
date: 2026-09-18
slug: supervisor-managed-interview-workflow-collaboration
---

# Adopt Supervisor-Managed Peer Collaboration for Configurable Interview Workflows

## Status

Proposed

## Context

Apex Interviews currently let a project offer one or more interview skills. A skill defines one agent's procedure. Apex needs a separate Interview Workflow concept: a versioned orchestration that coordinates multiple role-specific skills while preserving the existing single-skill path.

At Interview creation, a user must be able to select either a Skill or a Workflow configured under Project Settings > Interview. The configuration must work for every Apex project and repository through the existing foundation-skill package and project-owned adapter model.

The required workflow has three roles:

- The Interview Orchestrator, also called the Boss Agent, owns the user conversation, directs work, monitors progress, applies the quality gate, and finalizes the Interview Summary.
- The Requirements Worker protects product intent and defines actors, outcomes, workflows, business rules, scope, assumptions, acceptance criteria, and testability.
- The Technical Worker tests feasibility, architecture fit, data and integration effects, dependencies, non-functional requirements, operational concerns, and implementation risk.

The two workers must participate in a genuine iterative discussion. They are not independent analysts whose reports are merged afterward. Each worker must receive and answer the other's structured proposals, critiques, repository evidence, and revisions. They must compare viable options, jointly select the best one, and explicitly report their readiness or disagreement to the orchestrator.

Repository evidence can establish current behavior and technical constraints, but it cannot supply missing product intent. When the workers cannot resolve a product decision, the orchestrator must ask the user a targeted question rather than allow an agent to invent an answer.

An existing Accepted Apex ADR, `adopt-mastra-for-playbook-orchestration`, selects Mastra as the embedded workflow execution engine behind an Apex-owned adapter. This decision builds on that engine choice. It defines the Interview domain workflow and does not introduce another scheduler or orchestration engine.

## Decision Drivers

- Preserve a simple single-skill Interview option while adding richer project-configurable workflows.
- Require Requirements and Technical workers to challenge and refine each other's work before finalization.
- Keep one user-facing authority responsible for direction, intervention, and the final answer.
- Prevent forced consensus, endless argument, recursive agent calls, and uncontrolled context growth.
- Ground worker claims in the selected project's pinned repository snapshot.
- Keep foundation skills project-independent while allowing teams to inject repository-specific context through adapters.
- Make active workflow runs reproducible when project settings, models, skills, or repository branches change.
- Use the already selected Mastra engine rather than rebuilding workflow scheduling, suspension, resume, and retry.
- Persist a shareable Interview Summary and explicit gap analysis before PRD generation.
- Preserve authorization, audit history, cost attribution, and human control.

## Considered Options

### Supervisor-managed peer collaboration

An Interview Orchestrator manages a shared worker discussion. The Requirements Worker proposes options, the Technical Worker critiques them, the Requirements Worker revises or defends the product intent, and the Technical Worker accepts or identifies remaining concerns. The orchestrator checks every round, directs further work, and finalizes only after mutual worker sign-off and a passing quality gate.

This option provides real cross-functional refinement while retaining bounded, observable control and one final authority.

### Parallel specialist reports with supervisor synthesis

Requirements and Technical workers independently analyze the same input, after which a supervisor merges their reports.

This is simpler and can reduce latency, but the workers cannot directly challenge, correct, or refine each other's reasoning. It does not satisfy the required back-and-forth selection process.

### One expanded interview skill

A single agent prompt contains requirements, technical, review, and summary instructions.

This has lower orchestration cost, but the roles become prompt sections rather than testable contracts. It weakens independent repository checks, peer critique, project injection, and reliable readiness decisions.

### Unrestricted peer-to-peer agents

Requirements and Technical agents call each other directly and decide when their conversation is complete.

This maximizes autonomy but creates recursive-call, argument-loop, context-growth, observability, and final-authority risks. Recovery and durable resume also become harder because no controller owns the collaboration state.

## Decision Outcome

Chosen option: **Supervisor-managed peer collaboration**

Apex will introduce a discriminated Interview Launch Option whose kind is either `skill` or `workflow`. Existing interview skill options remain supported. A Workflow option references an immutable, versioned workflow definition.

The first foundation Interview Workflow will bind three project-agnostic foundation skills:

- `interview-orchestrator`
- `interview-requirements`
- `interview-technical`

Apex owns each skill's managed role contract and structured schemas. Team repositories may add project terminology, context paths, architecture rules, and notes through the existing project-owned adapter sections. Project configuration may select adapters and models but may not remove role boundaries, mutual sign-off, finite stopping conditions, or output contracts.

The workflow will execute through the Apex workflow-engine adapter backed by Mastra. Mastra owns graph execution, bounded transitions, suspension, resume, and retry. Apex continues to own workflow definitions and versions, project authorization, role and skill bindings, collaboration records, repository grounding, run history, audit data, cost attribution, gaps, and Interview Summaries. Mastra remains replaceable under the existing engine ADR.

Each worker round is managed as follows:

1. The orchestrator creates a structured task packet from the user's input and accumulated Interview state.
2. The Requirements Worker proposes or revises options that preserve user intent.
3. The Technical Worker tests those options against architecture, repository evidence, and delivery constraints.
4. The Requirements Worker responds to the critique and either revises the option or explains why a technical alternative changes product intent.
5. The Technical Worker accepts the revision or records precise remaining concerns.
6. Both workers return a structured status: ready, needs peer revision, needs user input, or blocked.
7. The orchestrator evaluates progress and either starts another bounded round, asks the user one targeted question, or applies the final quality gate.

The best option is the option that first preserves user intent, then fits verified repository behavior and architecture, is feasible, avoids unnecessary complexity, and is clear and testable. Either worker may challenge unsupported claims. The workflow must never force agreement: unresolved alternatives and evidence return to the orchestrator for another bounded round or a user decision.

The orchestrator monitors each round for repetition, contradiction, scope drift, unsupported claims, and lack of progress. Every workflow version declares finite round and deadline limits, bounded retries, output validation, and escalation behavior. Worker completion uses terminal events and durable state rather than process-resident waiters or heartbeat polling.

The orchestrator may finalize only when both workers report ready and a structured quality gate passes. The gate covers:

- alignment with user intent;
- business-rule and acceptance-criteria completeness;
- technical feasibility;
- repository evidence for current-state claims;
- clarity and testability;
- contradiction resolution; and
- explicit treatment of assumptions.

Critical unresolved gaps block readiness and PRD generation. Noncritical gaps remain visible warnings unless the user explicitly accepts the risk.

Successful finalization persists a canonical Interview Summary containing the requested outcome, confirmed requirements, business rules and acceptance criteria, technical constraints and repository evidence, selected option and rationale, considered alternatives, assumptions, unresolved gaps with severity and owner, both worker readiness results, and the orchestrator's final decision.

At workflow start, Apex snapshots the workflow ID and version, role skill paths and managed-content versions or hashes, models and effort, policies, `skillSettingsId`, repository provider/repository/branch, and pinned commit SHA. Active Interviews do not change behavior when project settings or foundation releases change. Multi-repository projects resolve the workflow from the selected `skillSettingsId`, not the project's default settings row.

Apex persists structured role messages, claims, evidence, challenges, decisions, and status for audit and resume. It does not request, persist, or expose hidden model chain-of-thought.

The workflow will roll out default-off to the Apex project first and then to opt-in projects. Single-skill Interviews remain the fallback. Evaluation will measure critical-gap detection, unsupported repository claims, convergence, user escalations, worker rounds, latency, token cost, summary quality, and downstream PRD revision rates.

## Consequences

### Positive

- Requirements and technical feasibility are reconciled before PRD generation.
- Workers directly improve each other's conclusions instead of producing isolated reports.
- The orchestrator provides one user-facing authority and a canonical final summary.
- Projects can choose simple skills or richer workflows without losing current behavior.
- Foundation skills remain reusable while project adapters inject local knowledge.
- Mastra supplies workflow mechanics without displacing Apex-owned domain state and governance.
- Immutable snapshots make long-running Interviews reproducible and auditable.
- Structured worker outputs, evidence, and quality results support focused evaluation.
- Human escalation preserves product ownership when repository evidence cannot answer a question.

### Negative

- Multi-agent Interviews consume more time and model tokens than single-skill Interviews.
- Managed discussion adds state, context-compaction, tracing, resume, and failure-handling work.
- Mutual sign-off can stall when product intent is missing, requiring a user checkpoint.
- Project Settings and Interview creation need backward-compatible changes to distinguish skills from workflows.
- The selected workflow identity and version must be stored directly on the Interview rather than inferred only from chat-thread kickoff data.
- Apex must add per-role usage attribution and end-to-end workflow evaluations.
- Mastra's initial phase boundaries may need bounded-loop support before this workflow can run in production.
- Poorly separated role prompts could produce repetitive debate, so foundation contracts and workflow limits require ongoing evaluation.

## References

- Accepted Apex ADR: `adopt-mastra-for-playbook-orchestration`
- `src/shared/types/projectSettings.ts`
- `src/shared/types/interview.ts`
- `src/client/components/AdminProjectSettings.tsx`
- `src/client/components/InterviewChatView.tsx`
- `src/server/services/projectSettingsService.ts`
- `src/server/services/chatAgentService.ts`
- `src/server/services/foundationSkillResolverService.ts`
- `docs/APEX_FOUNDATION_SKILLS.md`
- `foundation-skills/README.md`
- `.cursor/skills/grill-with-docs/SKILL.md`
- `.cursor/skills/adr-finalize/SKILL.md`
- [OpenAI Agent Orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Microsoft AI Agent Orchestration Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Amazon Bedrock Multi-Agent Collaboration](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-multi-agent-collaboration.html)
$adr$,
    status = 'proposed',
    slug = 'supervisor-managed-interview-workflow-collaboration',
    updated_at = now()
  WHERE id = '9dc9eff2-4e66-438a-8120-e2bce6b050ff'
    AND author_id = '110b196f-3f0d-4890-969f-5571085039de'
    AND title = 'Adopt Supervisor-Managed Peer Collaboration for Configurable Interview Workflows'
    AND status = 'generating'
    AND content = '';

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION 'Expected to repair exactly one untouched generating ADR, repaired %', updated_count;
  END IF;
END
$migration$;

-- Down Migration
-- Forward-only production data repair. Reverse with a separate audited migration if required.
