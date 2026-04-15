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

## Cross-cutting

| Deliverable | Status | Notes |
|---|---|---|
| Deploy to GCP (Cloud Run) | Done | HTTP mode only going forward; Socket Mode retained as local troubleshooting fallback only |
| Secret Manager wiring | Done | Secrets managed in GCP console |
| Observability (logs, error reporting) | Idea | |

---
> Milestones 2–4 below are the current roadmap. All are Idea status unless noted. Each needs a spec written and reviewed before implementation begins.
---

## Milestone 2 — MCP client scaffolding + Wikipedia

Primary goal: build and validate the full MCP client stack (tool registration, tool-use loop, result ingestion) using Wikipedia as a safe, low-stakes first server. Bot gains the ability to look up real-world facts and defaults to surfacing random factoids about pre-configured topics when conversation is casual.

See [specs/milestone-2-mcp-wikipedia.md](specs/milestone-2-mcp-wikipedia.md).

| Deliverable | Status | Notes |
|---|---|---|
| `@modelcontextprotocol/sdk` wired as MCP client | Implemented | `src/mcp/client.js` |
| Wikipedia MCP server connection (stdio) | Implemented | `@shelm/wikipedia-mcp-server` pinned dep, launched via npx |
| MCP server config layer | Implemented | `mcp-servers.json` in project root, loaded by `src/index.js` |
| Tool-use loop in `makeLlmReply` | Implemented | Multi-turn: tool_use → execute → tool_result → continue |
| Prompt caching on system block | Implemented | `topics.md` block carries `cache_control: ephemeral` |
| Pre-configured topic list in `prompts/topics.md` | Implemented | Bot's default "interests" for casual mentions |
| `@smelly-bot` surfaces factoids using Wikipedia tool | Implemented | LLM decides when to call it |
| Structured logging via pino | Implemented | `src/logger.js`; GCP severity mapping; replaces all console.* |

## Milestone 3 — GitHub read via MCP

Connect to the official GitHub MCP server. Bot can answer questions about the target repo by reading its markdown documentation.

| Deliverable | Status | Notes |
|---|---|---|
| GitHub MCP server connection | Idea | Official `@modelcontextprotocol/server-github` |
| Read tools: get file contents from target repo | Idea | README.md, CONTRIBUTING.md, ADR.md |
| Firestore cache for fetched docs (TTL-based staleness) | Idea | Auto-refresh when stale |
| LLM-triggered doc refresh tool | Idea | LLM calls refresh when context warrants it |
| Q&A routing for repo questions | Idea | No code routing — LLM decides based on context |

## Milestone 4 — GitHub write via MCP + emoji confirmation UX

Add write tools scoped to comments and descriptions only. Introduce emoji reaction as confirmation UX — a pattern needed for all write operations going forward.

| Deliverable | Status | Notes |
|---|---|---|
| Write tools: add comment to issue/PR | Idea | Via GitHub MCP server |
| Write tools: update issue/PR description | Idea | Via GitHub MCP server |
| Emoji confirmation UX | Idea | Bot previews action + reacts with options; user reacts to confirm/cancel |
| `reaction_added` event handler | Idea | New Slack event scope required |
| Timeout/cancel on no reaction | Idea | Configurable window, default ~5 min |
