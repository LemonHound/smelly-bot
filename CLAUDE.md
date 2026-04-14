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

## Docs that must stay aligned

- `PROJECT_PLAN.md` — deliverable status
- `ADR.md` — architectural decisions
- `specs/*.md` — acceptance criteria

If code contradicts a spec or ADR, update the doc (or the code) in the same change. Don't leave drift.
