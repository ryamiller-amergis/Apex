# Repo-Grounded Visual Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move design-prototype generation onto the V2 visual lane, grounded in repository source read through the repo-read service rather than a 20-file Azure DevOps cap.

**Architecture:** App Service resolves every input a prototype needs — repository source, design tokens, navigation reference — into one immutable `AiRunV2VisualSpecification` written to Blob. The visual worker reads that specification and nothing else, calls Bedrock, and uploads the HTML as an attempt-scoped artifact. `designPrototypeService` reads the manifest back and applies it to its own row. The in-process path stays until the flag proves out.

**Tech Stack:** TypeScript, Express, Drizzle, Azure Service Bus (REST peek-lock), Azure Blob Storage, AWS Bedrock, Jest.

## Progress (2026-09-21)

Tasks 1–6 are complete and committed; only Task 7 remains.

| Task | State | Commit |
|---|---|---|
| 1 Repo design context reader | Done | `0d8de514` |
| 2 Context byte budget | Done | `a2f4a45c` |
| 3 Visual specification builder | Done | `b7bfc6b0` |
| 4 Prompt from the specification | Done | `1d1f9113`, `522b0945` |
| 5 Per-subject run identity | Done | `b8454a92` |
| 6 Worker execute + Bedrock client | Done | `73b94393`, `9463f196` |
| — Specification assembler | Done | `c1b049e8` |
| 7 Flag split in designPrototypeService | **Not started** | — |

Two things the original plan did not anticipate, both since resolved:

- `ExecutionSpecification` had to become a union so a lane-specific
  specification is a legal blob body (`e5195a47`).
- The worker needed its own Bedrock client. `bedrockService` writes usage
  rows through `recordAiUsage`, so binding it would break worker isolation.
  The visual client returns the tokens Bedrock reports and the worker writes
  them as a `usage.json` artifact for the owning service to record.

The V1/V2 completion convergence this plan was blocked on is resolved in
`2026-09-17-apex-ai-workload-reliability-implementation.md`. A finished V2 run
now publishes the same durable `done` / `completion` run event a V1 run does,
against the run's `thread_id` — `prototype:{subjectId}` for the visual lane.
That event is what an owning service observes to know a run finished. It does
not carry the manifest: the artifact manifest reference is on
`ai_run_attempts.manifest_ref`, written by the same transaction that
terminalized the attempt, and `usage.json` is one of the files that manifest
lists.

## Global Constraints

- No worker module may import a database module. `src/server/__tests__/aiRunsV2Worker/noDatabaseImports.test.ts` walks the import graph and fails the build otherwise.
- No new dependencies in `package.json` — it is a protected file.
- Do not edit `.github/workflows/deploy.yml`, `src/server/index.ts`, or `.env.example` without separate approval.
- The V2 path ships behind `ai-runs-v2-transport`, default off. The in-process branch stays functional until a cleanup pass retires it.
- Every prompt input a worker needs must be in the specification. A worker has no database, no PAT, and no checkout.
- Follow `.cursor/skills/feature-flags/SKILL.md` marker syntax for every flag split.

---

## Current behaviour this replaces

`src/server/services/designSystemService.ts` fetches design context from Azure DevOps over HTTP with a PAT:

- `fetchComponentDetails` reads **at most 20 component files** to stay inside the ADO rate limit.
- `fetchExistingPageContext` truncates at `MAX_PAGE_CONTEXT_BYTES`.
- `fetchUiKnowledgeBase` follows referenced files **one level deep only**.
- `getScreenInventory` returns `[]` when ADO credentials are missing — silently, treated as non-fatal.

`src/server/services/bedrockService.ts` calls those readers inline from its prompt builders (`getFigmaReference`, `getMaxviewColorTokens`, `getDesignSystemCatalog`, `getScreenInventory`, `resolvePrototypeExtendMode`) and writes usage with `recordAiUsage`. That inline fetching is what keeps generation pinned to App Service.

## File structure

| File | Responsibility |
|---|---|
| `src/server/services/designContext/repoDesignContextReader.ts` (new) | Read design source from a `RepoReader`; no ADO PAT, no caps beyond an explicit budget |
| `src/server/services/designContext/designContextBudget.ts` (new) | Decide which files are worth including and enforce a byte budget |
| `src/server/services/aiRunV2/visualSpecificationBuilder.ts` (new) | Assemble `AiRunV2VisualSpecification` from resolved context |
| `src/server/services/aiRunsV2Worker/prototypePromptBuilder.ts` (new) | Build the Bedrock prompt from the specification alone |
| `src/server/services/aiRunsV2Worker/visualEntrypoint.ts` (modify) | Wire `execute` to the prompt builder and Bedrock |
| `src/server/services/designPrototypeService.ts` (modify) | Flag split: admit to V2 or keep in-process; apply artifacts back |

---

### Task 1: Read design source through the repo-read service

**Files:**
- Create: `src/server/services/designContext/repoDesignContextReader.ts`
- Test: `src/server/__tests__/designContext/repoDesignContextReader.test.ts`

**Interfaces:**
- Consumes: `RepoReader` from `src/shared/types/repoReader` — `{ identity, readFile(path), listDir(path), searchCode(query) }`; `RepoReaderError` from `src/server/services/repoReader`.
- Produces: `createRepoDesignContextReader({ reader, budget? })` returning `{ readComponents(paths: string[]): Promise<DesignSourceFile[]> }` where `DesignSourceFile = { path: string; content: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { createRepoDesignContextReader } from '../../services/designContext/repoDesignContextReader';

function reader(files: Record<string, string>) {
  return {
    identity: { provider: 'ado' as const, project: 'Apex', repo: 'AI-Pilot', sha: 'a'.repeat(40) },
    readFile: async (path: string) => {
      const found = files[path];
      if (found === undefined) throw new Error(`missing ${path}`);
      return found;
    },
    listDir: async () => [],
    searchCode: async () => [],
  };
}

it('reads every requested component rather than the first twenty', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 25; i += 1) files[`/src/components/C${i}.tsx`] = `component ${i}`;
  const context = createRepoDesignContextReader({ reader: reader(files) });

  const read = await context.readComponents(Object.keys(files));

  expect(read).toHaveLength(25);
});

it('skips a file it cannot read instead of failing the batch', async () => {
  const context = createRepoDesignContextReader({
    reader: reader({ '/src/components/A.tsx': 'a' }),
  });

  const read = await context.readComponents([
    '/src/components/A.tsx',
    '/src/components/Missing.tsx',
  ]);

  expect(read.map((f) => f.path)).toEqual(['/src/components/A.tsx']);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest src/server/__tests__/designContext/repoDesignContextReader.test.ts --runInBand`
Expected: FAIL — `Cannot find module '../../services/designContext/repoDesignContextReader'`

- [ ] **Step 3: Implement the reader**

```typescript
import type { RepoReader } from '../../../shared/types/repoReader';

export type DesignSourceFile = Readonly<{ path: string; content: string }>;

export function createRepoDesignContextReader(deps: {
  reader: RepoReader;
  concurrency?: number;
}) {
  const concurrency = deps.concurrency ?? 8;

  return {
    async readComponents(paths: string[]): Promise<DesignSourceFile[]> {
      const out: DesignSourceFile[] = [];
      for (let i = 0; i < paths.length; i += concurrency) {
        const batch = paths.slice(i, i + concurrency);
        const read = await Promise.all(
          batch.map(async (path) => {
            try {
              return { path, content: await deps.reader.readFile(path) };
            } catch {
              // One unreadable file must not lose the rest of the context.
              return null;
            }
          }),
        );
        for (const file of read) if (file) out.push(file);
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest src/server/__tests__/designContext/repoDesignContextReader.test.ts --runInBand`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/services/designContext/repoDesignContextReader.ts src/server/__tests__/designContext/repoDesignContextReader.test.ts
git commit -m "feat: read design component source through the repo reader"
```

---

### Task 2: Budget the context instead of capping the file count

**Files:**
- Create: `src/server/services/designContext/designContextBudget.ts`
- Test: `src/server/__tests__/designContext/designContextBudget.test.ts`

**Interfaces:**
- Consumes: `DesignSourceFile` from Task 1.
- Produces: `applyDesignContextBudget(files: DesignSourceFile[], budgetBytes: number): { included: DesignSourceFile[]; omitted: string[]; usedBytes: number }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { applyDesignContextBudget } from '../../services/designContext/designContextBudget';

const file = (path: string, size: number) => ({ path, content: 'x'.repeat(size) });

it('fills the budget and names what it left out', () => {
  const result = applyDesignContextBudget([file('/a', 60), file('/b', 60)], 100);

  expect(result.included.map((f) => f.path)).toEqual(['/a']);
  expect(result.omitted).toEqual(['/b']);
  expect(result.usedBytes).toBe(60);
});

it('keeps everything when the budget allows', () => {
  const result = applyDesignContextBudget([file('/a', 10), file('/b', 10)], 100);

  expect(result.omitted).toEqual([]);
  expect(result.included).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest src/server/__tests__/designContext/designContextBudget.test.ts --runInBand`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the budget**

```typescript
import type { DesignSourceFile } from './repoDesignContextReader';

export type BudgetedDesignContext = Readonly<{
  included: DesignSourceFile[];
  omitted: string[];
  usedBytes: number;
}>;

export function applyDesignContextBudget(
  files: DesignSourceFile[],
  budgetBytes: number,
): BudgetedDesignContext {
  const included: DesignSourceFile[] = [];
  const omitted: string[] = [];
  let usedBytes = 0;

  for (const file of files) {
    const size = Buffer.byteLength(file.content, 'utf8');
    if (usedBytes + size > budgetBytes) {
      omitted.push(file.path);
      continue;
    }
    included.push(file);
    usedBytes += size;
  }

  return { included, omitted, usedBytes };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest src/server/__tests__/designContext/designContextBudget.test.ts --runInBand`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/server/services/designContext/designContextBudget.ts src/server/__tests__/designContext/designContextBudget.test.ts
git commit -m "feat: budget design context by bytes rather than file count"
```

---

### Task 3: Build the visual specification

**Files:**
- Create: `src/server/services/aiRunV2/visualSpecificationBuilder.ts`
- Test: `src/server/__tests__/aiRunV2VisualSpecificationBuilder.test.ts`

**Interfaces:**
- Consumes: `AiRunV2VisualSpecification` and `isAiRunV2VisualSpecification` from `src/shared/types/aiRunV2VisualSpec`; Task 1's reader; Task 2's budget.
- Produces: `buildPrototypeVisualSpecification(input: { prototypeId: string; promptInputs: Record<string, unknown>; sourceFiles: DesignSourceFile[]; colorTokens: unknown; navItems: VisualNavItem[]; model: VisualModelSettings; usage: VisualUsageAttribution }): AiRunV2VisualSpecification`.

- [ ] **Step 1: Write the failing test**

```typescript
import { isAiRunV2VisualSpecification } from '../../shared/types/aiRunV2VisualSpec';
import { buildPrototypeVisualSpecification } from '../services/aiRunV2/visualSpecificationBuilder';

it('produces a specification that validates and names its output file', () => {
  const spec = buildPrototypeVisualSpecification({
    prototypeId: 'prototype-1',
    promptInputs: { featureTitle: 'Standup summary' },
    sourceFiles: [{ path: '/src/components/A.tsx', content: 'a' }],
    colorTokens: { primary: '#000' },
    navItems: [{ label: 'Home', route: '/' }],
    model: { modelId: 'anthropic.claude' },
    usage: { feature: 'design-prototype', project: 'Apex' },
  });

  expect(isAiRunV2VisualSpecification(spec)).toBe(true);
  expect(spec.outputPath).toBe('prototype.html');
  expect(spec.subjectKind).toBe('design-prototype');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest src/server/__tests__/aiRunV2VisualSpecificationBuilder.test.ts --runInBand`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the builder**

```typescript
import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  type AiRunV2VisualSpecification,
  type VisualModelSettings,
  type VisualNavItem,
  type VisualUsageAttribution,
} from '../../../shared/types/aiRunV2VisualSpec';
import type { DesignSourceFile } from '../designContext/repoDesignContextReader';

export const PROTOTYPE_OUTPUT_PATH = 'prototype.html';

export function buildPrototypeVisualSpecification(input: {
  prototypeId: string;
  promptInputs: Record<string, unknown>;
  sourceFiles: DesignSourceFile[];
  colorTokens: unknown;
  navItems: VisualNavItem[];
  model: VisualModelSettings;
  usage: VisualUsageAttribution;
}): AiRunV2VisualSpecification {
  return {
    specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
    subjectId: input.prototypeId,
    subjectKind: 'design-prototype',
    promptInputs: { ...input.promptInputs, sourceFiles: input.sourceFiles },
    designSystem: { colorTokens: input.colorTokens },
    designReference: { navItems: input.navItems },
    model: input.model,
    usage: input.usage,
    outputPath: PROTOTYPE_OUTPUT_PATH,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest src/server/__tests__/aiRunV2VisualSpecificationBuilder.test.ts --runInBand`
Expected: PASS, 1 test

- [ ] **Step 5: Commit**

```bash
git add src/server/services/aiRunV2/visualSpecificationBuilder.ts src/server/__tests__/aiRunV2VisualSpecificationBuilder.test.ts
git commit -m "feat: build the prototype visual specification"
```

---

### Task 4: Build the prompt from the specification alone

**Files:**
- Create: `src/server/services/aiRunsV2Worker/prototypePromptBuilder.ts`
- Test: `src/server/__tests__/aiRunsV2Worker/prototypePromptBuilder.test.ts`

**Interfaces:**
- Consumes: `AiRunV2VisualSpecification`.
- Produces: `buildPrototypePrompt(spec: AiRunV2VisualSpecification): string`.

This is the carve: the prompt text that `bedrockService` assembles inline moves here, reading only the specification. Port the prompt sections one at a time, keeping wording identical so output does not drift.

- [ ] **Step 1: Write the failing test**

```typescript
import { AI_RUN_V2_VISUAL_SPEC_VERSION } from '../../../shared/types/aiRunV2VisualSpec';
import { buildPrototypePrompt } from '../../services/aiRunsV2Worker/prototypePromptBuilder';

const spec = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype',
  promptInputs: {
    featureTitle: 'Standup summary',
    sourceFiles: [{ path: '/src/components/A.tsx', content: 'export const A = 1;' }],
  },
  designSystem: { colorTokens: { primary: '#123456' } },
  designReference: { navItems: [{ label: 'Home', route: '/' }] },
  model: { modelId: 'anthropic.claude' },
  usage: { feature: 'design-prototype' },
  outputPath: 'prototype.html',
} as const;

it('includes the repository source the specification carries', () => {
  const prompt = buildPrototypePrompt(spec);

  expect(prompt).toContain('/src/components/A.tsx');
  expect(prompt).toContain('export const A = 1;');
});

it('includes the resolved palette and navigation', () => {
  const prompt = buildPrototypePrompt(spec);

  expect(prompt).toContain('#123456');
  expect(prompt).toContain('/');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest src/server/__tests__/aiRunsV2Worker/prototypePromptBuilder.test.ts --runInBand`
Expected: FAIL — module not found

- [ ] **Step 3: Port the prompt sections**

Move the prototype prompt assembly out of `src/server/services/bedrockService.ts` into the new module, replacing each inline read with the matching specification field: `getMaxviewColorTokens()` becomes `spec.designSystem.colorTokens`, `getFigmaReference().navItems` becomes `spec.designReference.navItems`, and fetched component source becomes `spec.promptInputs.sourceFiles`. Keep the section headings and instruction wording byte-identical to the current prompt.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest src/server/__tests__/aiRunsV2Worker/prototypePromptBuilder.test.ts --runInBand`
Expected: PASS, 2 tests

- [ ] **Step 5: Confirm the isolation guard still holds**

Run: `npx jest src/server/__tests__/aiRunsV2Worker/noDatabaseImports.test.ts --runInBand`
Expected: PASS — the new module must not import `designSystemService`, `aiUsageService`, or anything reaching `db`

- [ ] **Step 6: Commit**

```bash
git add src/server/services/aiRunsV2Worker/prototypePromptBuilder.ts src/server/__tests__/aiRunsV2Worker/prototypePromptBuilder.test.ts
git commit -m "feat: build prototype prompts from the visual specification"
```

---

### Task 5: Give each prototype its own run identity

**Files:**
- Modify: `src/server/services/aiRunV2/v2AdmissionService.ts`
- Test: `src/server/__tests__/aiRunV2Admission.test.ts`

**Interfaces:**
- Produces: `visualRunThreadId(subjectId: string): string` returning `prototype:{subjectId}`.

`createQueuedV2Run` enforces one active V2 run per `threadId` through the `uq_agent_runs_v2_active_thread` index. A PRD generates many prototypes at once, so each needs a distinct thread identity or the second admission is refused as a conflict.

- [ ] **Step 1: Write the failing test**

```typescript
import { visualRunThreadId } from '../services/aiRunV2/v2AdmissionService';

it('gives each prototype a distinct run identity', () => {
  expect(visualRunThreadId('prototype-1')).toBe('prototype:prototype-1');
  expect(visualRunThreadId('prototype-1')).not.toBe(visualRunThreadId('prototype-2'));
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest src/server/__tests__/aiRunV2Admission.test.ts --runInBand`
Expected: FAIL — `visualRunThreadId is not a function`

- [ ] **Step 3: Implement it**

```typescript
/** Prototypes have no chat thread, and one active V2 run is allowed per thread. */
export function visualRunThreadId(subjectId: string): string {
  return `prototype:${subjectId}`;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest src/server/__tests__/aiRunV2Admission.test.ts --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/services/aiRunV2/v2AdmissionService.ts src/server/__tests__/aiRunV2Admission.test.ts
git commit -m "feat: give each visual subject its own run identity"
```

---

### Task 6: Execute the visual workload in the worker

**Files:**
- Modify: `src/server/services/aiRunsV2Worker/visualEntrypoint.ts`
- Test: `src/server/__tests__/aiRunsV2Worker/visualExecute.test.ts`

**Interfaces:**
- Consumes: `buildPrototypePrompt` from Task 4; `isAiRunV2VisualSpecification`.
- Produces: an `ExecuteWorkload` that returns `{ files: [{ path: spec.outputPath, content: html, contentType: 'text/html' }] }`.

**Required adjustment before Step 1.** `ExecutionSpecification` in
`src/server/services/aiRunsV2Worker/specificationClient.ts` currently requires
`runId`, `attemptId`, `attemptNumber`, and `workloadLane`, none of which the
visual specification carries — the command envelope already holds them. Widen
that type to a discriminated union so a lane-specific specification is a legal
blob body:

```typescript
export type ExecutionSpecification =
  | LegacyExecutionSpecification
  | AiRunV2VisualSpecification;
```

Keep `specVersion` as the visual discriminant. Without this the worker cannot
type-check against its own blob.

- [ ] **Step 1: Write the failing test**

```typescript
import { createVisualExecute } from '../../services/aiRunsV2Worker/visualEntrypoint';

it('uploads the generated html under the path the specification names', async () => {
  const execute = createVisualExecute({
    invokeModel: async () => '<html>ok</html>',
  });

  const outcome = await execute({
    specification: {
      specVersion: 1,
      subjectId: 'prototype-1',
      subjectKind: 'design-prototype',
      promptInputs: {},
      designSystem: {},
      designReference: { navItems: [] },
      model: { modelId: 'anthropic.claude' },
      usage: { feature: 'design-prototype' },
      outputPath: 'prototype.html',
    },
    command: {} as never,
    checkpoints: { publishProgress: async () => undefined } as never,
    signal: new AbortController().signal,
  });

  expect(outcome.files).toEqual([
    { path: 'prototype.html', content: '<html>ok</html>', contentType: 'text/html' },
  ]);
});

it('refuses a specification that does not validate', async () => {
  const execute = createVisualExecute({ invokeModel: async () => '<html/>' });

  await expect(
    execute({
      specification: { specVersion: 99 } as never,
      command: {} as never,
      checkpoints: { publishProgress: async () => undefined } as never,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('visual specification');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest src/server/__tests__/aiRunsV2Worker/visualExecute.test.ts --runInBand`
Expected: FAIL — `createVisualExecute is not exported`

- [ ] **Step 3: Implement `createVisualExecute` and replace the refusing stub**

```typescript
export function createVisualExecute(deps: {
  invokeModel: (prompt: string, model: VisualModelSettings) => Promise<string>;
}): ExecuteWorkload {
  return async ({ specification, checkpoints }) => {
    if (!isAiRunV2VisualSpecification(specification)) {
      throw new Error('Command referenced an invalid visual specification');
    }
    await checkpoints.publishProgress('execution', 'running');
    const html = await deps.invokeModel(
      buildPrototypePrompt(specification),
      specification.model,
    );
    return {
      files: [
        {
          path: specification.outputPath,
          content: html,
          contentType: 'text/html',
        },
      ],
    };
  };
}
```

- [ ] **Step 4: Run the tests and the isolation guard**

Run: `npx jest src/server/__tests__/aiRunsV2Worker --runInBand`
Expected: PASS, including `noDatabaseImports`

- [ ] **Step 5: Commit**

```bash
git add src/server/services/aiRunsV2Worker/visualEntrypoint.ts src/server/__tests__/aiRunsV2Worker/visualExecute.test.ts
git commit -m "feat: execute visual workloads from the specification"
```

---

### Task 7: Switch design prototypes onto V2 behind the flag

**Files:**
- Modify: `src/server/services/designPrototypeService.ts`
- Test: `src/server/__tests__/designPrototypeV2Routing.test.ts`

**Interfaces:**
- Consumes: `createV2AdmissionService().admit`, `visualRunThreadId`, `buildPrototypeVisualSpecification`, `createArtifactReader`.

The flag split replaces the in-process `generateSinglePrototype` call inside `generatePrototypesForPrd`. Use the marker syntax from `.cursor/skills/feature-flags/SKILL.md` with `winner=enabled`, keeping the in-process branch intact.

- [ ] **Step 1: Write the failing test**

```typescript
it('admits one V2 run per prototype when the flag is on', async () => {
  const admit = jest.fn().mockResolvedValue({
    status: 'dispatched',
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    dispatchMessageId: 'dispatch-1',
    outboxId: 'outbox-1',
  });

  await generatePrototypesForPrd('prd-1', {
    isFeatureEnabled: async () => true,
    admit,
    generateInProcess: jest.fn(),
  });

  expect(admit).toHaveBeenCalledTimes(2);
  expect(admit.mock.calls[0][0].workloadLane).toBe('visual');
  expect(admit.mock.calls[0][0].threadId).toBe('prototype:prototype-1');
});

it('keeps in-process generation when the flag is off', async () => {
  const admit = jest.fn();
  const generateInProcess = jest.fn();

  await generatePrototypesForPrd('prd-1', {
    isFeatureEnabled: async () => false,
    admit,
    generateInProcess,
  });

  expect(admit).not.toHaveBeenCalled();
  expect(generateInProcess).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest src/server/__tests__/designPrototypeV2Routing.test.ts --runInBand`
Expected: FAIL — `generatePrototypesForPrd` takes one argument

- [ ] **Step 3: Add the injectable seam and the flag split**

Give `generatePrototypesForPrd` an optional dependencies argument defaulting to the real `isFeatureEnabled`, `createV2AdmissionService().admit`, and `generateSinglePrototype`, then wrap the dispatch choice in `ai-runs-v2-transport` markers.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest src/server/__tests__/designPrototypeV2Routing.test.ts --runInBand`
Expected: PASS, 2 tests

- [ ] **Step 5: Run the full prototype suite for regressions**

Run: `npx jest src/server/__tests__/designPrototype --runInBand`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/services/designPrototypeService.ts src/server/__tests__/designPrototypeV2Routing.test.ts
git commit -m "feat: route design prototypes onto V2 behind the transport flag"
```

---

## Out of scope

- UI Lab (`uiLabService.ts`, `routes/uiLab.ts`) — same pattern, separate pass once prototypes prove it.
- Retiring the in-process branch — that is a `feature-flag-cleanup` pass after the flag holds in staging.
- The V1/V2 completion convergence, tracked as an open question in `2026-09-17-apex-ai-workload-reliability-implementation.md`. Task 7 admits the run; applying the artifact back depends on that decision.
- Azure apply, Container App hosting, and `deploy.yml` wiring, all still deferred.

## Verification

```bash
npx jest src/server/__tests__/designContext src/server/__tests__/aiRunV2 src/server/__tests__/aiRunsV2Worker --runInBand
npm run build:server
git diff --check
```
