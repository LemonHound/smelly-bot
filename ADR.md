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

### 5. LLM: Anthropic Claude API (planned, not yet wired)
Rate-limited per-hour and per-day. Budget enforcement will live in a small in-memory/Redis counter (TBD when added).

### 6. GitHub integration: Octokit first (M2-M4), MCP later (M5)
Direct REST via Octokit for the initial GitHub features. MCP migration is its own milestone (M5) once the shape of the actions is settled. Scope stays limited to: comments on issues/PRs, updating descriptions/titles, creating/closing issues, linking issues to PRs/issues.

### 7. Repo relationship to Game AI Website
GitHub has no formal parent/child repos. We link the two repos via README + a shared topic tag. The bot references the target repo at runtime via `GITHUB_REPO` env var.

### 8. Persistence: Firestore (native mode)
Adopted during scaffolding. Used for rate-limit counters now; will hold per-user auth/consent records in later milestones. Free tier covers expected traffic. Chosen over: in-memory (doesn't survive restarts and blocks future user-state features), JSON files (broken on Cloud Run), Memorystore/Redis (~$40/mo floor), Cloud SQL (~$10+/mo floor). Local dev uses the Firestore emulator; prod uses ADC from the runtime service account.

### 9. MVP scope (this commit)
Respond to `app_mention` with a random silly reply (`fart`, a cloud emoji, etc.), threaded to the mention. No LLM, no GitHub, no history scanning. All future features layer in behind this same event handler.

## Non-goals

- Multi-workspace support. Single workspace, single set of friends.
- High availability. One instance is fine; Slack will redeliver missed events when socket reconnects.
- Persistent storage (for now). No DB until a feature actually needs one.

## Open questions

- MCP server vs Octokit for GitHub actions.
- History window size for LLM context and how to chunk it cheaply.
- Rate-limit policy shape (per-user, per-channel, global).
