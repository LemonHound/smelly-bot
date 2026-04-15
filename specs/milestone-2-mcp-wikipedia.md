# Spec: Milestone 2 — MCP client scaffolding + Wikipedia
<!-- status: DRAFT — pending review -->

## Goal

Wire up the bot as an MCP client and validate the full tool-use loop against a
safe, real-world MCP server. Wikipedia is the target: no auth, read-only,
public data. The bot gains the ability to look up facts and defaults to
surfacing random factoids about pre-configured topics during casual mentions.

This milestone is also when structured logging (pino) and prompt caching land.
Both are blocked on M1 for the same reason: the system block wasn't large
enough for caching to pay off, and logging was deferred to avoid premature
infrastructure decisions.

This milestone is primarily an infrastructure milestone. Wikipedia functionality
is the proof that the scaffolding works end-to-end — it is not the destination.

Depends on: M1 (Claude integration) landed and deployed.

## Scope

### Structured logging (`src/logger.js`)

Replace all `console.log` / `console.error` calls with a pino logger.

`src/logger.js` exports a single configured logger instance:

```js
import pino from 'pino';

export const logger = pino({
  messageKey: 'message',
  formatters: {
    level(label) {
      const severity = {
        trace: 'DEBUG', debug: 'DEBUG',
        info: 'INFO',   warn: 'WARNING',
        error: 'ERROR', fatal: 'CRITICAL',
      };
      return { severity: severity[label] ?? 'DEFAULT' };
    },
  },
});
```

All modules import `logger` from `src/logger.js`. No module calls `console`
directly.

In production (Cloud Run), pino writes JSON to stdout. GCP Cloud Logging
ingests it automatically and maps `severity` to log severity levels.

In local dev, pipe through `pino-pretty`:
```
npm run dev | pino-pretty
```
`pino-pretty` is a dev dependency only.

`LOG_LLM_PAYLOADS` env var is removed. LLM payloads (outgoing system +
messages, incoming response) are logged always at `logger.debug()`. There is
no added cost to logging on GCP at this traffic volume.

New dependency: `pino`
New dev dependency: `pino-pretty`

### MCP client layer (`src/mcp/`)

`src/mcp/client.js` — starts and connects to configured MCP servers, exposes
a unified tool list and a `callTool(serverName, toolName, args)` executor.

Servers are configured as an array in `config.js`, each entry with:
- `name` — identifier used in logs
- `command` + `args` — stdio subprocess to launch
- `env` — optional env overrides passed to the subprocess

On startup: launch each configured server as a child process, connect via
stdio transport, call `listTools()`, merge all tool definitions into a single
flat array. If a server fails to start: `logger.warn(...)` and continue without
it. Bot remains functional without any MCP servers (falls back to plain Claude).

`callTool(serverName, toolName, args)` — routes a tool call to the correct
server, returns the result content. Throws on timeout (15s) or server error;
caller handles the error and feeds a `tool_result` with `is_error: true` back
to Claude.

### Wikipedia MCP server

Package: `@shelm/wikipedia-mcp-server`
Launch: `npx -y @shelm/wikipedia-mcp-server` (stdio transport, no auth)

Tools exposed by this server:
- `findPage` — search for Wikipedia pages matching a query
- `getPage` — get full content of a Wikipedia page by title
- `onThisDay` — get historical events that occurred on a specific date
- `getImagesForPage` — get images from a Wikipedia page by title

All four are passed to Claude verbatim after `listTools()`. No manual tool
schema definition in bot code.

`onThisDay` is particularly useful for the default factoid behavior: the bot
can call it with today's date to surface historical events without needing a
search query.

### Tool-use loop in `makeLlmReply`

Current flow: build messages → call Claude → return text.

New flow:

```
build messages (system block + user turn + tool definitions)
  → call Claude
  → if stop_reason === "tool_use":
      for each tool_use block:
        route to MCP via callTool()
        collect tool_result (or error result)
      append assistant turn + tool_result turn to messages
      loop back to call Claude
  → when stop_reason === "end_turn":
      extract text content → return
```

Max tool-use iterations: `LLM_MAX_TOOL_ITERATIONS` (default `5`, env-
configurable). If the limit is hit, return the static fallback — this is a
guard against runaway loops, not an expected path.

The existing 15s `AbortController` timeout applies to each individual Claude
call in the loop, not the total. Each `callTool()` also has its own 15s
timeout.

### Prompt file loading

Two files in `prompts/` are loaded by explicit name at startup — no glob:

- `prompts/system.md` — persona, behavior rules, and tool-use instructions.
  This is the orchestrator: it tells the bot what to do in every situation
  and which tools to reach for. Must be updated during M2 implementation to
  cover all tool-use pathways (factoid mode, insult mode, direct questions).
- `prompts/topics.md` — factoid topics and insult fodder lists (see below).
  Referenced by section name in `system.md`.

These files are smelly-bot's own instruction files. They are not to be
confused with the game-ai-hub repo's documentation (README, CONTRIBUTING,
ADR), which is external context fetched at runtime in M3 and injected into
the conversation — not stored in `prompts/`.

### Prompt caching on system block

Now justified: the system block (persona + topics) is large enough that cache
hits are net-positive. Both files are sent as separate content items so the
cache boundary sits at the end of `topics.md`.

```js
system: [
  { type: "text", text: systemMd },
  { type: "text", text: topicsMd, cache_control: { type: "ephemeral" } },
]
```

Apply `cache_control: { type: "ephemeral" }` to the `topics.md` item only.

### Pre-configured topics (`prompts/topics.md`)

A markdown file with two named sections that the system prompt references by
name. Loaded as part of the system block.

```markdown
## Factoid topics

Topics to look up when conversation is casual or the user gives no clear
direction. Pick one, use findPage + getPage (or onThisDay for historical
events), and share something interesting.

- Fermentation
- Transit systems
- Cephalopods
- [add more here]

## Insult fodder

Things that are comically small, short, slow, or otherwise diminutive.
When the mood is right, look one up and use it to roast the person who
invoked you — compare them unfavorably to whatever you find.

- Tardigrades
- The pygmy seahorse
- The shortest wars in history
- [add more here]
```

The system prompt instructs the bot:
- When a mention is casual or ambiguous, pick from **Factoid topics** and use
  `findPage` + `getPage` (or `onThisDay`) to surface something interesting.
- When the bot wants to needle the invoking user, pick from **Insult fodder**,
  look it up, and construct a comparison roast ("you make [thing] look
  imposing").
- The LLM decides when each mode is appropriate — no code-level routing.

Adding a new entry to either section requires only editing this file and
redeploying (the file is loaded at startup as part of the system block).

### Startup sequence

MCP client initialization happens at app startup, before Bolt registers event
handlers and begins processing mentions. Sequence:

1. Load config, validate env vars.
2. Initialize Firestore client.
3. Launch MCP server subprocesses, call `listTools()`, merge tool list.
   If a server fails: `logger.warn(...)`, continue with reduced tool list.
4. Bolt app starts listening for events.

Within a mention handler, the existing M1 progress sequence is preserved:

1. Add `:eyes:` reaction (immediate acknowledgment to user).
2. Start 5-second status update loop (non-blocking `setInterval`).
3. Call `makeLlmReply` with the already-initialized tool list.
4. Tool-use loop runs; timer loop interleaves via Node.js event loop.
5. Reply posted; timer cleared.

No GCP architecture changes required. Node.js's event loop handles the timer
and the `await`-based tool-use loop concurrently without threading.

### Configurability

New or updated entries in `config.js` and `.env.example`:

```
LLM_MAX_TOOL_ITERATIONS=5
RATE_LIMIT_PER_HOUR=200     # effectively unrestricted for solo dev
RATE_LIMIT_PER_DAY=1000     # same; tighten when more users join
```

`LLM_MAX_TOOL_ITERATIONS` is the primary guard against runaway usage — a bug
that loops Claude calls is capped here regardless of rate limits. Rate limit
defaults are set high for solo development but the mechanism stays in place
for when the bot has more users.

MCP server list is hardcoded in `config.js` (no env-driven server config).
Adding a server requires editing `config.js` and redeploying.

`LOG_LLM_PAYLOADS` is removed from `.env.example` and from all code.

### Module boundary

`src/mcp/` is self-contained. `llm/index.js` receives the tool list and
`callTool` function as injected dependencies — it does not import from
`src/mcp/` directly. This keeps the LLM module testable without live MCP
servers.

Revised `makeLlmReply` signature:

```js
makeLlmReply({ config, prompts, rateLimit, anthropicClient, tools, callTool })
  -> async (ctx) => string
```

`tools` is the flat array of tool definitions from all connected servers.
`callTool` is the routing function from `src/mcp/client.js`. Both default to
empty array / no-op if no MCP servers are configured.

## Non-goals

- GitHub integration (M3).
- Firestore caching of MCP results (M3).
- Write operations of any kind.
- Building a custom MCP server.
- Dynamic server registration at runtime.
- Per-tool permissions or sandboxing.

## Acceptance criteria

1. `@smelly-bot tell me something interesting` results in the bot calling a
   Wikipedia tool, retrieving content, and posting a factoid. Verify via
   pino debug logs that a `tool_use` block appears in the Claude response and
   a `tool_result` block appears in the follow-up turn.
2. The factoid is about one of the topics listed in `prompts/topics.md` (when
   the mention gives the bot no other direction), or is an `onThisDay` result
   for today's date.
3. `@smelly-bot what is the Maillard reaction?` returns a Wikipedia-grounded
   answer — not a hallucinated one. Content matches the Wikipedia article.
4. If the Wikipedia server fails to start, the bot logs a `WARNING`-severity
   entry via pino and continues working as a plain Claude bot. No crash, no
   unhandled rejection.
5. If a tool call times out or returns an error, Claude receives an error
   `tool_result` and formulates a reply acknowledging it couldn't fetch the
   info. The static fallback is not triggered (that is reserved for Claude call
   failures).
6. GCP Cloud Logging shows `severity` field (INFO/WARNING/ERROR) on all log
   entries — not `level`. Verify in Cloud Logging console after deployment.
7. Pino debug logs include the full outgoing payload (system block + messages
   + tool definitions) and the full Claude response on every call.
8. No `console.log` or `console.error` calls remain in any `src/` module.
9. PROJECT_PLAN.md rows for M2 flip to Implemented.

## Open questions

None. Wikipedia MCP package confirmed as `@shelm/wikipedia-mcp-server`
(`npx -y @shelm/wikipedia-mcp-server`, stdio). Tools: `findPage`, `getPage`,
`onThisDay`, `getImagesForPage`.
