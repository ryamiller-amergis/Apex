# 0004: Documents live in the repository and a script checks them

- Status: Accepted
- Date: 2026-10-28
- Deciders: template maintainers

## Context and Problem Statement

Developers and their agents need one place to learn the architecture, module boundaries, API, runbooks, and testing rules. Documents kept outside the repository drift from the code, and an agent that follows a stale path or a dead link acts on wrong instructions. Where do documents live, and how do they stay accurate?

## Considered Options

- Markdown and text in the repository, with an entry point, a plain-text index, and a validation script
- A wiki or documentation service outside the repository
- A generated documentation site built from the repository

## Decision Outcome

Chosen option: "Markdown and text in the repository", because documents then change in the same pull request as the code, any editor or agent can read them with nothing running, and a script can check them.

`AGENTS.md` links every document. `docs/agent-index.txt` lists them one per line. `pnpm docs:check` runs `scripts/check-docs.mjs`, which reports broken internal links, missing required headings, inline paths that no longer exist, documents missing from the index or the entry point, and workspace members missing from the module map. Its settings are in `docs/docs-check.config.json`. It has no dependencies and never opens a network connection. Each team decides when it runs.

### Consequences

- Good: a rename that breaks a document fails a check instead of misleading a reader.
- Good: a new document or workspace member must be indexed, or the check fails.
- Bad: the check proves links, headings, and paths, not that the prose is correct. Review still carries that.
- Bad: it recognizes `#` headings and inline links only.
