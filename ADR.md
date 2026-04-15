# Architecture Decision Record

Single doc covering system-wide architecture for smelly-bot. Amend as decisions change.

## Context

A silly Slack bot for a private friend-group channel. Future goals:
- React to `@smelly-bot` mentions.
- Read recent channel history, use an LLM (Claude API) to derive intent, then take GitHub actions (comment, open/close/link issues, update titles/descriptions, etc.) on a separate target repo (the Game AI Website repo).
- Answer repo-state questions by reading `README` and other root markdown in the target repo.

## Decisions

### 1. Language & runtime: Node.js (JavaScript, ESM), Node 20+
Chosen for the maturity of `@slack/bolt` and simplicity. ESM so we can use top-level await.

### 2. Slack transport: dual-mode — Socket Mode locally, HTTP webhooks in production
`SLACK_APP_TOKEN` present → Bolt starts in Socket Mode (outbound WebSocket, no public URL needed). `SLACK_APP_TOKEN` absent → Bolt starts in HTTP mode using `SLACK_SIGNING_SECRET` (inbound POST from Slack). Mode is implicit — no separate flag. Socket Mode is also toggled on the Slack app itself (api.slack.com) to match.

### 3. Hosting: GCP Cloud Run (us-central1), min-instances=0
HTTP webhook mode means Cloud Run can scale to zero — Slack's inbound POST wakes the instance. min-instances=1 is not required (and was previously listed erroneously as a constraint of Socket Mode). Images built via Cloud Build trigger on push to `main`, stored in Artifact Registry. Secrets via Secret Manager.

### 4. Config: `.env` locally, env vars in prod
`.env.example` is the source of truth for required variables. `.env` is gitignored. Prod loads the same names from Secret Manager.

### 5. LLM: Anthropic Claude API
Rate-limited per-hour and per-day via Firestore-backed counters. Model: `claude-haiku-4-5` through M3; upgrade to Sonnet if Q&A quality proves insufficient.

### 6. GitHub integration: MCP from the start (M3+)
The bot is an MCP client. GitHub access uses the official GitHub MCP server rather than direct Octokit calls. Scope for M4: add comment on issue/PR, update issue/PR description. No issue creation in initial milestones.

### 7. MCP client architecture
`src/mcp/client.js` launches configured MCP servers as stdio subprocesses at startup, merges their tool lists, and exposes a single `callTool(toolName, args)` executor. The LLM module receives tools and callTool as injected dependencies — it does not import from `src/mcp/` directly. If a server fails to start, the bot logs a warning and degrades gracefully to plain Claude.

MCP servers configured in `mcp-servers.json` in the project root (not `config.js`). The file is a JSON array of server entries, each with `name`, `command`, and `args`. Adding or removing a server requires editing this file and redeploying — no code change needed.

### 8. Structured logging: pino
All log output uses pino with GCP-compatible field names: `severity` (not `level`), `message` (not `msg`). JSON written to stdout; Cloud Run ingests it automatically into Cloud Logging. Local dev pipes through `pino-pretty`. No module calls `console` directly — all import `logger` from `src/logger.js`. LLM payloads logged always at `debug` severity (no toggle flag).

### 9. Prompt file separation: smelly-bot instructions vs game-ai-hub context
`prompts/` in this repo contains bot instructions only (`system.md`, `topics.md`). These are loaded at startup by explicit name and injected into the Claude system block. They tell the bot how to behave.

Game-ai-hub documentation (README, CONTRIBUTING, ADR) is external context fetched at runtime via GitHub MCP (M3+) and injected into the conversation, not stored in `prompts/`. The two concerns are intentionally separate so instruction files and runtime context don't get mixed.

### 10. Rate limiting policy
Rate limits (per-hour, per-day) guard against unexpected runaway usage — not per-user abuse, since the bot serves a single private workspace. `LLM_MAX_TOOL_ITERATIONS` is the primary runaway guard for tool-use loops. Rate limit defaults are set high during solo development (`RATE_LIMIT_PER_HOUR=200`, `RATE_LIMIT_PER_DAY=1000`) and will be tightened when more users join.

### 11. Repo relationship to Game AI Website
GitHub has no formal parent/child repos. We link the two repos via README + a shared topic tag. The bot references the target repo at runtime via `GITHUB_REPO` env var.

### 12. Persistence: Firestore (native mode)
Adopted during scaffolding. Used for rate-limit counters now; will hold per-user auth/consent records in later milestones. Free tier covers expected traffic. Chosen over: in-memory (doesn't survive restarts and blocks future user-state features), JSON files (broken on Cloud Run), Memorystore/Redis (~$40/mo floor), Cloud SQL (~$10+/mo floor). Local dev uses the Firestore emulator; prod uses ADC from the runtime service account.

### 13. MVP scope (this commit)
Respond to `app_mention` with a random silly reply (`fart`, a cloud emoji, etc.), threaded to the mention. No LLM, no GitHub, no history scanning. All future features layer in behind this same event handler.

## Non-goals

- Multi-workspace support. Single workspace, single set of friends.
- High availability. One instance is fine; Slack will redeliver missed events when socket reconnects.
- Persistent storage (for now). No DB until a feature actually needs one.

## Open questions

- History window size for LLM context and how to chunk it cheaply (M3+).
