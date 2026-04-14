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

### 2. Slack transport: Socket Mode via `@slack/bolt`
No public HTTP ingress required. Outbound websocket to Slack. Simpler local dev and cheaper hosting (Cloud Run or a small VM, no load balancer).

### 3. Hosting: GCP (Cloud Run, min-instances=1, or GCE e2-micro)
Long-lived process is required for Socket Mode. Cloud Run with a warm instance is the default. Secrets via Secret Manager, surfaced as env vars.

### 4. Config: `.env` locally, env vars in prod
`.env.example` is the source of truth for required variables. `.env` is gitignored. Prod loads the same names from Secret Manager.

### 5. LLM: Anthropic Claude API (planned, not yet wired)
Rate-limited per-hour and per-day. Budget enforcement will live in a small in-memory/Redis counter (TBD when added).

### 6. GitHub integration: TBD between MCP server and direct REST (Octokit)
Either works. MCP is preferred for the "fun" factor; if an MCP server proves awkward for the bot runtime, fall back to Octokit. Scope will be limited to: comments on issues/PRs, updating descriptions/titles, creating/closing issues, linking issues to PRs/issues.

### 7. Repo relationship to Game AI Website
GitHub has no formal parent/child repos. We link the two repos via README + a shared topic tag. The bot references the target repo at runtime via `GITHUB_REPO` env var.

### 8. MVP scope (this commit)
Respond to `app_mention` with a random silly reply (`fart`, a cloud emoji, etc.), threaded to the mention. No LLM, no GitHub, no history scanning. All future features layer in behind this same event handler.

## Non-goals

- Multi-workspace support. Single workspace, single set of friends.
- High availability. One instance is fine; Slack will redeliver missed events when socket reconnects.
- Persistent storage (for now). No DB until a feature actually needs one.

## Open questions

- MCP server vs Octokit for GitHub actions.
- History window size for LLM context and how to chunk it cheaply.
- Rate-limit policy shape (per-user, per-channel, global).
