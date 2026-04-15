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

Connect to the official GitHub MCP server. Bot can answer questions about the target repo by reading its markdown documentation and live issue/PR data.

See [specs/milestone-3-github-mcp.md](specs/milestone-3-github-mcp.md).

| Deliverable | Status | Notes |
|---|---|---|
| GitHub MCP server connection | Implemented | Official GitHub hosted MCP server via HTTP transport (`StreamableHTTPClientTransport`); `GITHUB_TOKEN` via `$VAR` substitution in headers |
| `mcp-servers.json` extensions | Implemented | M3 adds `type` (stdio/http), `url`, `headers`, `allowedTools`; dual transport in `client.js`; default-deny allowlist; `disabledTools` removed |
| Read tools: get file contents from target repo | Implemented | README.md, CONTRIBUTING.md, ADR.md; lazy fetch via Firestore cache |
| Read tools: list/get issues and PRs | Implemented | Always live — no cache; enabled via `allowedTools` in `mcp-servers.json` |
| Firestore doc cache (24h TTL) | Implemented | `src/github/docCache.js`; fail-open on Firestore unavailability; `wrapCallToolWithCache` wrapper |
| `@smelly-bot tools` debug command | Implemented | Static response listing all registered tools grouped by server; bypasses LLM, rate limiter, and progress indicator |
| Tool invocation security layer | Implemented | Pre-invocation validator in `callTool`; path allowlist for doc tools; generic error result to LLM on rejection |
| User display name resolution | Implemented | Resolve Slack user IDs to display names via `users.info`; deduplicated per-invocation via promise cache; LLM sees name + ID |
| Local tool registration via `createMcpClient` | Implemented | `localTools` parameter; LLM sees local and MCP tools uniformly |
| `refresh_repo_doc` local tool | Implemented | `src/github/tools.js`; bypasses TTL via `fetchDirect`; updates Firestore |
| system.md updates | Implemented | GitHub tool routing guidance added to `prompts/system.md` |

## Milestone 4 — GitHub write via MCP + authorization lifecycle

Add write tools scoped to comments and descriptions only. Introduce a two-phase
confirmation UX: bot proposes action and stores full context in Firestore, then
goes to sleep; a `reaction_added` event triggers a new bot invocation that
executes with the stored context. Per-user authorization storage (coarse by
action type) lets users pre-approve and skip future confirmations.
Authorization and revocation ship together — approve-forever without a
revocation path is a one-way door.

MVP phase: approve-once only (no stored auth). Augment in a second phase with
30-day approve-forever + the authorization listing and revocation UX.

| Deliverable | Status | Notes |
|---|---|---|
| Write tools: add comment to issue/PR | Idea | Via GitHub MCP; added to `allowedTools` in `mcp.config.json` |
| Write tools: update issue/PR description | Idea | Via GitHub MCP; added to `allowedTools` in `mcp.config.json` |
| Phase-based tool array injection | Idea | Phase 1 (proposal): read tools only — LLM structurally cannot call write tools. Phase 2 (post-confirmation): read + write tools injected into new invocation |
| Firestore `botMessages/{ts}` collection | Idea | Stores bot message metadata (type, context) keyed by Slack message ts; drives `reaction_added` type dispatch |
| Firestore pending action state | Idea | Stores proposed action + full conversation context; one entry per pending confirmation |
| Reusable confirmation message component | Idea | Structured template; bot posts and sleeps — no LLM involvement at post time |
| `reaction_added` handler (type dispatch) | Idea | Looks up message ts in `botMessages`; dispatches to pending-action or auth-revocation handler |
| Per-user authorization storage | Idea | Coarse by action type; Firestore-backed; 30-day sliding TTL refreshed on each invocation of that tool |
| Approve-once vs. approve-forever UX | Idea | Two emoji options on confirmation message; "forever" stores to Firestore; "once" executes without storing |
| Authorization listing capability | Idea | LLM-generated message listing all active user auths, each with a distinct emoji; bot reacts with all emojis; triggered by NL intent or slash command |
| Slash command for authorization listing | Idea | Registered in Slack app config; surfaces in Slack's command list as explicit fallback alongside NL intent |
| Authorization revocation via emoji | Idea | User reacts to auth listing message with a tool's emoji → silently removes that auth from Firestore; no message changes; fails silently if auth doesn't exist |
| Pending action cleanup | Idea | Strategy TBD for orphaned pending actions where no reaction ever arrives |
