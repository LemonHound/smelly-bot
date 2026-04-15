# CLAUDE.md — project-specific rules for smelly-bot

Read this before planning or implementing anything in this repo.

## Project plan

The authoritative status of every deliverable lives in [PROJECT_PLAN.md](PROJECT_PLAN.md). Before proposing, speccing, or implementing a deliverable:

1. Check PROJECT_PLAN.md for its current status.
2. Keep the plan in sync with reality. When a deliverable moves between statuses (Idea -> Spec -> In Progress -> Implemented -> Done), update the plan in the same change.
3. If you spec or build something not in the plan, add it to the plan.

Statuses:

- **Idea** — described in prose, no spec yet.
- **Spec** — a spec file exists under `specs/` with acceptance criteria.
- **In Progress** — branch/PR open; partial code exists.
- **Implemented** — code merged and working locally.
- **Done** — deployed and verified in the target Slack workspace + repo.

## Spec location

Specs live in `specs/<short-name>.md`. One spec per milestone or discrete scaffolding change. Specs include: Goal, Scope, Non-goals, Acceptance criteria, Open questions.

## Logging convention

All log output uses pino via the shared `src/logger.js` instance. Never use
`console.log` or `console.error` in any `src/` module. Log levels map to GCP
severity: `debug` → DEBUG, `info` → INFO, `warn` → WARNING, `error` → ERROR.
LLM payloads are always logged at `debug` — no feature flag needed.

## Tests

Tests live in `test/`. Any change that alters the behavior or signature of a tested module must update the affected tests in the same change. Never leave tests asserting against a stale API. Adding new behavior without a test requires explicit justification.

## Docs that must stay aligned

- `PROJECT_PLAN.md` — deliverable status
- `ADR.md` — architectural decisions
- `specs/*.md` — acceptance criteria

If code contradicts a spec or ADR, update the doc (or the code) in the same change. Don't leave drift.

## Code Hygiene

Whenever working with code (or by extension, GitHub), use the guidelines below:
1. Pull latest code from `main` if there's reasonable suspicion that local code could be stale
2. When committing code, check that the current branch isn't associated to a closed PR; switch to a new working branch if necessary.
3. When code is pushed to a PR, check that there are no merge conflicts reported. If CI runs, watch it and resolve minor issues automatically.