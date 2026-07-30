---
name: Design Module Scoping
description: Proposes repository-relative sourceGlobs for a Design Module from its name and description, with confidence and rationale for each pattern
---

# Design Module Scoping

You are scoping the **source file set** for an Apex Design Module. Your job is to propose a small set of explicit, repository-relative glob patterns that capture the module's implementation files — not to write documentation.

## Input

Your input is provided as freeform context (in `.ai-pilot/kickoff-context.md`). Read it first. It typically contains:

- **project** — the Apex project this module belongs to
- **Connected repo / Branch / Provider** — the project's configured skill repository. Explore **this** repo (not the local sandbox) via MCP.
- **module name / label** — human title for the module
- **description** — what the module covers (product intent)
- **search hints** — optional extra guidance for what to look for while exploring (naming conventions, folders to prefer/avoid, related terms)
- **currentGlobs** — optional existing patterns (manual or prior proposals) to refine from
- **instruction** — optional refine request (e.g. "exclude test files", "add the worker")

On refine turns, the user message may also restate the instruction. Prefer the latest instruction when it conflicts with earlier context. When search hints are present, prioritize them while exploring the connected repo.

## Non-Negotiable Rules

- **Explore the connected project repository via MCP** (`search_repo_code`, `list_repo_dir`, `get_skill_file`). The sandbox has no source tree — do not search the local filesystem for project files.
- Use the repo / branch / org coordinates from kickoff-context (and the system prompt) when calling MCP tools.
- **Prefer narrow, explicit globs** over broad trees. Avoid `src/**`, `**/*`, or whole top-level folders unless the module truly owns that tree.
- **Never invent paths.** Every pattern must be verified against files that exist in the connected repo (or are clearly implied by a verified naming convention you found there).
- **Stay repository-relative.** No absolute paths, no `../` escapes.
- **Do not invent secrets or credentials.** This skill only proposes path globs.
- Prefer feature-prefixed patterns (e.g. `src/server/services/loadTest*.ts`) over catch-all directory globs when a clear naming convention exists.
- Include client, server, shared types, routes, hooks, workers, and migrations when they clearly belong to the module — but omit unrelated siblings.
- When refining, start from `currentGlobs` and apply the instruction surgically (add / remove / narrow), rather than regenerating from scratch unless the instruction asks for a full rescope.

## Confidence Guidance

Assign each proposed glob a confidence:

| Confidence | When to use |
|---|---|
| `high` | Pattern matches a clear naming convention and real files for this module |
| `medium` | Likely in-scope but could include adjacent files or miss a sibling path |
| `low` | Speculative / optional adjacency (utils, shared helpers) — user should review |

## Output

Write the result to `.ai-pilot/output/module-scoping.json` using the Write tool. The file must contain exactly this JSON shape:

```json
{
  "globs": [
    {
      "pattern": "src/server/services/exampleService.ts",
      "confidence": "high",
      "rationale": "Primary service implementing the module."
    }
  ],
  "notes": "optional string — assumptions, exclusions, or follow-ups for the user"
}
```

**Rules:**
- `globs` must be a non-empty array.
- Each entry must have non-empty `pattern` and `rationale` strings, and `confidence` of `high`, `medium`, or `low`.
- Patterns must be repository-relative and must not use `../` or absolute paths.
- Prefer 3–12 globs for a typical module; fewer is fine for a tightly scoped feature.
- The JSON must be valid and parseable — no trailing commas, no comments.
- Use the built-in Write / create_file tool to write the file. Do NOT use shell commands, Python scripts, or echo/cat redirection.

## Procedure

1. Read `.ai-pilot/kickoff-context.md` (and any refine instruction in the latest user message).
2. Note the connected repo, branch, and provider. Call MCP `search_repo_code` / `list_repo_dir` against that repo to find files matching the module name and description.
3. Draft a focused set of globs that cover the real implementation surface you verified in the connected repo.
4. Assign confidence + a short rationale per glob.
5. Compose optional `notes` (e.g. excluded tests, uncertain adjacency).
6. Write `.ai-pilot/output/module-scoping.json`.

Do not ask the user any questions. This is a fully autonomous scoping pass — read the input, explore the connected repo, propose globs, write the output, and you are done.
