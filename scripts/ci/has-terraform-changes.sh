#!/usr/bin/env bash
# Detect whether Terraform inputs under infra/ changed between BASE_SHA and HEAD_SHA.
# Markdown files are ignored. Writes the GitHub Actions output:
#   terraform  (true|false)
#
# Required env:
#   BASE_SHA
#   HEAD_SHA
#   GITHUB_OUTPUT
# Optional env:
#   DIFF_MODE=branch         count only HEAD's own changes since its merge base
#                            with BASE_SHA, so a branch that is merely behind
#                            BASE_SHA does not look like an infra change.
#   REQUIRE_UP_TO_DATE=true  when infra changed, fail unless HEAD contains
#                            BASE_SHA. Applying an out-of-date branch would undo
#                            infra changes merged after it branched.

set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

# Without the glob magic, * in a pathspec also matches /, so this covers nested docs.
paths=(infra ':(exclude)infra/*.md')

range=("$BASE_SHA" "$HEAD_SHA")
if [ "${DIFF_MODE:-}" = "branch" ]; then
  range=("$BASE_SHA...$HEAD_SHA")
fi

if git diff --quiet "${range[@]}" -- "${paths[@]}"; then
  echo "terraform=false" >> "$GITHUB_OUTPUT"
  echo "terraform: unchanged"
  exit 0
fi

echo "terraform: changed"
git diff --name-only "${range[@]}" -- "${paths[@]}" || true

if [ "${REQUIRE_UP_TO_DATE:-}" = "true" ] && ! git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA"; then
  echo "::error::This ref changes infra/ but does not contain ${BASE_SHA}. Merge or rebase on main before applying Terraform." >&2
  exit 1
fi

echo "terraform=true" >> "$GITHUB_OUTPUT"
