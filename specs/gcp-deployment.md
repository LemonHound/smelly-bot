# Spec: GCP deployment

## Goal

Deploy smelly-bot to Cloud Run (us-central1) using Artifact Registry for images and Cloud Build for CI. The bot runs in HTTP webhook mode in production; Socket Mode remains local-dev only.

## Scope

### Runtime modes

| Mode | When | Trigger mechanism |
|---|---|---|
| Socket Mode | Local dev (`SLACK_APP_TOKEN` set) | Outbound WebSocket to Slack |
| HTTP webhooks | Production (`SLACK_APP_TOKEN` unset) | Inbound POST from Slack to Cloud Run |

Mode is detected implicitly at startup from the presence of `SLACK_APP_TOKEN` — no separate env var or flag needed. `SLACK_APP_TOKEN` is never set in GCP, so production always runs HTTP. Socket Mode is toggled on the Slack app side (api.slack.com) in tandem: on for local dev, off for production. Bolt's `app.start()` interface is identical in both modes; only the `App` constructor args differ.

### Infrastructure

- **Region**: us-central1 (single region, no distribution)
- **Artifact Registry**: one repository, stores built images
- **Cloud Build**: trigger on push to `main`, builds from `Dockerfile`, pushes to Artifact Registry
- **Cloud Run**: deploys latest image from Artifact Registry
  - min-instances: 0
  - max-instances: 1
  - CPU: 1
  - Memory: 256Mi
  - Concurrency: 1 (one Slack event at a time; rate limiting is global via Firestore)
  - Port: 8080 (Cloud Run default, matches Bolt's default HTTP port)
  - No public URL auth (Slack signs requests; Bolt verifies the signature)

### Secrets (Secret Manager)

| Secret name | Used for |
|---|---|
| `slack-bot-token` | `SLACK_BOT_TOKEN` |
| `slack-signing-secret` | `SLACK_SIGNING_SECRET` (HTTP mode only) |
| `anthropic-api-key` | `ANTHROPIC_API_KEY` |

`SLACK_APP_TOKEN` is local-dev only — never deployed to GCP.

### Environment variables (Cloud Run, not Secret Manager)

```
GOOGLE_CLOUD_PROJECT=<project-id>
FIRESTORE_DATABASE_ID=<db-id>
PORT=8080
LOG_LEVEL=info
RATE_LIMIT_PER_HOUR=30
RATE_LIMIT_PER_DAY=200
THREAD_CONTEXT_MAX_CHARS=6000
```

`FIRESTORE_EMULATOR_HOST` is never set in Cloud Run. The SDK connects to real Firestore via ADC.

### Code changes

1. **`src/config.js`**: add `SLACK_SIGNING_SECRET` as optional field
2. **`src/slack.js`**: detect `config.SLACK_APP_TOKEN` — if set, use Socket Mode; if not, use HTTP mode with signing secret
3. **`Dockerfile`**: Node 20 Alpine, production deps only, non-root user, `CMD ["node", "src/index.js"]`
4. **`.env.example`**: add `SLACK_SIGNING_SECRET` (empty by default, required in prod)

### Slack app configuration (manual, in api.slack.com)

When deploying to GCP for the first time:
1. Disable Socket Mode in the Slack app settings
2. Set the Request URL to the Cloud Run service URL + `/slack/events`
3. Re-enable Socket Mode when switching back to local dev

## Non-goals

- `service.yaml` — Cloud Run service configured manually in GCP console
- `cloudbuild.yaml` — Cloud Build trigger configured manually in GCP console
- Multi-region / load balancing
- Custom domain
- Cloud Armor / WAF

## Acceptance criteria

1. `docker build -t smelly-bot .` succeeds locally with no errors
2. Cloud Build trigger builds and pushes image to Artifact Registry on push to `main`
3. Cloud Run service starts, logs show HTTP server listening on port 8080
4. `@smelly-bot` mention in the Slack channel produces a Claude-generated threaded reply (via HTTP webhooks, Socket Mode off)
5. Service scales to zero when idle; a mention wakes it and produces a reply within a reasonable cold-start window
6. `SLACK_APP_TOKEN` set locally → Socket Mode still works for local dev

## Open questions

None blocking.
