# Project plan

Single source of truth for deliverable status. Update in the same change that moves a deliverable.

Status legend: **Idea** | **Spec** | **In Progress** | **Implemented** | **Done**

## Milestone 0 — MVP scaffolding (bootstrap)

| Deliverable | Status | Notes |
|---|---|---|
| Bolt app + Socket Mode | Implemented | `src/index.js` |
| Static reply on `@-mention` | Implemented | Random silly string, threaded |
| ADR, README, CONTRIBUTING, .env.example, .gitignore | Implemented | |

## Scaffolding overhaul (pre-M1)

Prepares the codebase for M1 and beyond. See [specs/scaffolding.md](specs/scaffolding.md).

| Deliverable | Status | Notes |
|---|---|---|
| Split `src/index.js` into modules | Implemented | |
| `config.js` with env validation | Implemented | |
| `prompts/` directory + loader | Implemented | Markdown instruction files |
| `firestore.js` client factory | Implemented | Emulator in dev, ADC in prod |
| `rateLimit.js` (Firestore-backed per-hour + per-day) | Implemented | Transactional, survives restarts |
| `fallbacks.js` composer + dictionaries | Implemented | Hard-failure reply |
| `llm/` module placeholder (wired in M1) | Implemented | |

## Milestone 1 — Claude integration (respond via LLM)

See [specs/milestone-1-claude-integration.md](specs/milestone-1-claude-integration.md).

| Deliverable | Status | Notes |
|---|---|---|
| Anthropic SDK wired up | Implemented | `@anthropic-ai/sdk`, Haiku |
| System/persona instruction files in `prompts/` | Implemented | LLM-driven on/off-topic routing via prompt |
| Mention -> Claude -> threaded reply | Implemented | |
| Thread context for in-thread mentions | Implemented | Root + newest replies, char-budgeted |
| Debug payload logging (`LOG_LLM_PAYLOADS`) | Implemented | Env-toggled, for GCP + local use |
| Rate limit enforcement | Implemented | Global, per-hour + per-day |
| Composed fallback (emoji + snark + excuse) on hard failures | Implemented | `src/fallbacks.js`, random pick per slot |
| Progress indicator (reactions + status message) | Implemented | Pulled forward from M5; emoji phases + edited status message |
| Rate limiter fail-open with 3s timeout | Implemented | `Promise.race` guard; no hang on Firestore unavailability |

---
> Milestones 2–5 below are **Idea** status. No spec files exist yet. Each needs a spec written and reviewed before implementation begins.
---

## Milestone 2 — Answer questions about target repo

May require a larger model (context window) than M1's Haiku.

| Deliverable | Status | Notes |
|---|---|---|
| GitHub client module (direct REST via Octokit) | Idea | MCP path lives in M5 |
| Read README + root `*.md` from `GITHUB_REPO` | Idea | |
| Inject repo context into Claude prompts | Idea | Stable across calls |
| Prompt caching on system block (incl. repo context) | Idea | First milestone where caching actually pays off |
| Q&A routing ("what does X do", "can it Y yet") | Idea | |

## Milestone 3 — Infer and create issues from chat

| Deliverable | Status | Notes |
|---|---|---|
| Channel history scan (configurable window) | Idea | |
| Issue-detection prompt | Idea | |
| Create issue on target repo | Idea | |
| Confirmation UX in Slack before creation | Idea | Avoid noisy issue spam |

## Milestone 4 — Triage existing issues

| Deliverable | Status | Notes |
|---|---|---|
| List + read existing issues | Idea | |
| Duplicate / stale detection prompt | Idea | |
| Update / close / link issues | Idea | |
| Audit log in Slack thread | Idea | |

## Milestone 5 — MCP + progress UX

Swap direct Octokit calls for an MCP server for GitHub actions, and add progress feedback in Slack so users know the bot is working.

| Deliverable | Status | Notes |
|---|---|---|
| GitHub MCP server wired up | Idea | Replaces or fronts M2/M3/M4 Octokit usage |
| Migrate M2-M4 GitHub actions to MCP tools | Idea | |
| Streaming progress UX (ephemeral or edited message) | Implemented | Pulled into M1; see progress indicator row above |
| No mid-flight user input re-ingestion | Non-goal | Snapshot at invocation; re-prompt requires new `@-mention` |
| Retry policy for non-LLM-costing failures | Idea | e.g. transient Slack/GitHub 5xx; never re-call Claude on retry |

## Cross-cutting

| Deliverable | Status | Notes |
|---|---|---|
| Deploy to GCP (Cloud Run min-instances=1) | Idea | After M1 |
| Secret Manager wiring | Idea | |
| Observability (logs, error reporting) | Idea | |
