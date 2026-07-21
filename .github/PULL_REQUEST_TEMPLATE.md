## Summary

<!-- What changed and why (1–3 bullets). Focus on intent, not a file list. -->

-

## Test plan

<!-- How this was verified. Check what applies; add steps a reviewer can follow. -->

- [ ] `npm test` (or note which suites were run)
- [ ] `npm run lint:check` / pre-commit ESLint passed on touched files
- [ ] Manual smoke: local app starts and the changed flow works
- [ ]

## Checklist

<!-- Skip items that do not apply. -->

- [ ] No secrets committed (`.env`, `.env.local`, credentials)
- [ ] DB migration included (and tested locally) if schema changed
- [ ] Changelog updated if this is user-facing / releasable
- [ ] Feature flag considered if this is a risky or partial rollout
- [ ] Docs / README updated if setup or developer workflow changed
