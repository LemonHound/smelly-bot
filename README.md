# smelly-bot

A private Slack bot for a friend group. Stinks like shit, but oh so useful.

Companion repo to the Game AI Website project (separate repo; this one owns the bot, that one owns the site).

## Setup (local, Socket Mode)

1. `cp .env.example .env` and fill in Slack tokens.
2. `npm install`
3. `npm start` (or `npm run dev` for watch mode)

### Slack app config

- **Socket Mode:** enabled
- **App-level token** with `connections:write` scope -> `SLACK_APP_TOKEN` (xapp-)
- **Bot token scopes:** `app_mentions:read`, `chat:write`
- **Event subscriptions:** subscribe to `app_mention`
- Install the app to the workspace and invite the bot to the target channel.

## Hosting (GCP)

Planned: deploy as a long-running container (Cloud Run with `min-instances=1`, or a small GCE VM). Socket Mode uses outbound websockets, so no public ingress needed. Load env vars from Secret Manager.

## Layout

- `src/index.js` - bot entry point
- `ADR.md` - architecture decisions
- `CONTRIBUTING.md` - dev workflow
