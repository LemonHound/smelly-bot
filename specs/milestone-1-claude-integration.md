# Spec: Milestone 1 — Claude integration
<!-- status: LOCKED — approved for implementation -->

## Goal

Swap the static silly reply for a real Claude-generated response. Cheap model, cache-friendly instruction block, editable instructions via markdown files, conservative rate limiting, graceful failure.

Depends on: [scaffolding.md](scaffolding.md) landed first.

## Scope

### Model

- **`claude-haiku-4-5`** (smallest current Claude). Model id in `config.js` as a constant so it's trivial to bump.
- Max output tokens: 400 (enough for a quippy paragraph, caps cost). Configurable via env.

### Prompt structure

Sent to the Messages API on every mention:

1. **System block**:
   - Concatenation of all `prompts/*.md` files, in filename order, separated by `\n\n---\n\n`.
   - No `cache_control` in M1. Caching is deferred until a later milestone where the system block grows large enough to benefit (e.g. M2 when target-repo context is injected).
2. **Messages**: a single user turn containing
   - A short header line: channel name, user who mentioned the bot (display name, not email).
   - **Thread context**, if the mention is inside an existing thread (see below).
   - The mention text itself.
   - No channel-wide history scan.

### Thread context

Included only when `event.thread_ts` exists and differs from `event.ts` (i.e. the mention is a reply inside a pre-existing thread, not a top-level channel post and not the thread's own root).

Assembly algorithm:

1. Fetch the full thread via Slack `conversations.replies`.
2. Always include the **root message** as an anchor.
3. Walk replies **newest-first**, adding each to the included set until the running character total reaches `THREAD_CONTEXT_MAX_CHARS` (default `6000`). Stop.
4. If the root message alone exceeds the budget, keep only the root, truncated with `... [truncated]`, and include no replies.
5. Render the included messages in **chronological order** in the user turn, one per line, formatted `<display_name>: <text>`. The current mention text is appended last on its own line.

New env vars (both added to `.env.example`):

```
THREAD_CONTEXT_MAX_CHARS=6000
LOG_LLM_PAYLOADS=false
```

`LOG_LLM_PAYLOADS=true` logs the full outgoing system + messages payload and the full Claude response. Default false. Intended for flipping on in GCP via env var when debugging; no separate telemetry stack.

### Reply generator contract

`llm/index.js` exports:

```
makeLlmReply({ config, prompts, rateLimit, anthropicClient })
  -> async (ctx) => string
```

where `ctx = { channelName, mentionUser, mentionText, threadMessages }` and `threadMessages` is `null` or an ordered array of `{ user, text }` chronologically.

Return value is the string to post in-thread. On any failure that prevents the Claude call (rate limit exceeded, API error, timeout, missing/invalid API key), return a single static "brain offline" fallback so the bot never goes silent. **On-topic vs off-topic response shape is handled inside the `system` prompt** — the LLM itself decides when to emit a snarky fart-themed quip — not by code.

### Rate limiting

- Consume 1 token per API call, checked *before* calling Claude.
- Budgets come from `RATE_LIMIT_PER_HOUR` and `RATE_LIMIT_PER_DAY` (defaults 30 / 200).
- On exceeded: emit the static "brain offline" fallback (see below). No mention of specific limits.

### Error handling and hard fallback

- Anthropic SDK call wrapped in try/catch. On error: log and emit the static fallback.
- Timeout: 15s, enforced via `AbortController`.
- No retries in M1.
- **Static fallback** (used only when Claude cannot be called at all): composed at reply time by picking one item from each of three small dictionaries and joining them with a space. All three dictionaries live in one file (`src/fallbacks.js`) so they're trivial to tweak.

  Shape: `<emoji> <snark> <excuse>`

  - `emoji` — fart/poop-flavored: `:dash:`, `:cloud:`, `:poop:`, `:wind_blowing_face:`, etc.
  - `snark` — short dismissive line: `"can't think right now,"`, `"brain's offline,"`, `"no thoughts head empty,"`
  - `excuse` — fart/poop-themed reason: `"ate too much fiber"`, `"stuck in the loo"`, `"methane overload"`, `"gastric emergency"`

  Example outputs: `":dash: brain's offline, ate too much fiber"` / `":poop: no thoughts head empty, stuck in the loo"`

  The composer does not memoize; every fallback is a fresh roll. A tiny catalog (~5-8 per slot) is sufficient — the combinatorial count across three slots keeps repeats rare.

- All on-topic and off-topic *stylistic* fallbacks (when Claude *is* reachable) are handled by the `system` prompt, not code.

### Configurability without code changes

- Persona / tone / rules live in `prompts/system.md` (and any sibling `prompts/*.md`). Edit the file, restart the bot, done.
- Model id, max tokens, thread context size, and rate limits are all env vars.

## Non-goals

- Streaming responses (Slack doesn't need it for one-shot replies).
- Multi-turn memory beyond the immediate Slack thread.
- Tool use / function calling (comes with M2+).
- Channel-wide history scanning (M2+).
- Cost tracking dashboard. Just logs for now.

## Acceptance criteria

1. `@smelly-bot say hi in the voice of a Victorian ghost` produces a Claude-generated reply posted in-thread.
2. Editing `prompts/system.md` and restarting the bot changes subsequent replies in a way consistent with the edit.
3. A forced 31st call inside one hour returns the static "brain offline" fallback, not a Claude call (verify by temporarily setting `RATE_LIMIT_PER_HOUR=2`).
4. Killing internet / invalidating `ANTHROPIC_API_KEY` and mentioning the bot produces the static fallback, no unhandled promise rejection.
5. When the mention is a reply inside a thread, the root message + most recent replies (within `THREAD_CONTEXT_MAX_CHARS`) appear in the outgoing payload. When the mention is at channel top-level, no thread context is included. Verify via `LOG_LLM_PAYLOADS=true`.
6. PROJECT_PLAN.md rows for M1 flip to Implemented.

## Open questions

None blocking. Possible follow-ups for later milestones:

- Slack scope addition: `conversations.replies` requires `channels:history` (public channels) and/or `groups:history` (private). Verify scopes are granted on the Slack app before M1 testing; add to README if new scopes are needed.
