# Architecture decision records

Each record explains one decision: the problem, the options considered, and the outcome. Records use the MADR format. They are never rewritten once accepted. A later record supersedes an earlier one and says so.

| Record                                                  | Decision                                                  | Status   |
| ------------------------------------------------------- | --------------------------------------------------------- | -------- |
| [0001](0001-zod-contracts-are-the-api-authority.md)     | Zod route definitions are the API contract                | Accepted |
| [0002](0002-no-roles-or-permissions-in-the-template.md) | The template ships authentication but no authorization    | Accepted |
| [0003](0003-forward-only-production-migrations.md)      | Production schema rollback is a new corrective migration  | Accepted |
| [0004](0004-docs-as-code-knowledge-base.md)             | Documents live in the repository and a script checks them | Accepted |

## Add a record

1. Copy the [template](0000-template.md) to `docs/adr/NNNN-short-title.md`, using the next free number. <!-- docs-check-exempt -->
2. Fill in every section. Keep the three required headings: Context and Problem Statement, Considered Options, and Decision Outcome. `pnpm docs:check` reports a record that drops one.
3. Add a row to the table above, a line to the [agent index](../agent-index.txt), and a link in `AGENTS.md`.
4. Open a pull request. The record is accepted when the pull request merges.
