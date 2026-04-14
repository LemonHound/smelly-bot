# Spec: Scaffolding overhaul
<!-- status: LOCKED — approved for implementation -->

## Goal

Refactor the current single-file bot into small, obvious modules that M1 can plug into without reshuffling. Keep it minimal — only what M1 strictly needs, plus one or two extension points we *know* M2+ will want.

## Scope

### New layout

```
src/
  index.js          # thin entry: load config, init Firestore, start Slack app
  config.js         # read + validate env, export typed config object
  slack.js          # Bolt app construction + event handlers
  firestore.js      # Firestore client factory (emulator in dev, ADC in prod)
  llm/
    index.js        # Claude client (implemented in M1; stub here)
    prompts.js      # load prompt files from prompts/
  rateLimit.js      # Firestore-backed per-hour + per-day counter
  fallbacks.js      # emoji + snark + excuse dictionaries and composer
prompts/
  system.md         # base persona/instructions (content added in M1)
```

### What each module owns

- **`config.js`** — reads `process.env`, validates required vars are present, throws on missing, exports a frozen object. Required for M0: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`. Optional for M0, required in M1: `ANTHROPIC_API_KEY`. Exposes `LOG_LEVEL`, `PORT`, rate-limit knobs.
- **`slack.js`** — builds the Bolt `App`, registers the `app_mention` handler. Handler calls an injected "reply generator" function so the handler itself doesn't know about Claude vs static strings. M0 injects the silly-string generator; M1 will swap in the Claude generator.
- **`llm/index.js`** — in this spec: a stub that exports a function signature matching what `slack.js` expects. M1 fills it in.
- **`llm/prompts.js`** — synchronous, at startup: read every `*.md` in `prompts/`, return `{ [basename]: string }`. No hot reload.
- **`firestore.js`** — returns a single `Firestore` instance. In dev it points at the local emulator via `FIRESTORE_EMULATOR_HOST` (the `@google-cloud/firestore` SDK picks this up automatically). In prod on GCP, Application Default Credentials from the runtime's service account are used — no keys in code. `GOOGLE_CLOUD_PROJECT` is required either way.
- **`rateLimit.js`** — exposes `async tryConsume()` returning `{ ok: true }` or `{ ok: false, retryAfterMs }`. Two buckets: hourly and daily, stored in a single Firestore doc (`rate_limits/global`) with fields `{ hourly_count, hourly_window_start, daily_count, daily_window_start }`. Each `tryConsume` runs a transaction: read the doc, reset any window whose start is older than its period, reject if either bucket is at limit, otherwise increment both counts. Limits read from config.
- **`fallbacks.js`** — the three dictionaries (emoji / snark / excuse) and a `composeFallback()` function. Pure, no deps.

### Env additions

`.env.example` gains:

```
RATE_LIMIT_PER_HOUR=30
RATE_LIMIT_PER_DAY=200
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
# Local dev only — points the Firestore SDK at the emulator
FIRESTORE_EMULATOR_HOST=localhost:8080
```

### New runtime dependency

- `@google-cloud/firestore` — official SDK, uses ADC in prod, emulator in dev via `FIRESTORE_EMULATOR_HOST`.

### index.js behavior

```
const config = loadConfig();
const firestore = getFirestore(config);
const rateLimit = makeRateLimit({ firestore, config });
const prompts = loadPrompts();
const reply = config.ANTHROPIC_API_KEY
  ? makeLlmReply({ config, prompts, rateLimit })
  : makeStaticReply();
const app = buildSlackApp({ config, reply });
await app.start();
```

During this scaffolding change, `makeLlmReply` does not exist yet — `index.js` uses `makeStaticReply` unconditionally, and the code path is added in M1. The conditional above describes the *end* state after M1 lands. The Firestore + `rateLimit` wiring is live now even though nothing consumes it yet; this lets us verify the persistence layer works before M1 starts depending on it.

## Non-goals

- No GitHub client, no Octokit install, no MCP wiring.
- No test framework.
- No hot reload of prompt files.
- No per-user or per-channel rate limits (global only for M1).
- No Firestore schema migration tooling — collections are created on first write.
- No logger abstraction. Keep `console.log` / `console.error`.

## Acceptance criteria

1. `npm start` produces identical behavior to current `main`: `@-mention` gets a random silly reply threaded to the mention.
2. `src/index.js` is under ~25 lines and contains no event-handler logic.
3. `config.js` throws with a clear message if a required env var is missing.
4. `prompts/system.md` exists (empty or one-liner) and `llm/prompts.js` reads it.
5. With the Firestore emulator running locally, `rateLimit.tryConsume()` increments counts in the emulator and rejects once limits are reached. Counts survive a bot restart.
6. With no emulator and no `GOOGLE_APPLICATION_CREDENTIALS`, startup fails fast with a clear message (rather than hanging on Firestore calls later).
7. `PROJECT_PLAN.md` rows for scaffolding flip to Implemented when merged.

## Open questions

1. Rate-limit scope: global only, or per-user? Spec assumes global. Per-user is cheap to add later.
2. Prompt file naming: one `system.md` is fine for M1. If we want multi-persona selection later, we pick it up then.
