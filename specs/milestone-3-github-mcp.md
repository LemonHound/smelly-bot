# Spec: Milestone 3 — GitHub read via MCP
<!-- status: DRAFT — pending review -->

## Goal

Connect the bot to the official GitHub MCP server so it can answer questions
about the target repo (`game-ai-hub`) using its markdown documentation and
live issue/PR data. A Firestore-backed cache with 24h TTL eliminates redundant
fetches for static docs; an LLM-callable refresh tool lets the bot proactively
pull fresh content when context warrants it.

This milestone also hardens the MCP client layer: dual transport support
(stdio + HTTP), allowlist-only tool exposure with default-deny, a validation
layer for all tool invocations, and a `@smelly-bot tools` debug command that
bypasses the LLM entirely.

Additionally, this milestone fixes a bug where the bot cannot distinguish users
by name — Slack user IDs in thread context are resolved to display names so the
LLM can address and understand who is who.

Depends on: M2 (MCP client scaffolding + Wikipedia) landed and deployed.

## Scope

### `mcp-servers.json` — extended format

M2 introduced `mcp-servers.json` as a flat JSON array loaded at startup. M3
extends the format with `type`, `url`, `headers`, and `allowedTools`. The
`type` field is required on every entry: `"stdio"` or `"http"`.

**Stdio entry shape:**
```json
{
  "name": "wikipedia",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "wikipedia-mcp@1.0.3"],
  "allowedTools": ["search", "readArticle"]
}
```

**HTTP entry shape:**
```json
{
  "name": "github",
  "type": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": { "Authorization": "Bearer $GITHUB_TOKEN" },
  "allowedTools": []
}
```

`allowedTools` starts empty for GitHub in this PR. The developer runs
`@smelly-bot tools` after deploy to inspect the live tool list, then populates
`allowedTools` and redeploys. No code change required to add tools — edit the
JSON file and redeploy.

**Version pinning:** `wikipedia-mcp` is pinned to `1.0.3` in `args`. The `-y`
flag is retained to suppress npx install prompts in non-interactive
environments (Cloud Run, CI). HTTP servers have no local package to pin.

**`allowedTools` — default deny (fail closed):** when `allowedTools` is absent
or empty, zero tools from that server reach the LLM. There is no all-pass
mode. A newly-added server contributes nothing until explicitly allowlisted.
To change the allowed tool set: edit the JSON and redeploy — no code change
needed.

### `src/mcp/client.js` — dual transport + local tools + allowlist refactor

`createMcpClient` is extended to handle both transport types, local tool
registration, and the new allowlist semantics. The return signature gains
`toolsByServer` alongside the existing `tools` and `callTool`.

**Signature:**
```js
export async function createMcpClient(servers, localTools = [])
```

`localTools` is an array of `{ name, description, input_schema, handler }`
objects. Each entry is registered identically to MCP server tools — merged
into the flat `tools` array passed to Claude, and into `toolIndex` under the
server name `"local"`. The LLM sees and chooses from all tools uniformly
without knowledge of whether a tool is local or remote.

**Transport selection (branch on `server.type`):**

- `"stdio"` — `StdioClientTransport` from
  `@modelcontextprotocol/sdk/client/stdio.js`. The subprocess inherits the
  full parent `process.env` merged with any overrides in `server.env`:
  `{ ...process.env, ...(server.env ?? {}) }`. Secrets are already present
  in `process.env`; no additional resolution is needed.

- `"http"` — `StreamableHTTPClientTransport` from
  `@modelcontextprotocol/sdk/client/streamableHttp.js`. Constructor:
  `new StreamableHTTPClientTransport(url, { requestInit: { headers } })`.
  Header values containing `$VARNAME` are resolved from `process.env` at
  startup using `resolveVars` (see below). The transport is constructed once
  and reused for all tool calls — no per-request spawning.

**`resolveVars` (HTTP headers only):**

Before constructing the HTTP transport, resolve header values by replacing any
`$VARNAME` substring with the corresponding `process.env` value. Substitution
is inline — values like `"Bearer $GITHUB_TOKEN"` are handled correctly. If a
referenced var is absent from `process.env`, throw at startup with a clear
error naming the missing var and the server entry. Substitution happens once
at startup; the resolved value is baked into the transport for the process
lifetime.

```js
function resolveVars(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      v.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
        const val = process.env[name];
        if (val === undefined) throw new Error(`Missing env var $${name} required by mcp-servers.json`);
        return val;
      }),
    ])
  );
}
```

**Allowlist filtering:**

After `client.listTools()`, filter to only names present in
`server.allowedTools`. If the field is absent or empty, zero tools pass
through. This filter runs before merging into `tools` and `toolIndex`.

**Startup WARN on zero tools:** if a server connects successfully but
contributes zero tools (empty allowlist or no name matches), log a
`WARNING`-severity pino entry with the server name and the raw tool names
returned by `listTools()`. This makes misconfiguration immediately visible in
GCP Cloud Logging without being a hard failure.

**`disabledTools` removal:** the `disabledTools` blocklist field and all
code-side handling are removed. M2's Wikipedia entry never used
`disabledTools` in `mcp-servers.json` — no config migration needed.

**Return shape:**
```js
return { tools, callTool, toolsByServer };
// toolsByServer: Map<serverName, string[]>
// keys: each server name + "local" for local tools, post-filter
// "local" key is present even if localTools is empty (value: [])
```

### Tool invocation security layer

All tool calls route through a pre-invocation validator in `callTool` before
any MCP server or local handler is reached. The validator checks whether the
invocation is permitted; if not, it returns an error `tool_result` and the LLM
sees a generic failure with no indication of why it was blocked.

**Validation rules:**
1. Tool name must exist in `toolIndex`. (Already enforced — throws if unknown.
   The throw is caught and converted to an error `tool_result` rather than
   propagating.)
2. For `get_file_contents` calls targeting `GITHUB_REPO`: the `path` argument
   must be in `KNOWN_DOC_PATHS`. Calls to other repos or with unknown paths
   pass through to the MCP server unmodified.
3. For `refresh_repo_doc`: the `path` argument must be in `KNOWN_DOC_PATHS`.

**Error result shape returned to LLM on validation failure:**
```js
[{ type: 'text', text: 'Tool call failed.' }]
```

No detail about the validation failure is surfaced to the LLM. The failure is
logged at `WARNING` severity with the tool name, args, and reason.

`KNOWN_DOC_PATHS` is imported from `src/github/tools.js` and used in
`callTool` routing. The validator does not know or care whether the tool is
local or remote.

### `@smelly-bot tools` — debug command (LLM bypass)

When the stripped mention text equals `"tools"` (case-insensitive), the bot
posts a static formatted response listing all registered tools grouped by
server. The LLM is never invoked. The progress indicator is never started. The
LLM invocation rate limiter (`tryConsume`) is not called.

**Intercept point:** `src/slack.js`, `app_mention` handler. Compute
`mentionText` before starting the progress indicator, then branch:

```
if mentionText.toLowerCase() === 'tools'
  → post tool list, return early
else
  → start progress indicator, fetch thread context, call reply(), post result
```

**Response format:**
```
*Registered MCP tools*

*wikipedia:* search, readArticle
*github:* (none — allowedTools is empty)
*local:* refresh_repo_doc

To add tools, update allowedTools in mcp-servers.json and redeploy.
```

Local tools always appear under `"local"`. If all servers have empty
allowlists and no local tools are registered, the response still posts.

`toolsByServer` is threaded from `src/index.js` into `buildSlackApp` as a new
named parameter: `buildSlackApp({ config, reply, toolsByServer })`.

### `config.js` — `GITHUB_TOKEN` and `GITHUB_REPO` required

Both vars currently use `|| null`. M3 adds both to `ALWAYS_REQUIRED` and
removes the `|| null` fallbacks. Startup throws if either is missing. Both
already exist in `.env.example` and GCP Secret Manager.

`GITHUB_REPO` is in `owner/repo` format (e.g. `"LemonHound/game-ai-project"`).
Wherever `owner` is needed separately, parse it as `config.GITHUB_REPO.split('/')[0]`.
The spec uses `owner` and `repo` as shorthand for these two parts throughout.

### User display name resolution (bug fix)

**Problem:** the LLM receives raw Slack user IDs (e.g. `U06VD727NTB`) in thread
context and mention metadata, making it unable to address users by name or
understand who is who in a conversation.

**Fix:** resolve user IDs to display names via `client.users.info({ user: userId })`
before building thread context and before passing the mentioning user to `reply`.

**Scope:**
- `fetchThreadContext` in `src/slack.js`: for each message in the thread,
  resolve `m.user` to a display name. Deduplicate lookups within a single
  handler invocation (one API call per unique user ID, not per message).
  Fall back to the raw user ID if the lookup fails.
- `mentionUserId` passed to `reply`: also resolve to display name and pass both
  `mentionUserId` and `mentionDisplayName` into `reply` so the LLM has both.
- Thread context format changes from `{ user: userId, text }` to
  `{ userId, displayName, text }`.

**LLM surface:** update `buildThreadContext` in `src/llm/index.js` (or
wherever the thread context string is assembled) to include both display name
and user ID, e.g. `[displayName (<@userId>)]: message text`.

### Firestore doc cache (`src/github/docCache.js`)

Caches fetched file contents from the target repo. Issues and PRs are always
live — only static doc files are cached.

**Cache key:** `{owner}__{repo}__{path}` where forward slashes within `path`
are also replaced with `__`. `owner` and `repo` are parsed from
`config.GITHUB_REPO.split('/')`. Example key for `README.md` on
`LemonHound/game-ai-project`: `LemonHound__game-ai-project__README.md`.

**Firestore document shape:**
```js
{ content: string, fetchedAt: Timestamp }
```

**Collection:** `docCache`.

**TTL check:** `Date.now() - fetchedAt.toMillis() < 24 * 60 * 60 * 1000`

**Read path:**
1. Check Firestore for the cache key.
2. Hit and within TTL → return `content`. Log DEBUG with cache key and
   `fetchedAt`.
3. Miss or stale → call GitHub MCP `get_file_contents`, upsert result with
   `fetchedAt: FieldValue.serverTimestamp()`, return `content`.

**Firestore unavailability:** fail open. Skip cache, call GitHub MCP directly,
do not attempt to store. Log WARNING with cache key and error.

**Write path:** upsert (always overwrites).

**Integration point:** `callTool` routing. When tool is `get_file_contents`
and the path argument targets a known doc path on `GITHUB_REPO`, the cache
layer intercepts before the MCP server is called. All other `get_file_contents`
calls (different repo, unknown path) pass through unmodified.

**`get_file_contents` argument shape:** the exact field names (`owner`, `repo`,
`path` vs. other shapes) are only knowable after inspecting the live
`listTools()` response. Confirm at implementation start and wire cache key
construction accordingly.

### `refresh_repo_doc` local tool

A bot-defined tool registered through `createMcpClient`'s `localTools`
parameter. The LLM calls it to force a fresh fetch of a cached doc, bypassing
the TTL.

**Schema:**
```json
{
  "name": "refresh_repo_doc",
  "description": "Force a fresh fetch of a repo documentation file, bypassing the local cache. Use when the user asks about recent changes or when the cached content may be stale.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "File path within the target repo, e.g. README.md"
      }
    },
    "required": ["path"]
  }
}
```

**Path validation:** enforced by the security layer in `callTool` before the
handler runs. Invalid paths return an error `tool_result` — the handler never
executes.

**Execution (handler):**
1. Call GitHub MCP `get_file_contents` directly (no cache check).
2. Upsert result to Firestore (updates `fetchedAt`).
3. Return fresh content as the tool result.

The handler is defined in `src/github/tools.js` and passed to
`createMcpClient` from `src/index.js`.

### Known doc paths

```js
// src/github/tools.js
export const KNOWN_DOC_PATHS = ['README.md', 'CONTRIBUTING.md', 'ADR.md'];
```

Defined as a named export in `src/github/tools.js`. Used by both the cache
intercept and the security validation layer. Extending requires a code change.

### Lazy fetch behavior

Docs are not fetched at startup. The first call to `get_file_contents` for a
cached path incurs fetch latency; subsequent calls within 24h are served from
Firestore. No prewarming, no background refresh.

### `system.md` — topics to cover

Do not prescribe specific prompt text here. Record the topics that `system.md`
must address for M3 to work correctly:

- When to reach for GitHub tools vs. answer from training knowledge
- When to call `refresh_repo_doc` vs. use cached `get_file_contents`
- That issues and PRs are always fetched live (no cache caveat to surface to user)
- How to frame repo-grounded answers (cite the doc, do not hallucinate structure)
- Routing for project-state questions: "what's the roadmap?", "how do I
  contribute?", "why was X chosen?", "what issues are open?"

### Module layout

```
src/
  mcp/
    client.js         # dual transport, local tool registration, allowlist,
                      # resolveVars, security validation layer, toolsByServer
  github/
    docCache.js       # Firestore-backed cache + fail-open + TTL logic
    tools.js          # KNOWN_DOC_PATHS + refresh_repo_doc schema + handler
  slack.js            # @smelly-bot tools intercept, user display name resolution,
                      # toolsByServer + mentionDisplayName threading
  llm/
    index.js          # buildThreadContext updated for { userId, displayName, text }
  index.js            # passes localTools + toolsByServer; passes mentionDisplayName
```

`src/github/` is a new directory. `docCache.js` accepts `callTool` as an
injected dependency (testable without live MCP servers).

`llm/index.js` receives the merged tool list (MCP tools + local tools) and the
unified `callTool` — external signature unchanged from M2.

## Non-goals

- Write operations: add comment, update issue/PR description (M4).
- Emoji confirmation UX (M4).
- Caching issue or PR data — always fetched live.
- Scanning Slack channel history to proactively surface related issues.
- Fetching files outside `GITHUB_REPO`.
- Dynamic cache TTL or configurable doc path list — deferred; revisit if doc
  set grows.
- Background cache refresh (no cron, no prewarming).
- Per-user auth for the `@smelly-bot tools` command.
- OAuth flow for GitHub MCP — static Bearer token via Secret Manager is
  sufficient. The SDK's `authProvider` option is not used.

## Test cases

Tests live in `test/`. Any new module with logic must have a corresponding test
file. Test cases below define the required coverage; implementation may add
more.

### `test/mcpClient.test.js`

- Allowlist: server advertising tools `[A, B, C]` with `allowedTools: ['A']`
  → only `A` in returned `tools` and `toolsByServer`
- Default deny: server with no `allowedTools` field → zero tools in returned
  `tools`; WARNING log emitted
- Zero match WARN: server with `allowedTools: ['X']` but server advertises only
  `[A, B]` → zero tools; WARNING log emitted
- Local tools: `localTools` entries appear in `tools` and under `toolsByServer.local`
- `resolveVars`: `"Bearer $GITHUB_TOKEN"` with `GITHUB_TOKEN=abc` → `"Bearer abc"`
- `resolveVars`: missing var throws with the var name in the message
- `resolveVars`: value without `$` passes through unchanged
- Server connect failure: server entry throws on connect → WARNING log,
  remaining servers still connected
- Security layer — unknown tool: `callTool('nonexistent', {})` → error result,
  no MCP call
- Security layer — invalid path: `callTool('get_file_contents', { path: 'secrets.txt', ... })`
  targeting `GITHUB_REPO` → error result, no MCP call, WARNING log
- Security layer — valid path: `callTool('get_file_contents', { path: 'README.md', ... })`
  → passes through to MCP server

### `test/docCache.test.js`

- Cache hit (within TTL): Firestore returns doc with recent `fetchedAt` →
  content returned, no MCP call, DEBUG log with cache key and `fetchedAt`
- Cache miss: Firestore returns nothing → MCP called, result upserted, content
  returned
- Cache stale (beyond TTL): `fetchedAt` older than 24h → treated as miss,
  MCP called, upserted
- Firestore read failure: Firestore throws → MCP called directly, WARNING log,
  no attempt to store; content still returned
- Firestore write failure after MCP success: upsert throws → WARNING log,
  content still returned to caller (fail open on write too)
- Non-doc path: `get_file_contents` for path not in `KNOWN_DOC_PATHS` →
  cache layer not invoked, call passes through

### `test/githubTools.test.js`

- `refresh_repo_doc` handler — valid path: calls MCP `get_file_contents`,
  upserts to Firestore, returns content
- `refresh_repo_doc` handler — invalid path: security layer blocks before
  handler runs (this is a `mcpClient.test.js` case above; tools.js test
  confirms handler is not called)
- `KNOWN_DOC_PATHS` is a frozen array containing the three expected paths

### `test/slack.test.js` (additions to existing file)

- `@smelly-bot tools` intercept: mention text `"tools"` → `reply` not called,
  `tryConsume` not called, progress indicator not started, static message
  posted with tool names grouped by server
- `@smelly-bot tools` case-insensitive: `"TOOLS"` → same behavior
- `@smelly-bot tools` not triggered: `"tools please"` → normal LLM path
- Display name resolution: thread with two messages from user `U123` →
  `users.info` called once (deduplicated), display name used in context string
- Display name fallback: `users.info` throws for user `U999` → raw ID used,
  no crash

### `test/llm.test.js` (additions to existing file)

- `buildThreadContext`: given `[{ userId, displayName, text }]` → output string
  contains both display name and `<@userId>` format

## Acceptance criteria

1. `@smelly-bot what does the README say about [topic]?` → bot calls
   `get_file_contents("README.md")`, retrieves from Firestore cache (or fetches
   and caches on first call), answers grounded in the actual file. Verify via
   debug logs: `tool_use` block in Claude response, `tool_result` contains file
   content.

2. Same question within 24h → debug logs show no outbound GitHub MCP call;
   Firestore cache served. Cache hit DEBUG log must appear with cache key and
   `fetchedAt`.

3. `@smelly-bot are there any open issues?` → bot calls `list_issues` or
   equivalent, returns real issue data grounded in actual open issues.

4. `@smelly-bot what PRs are open?` → bot calls `list_pull_requests` or
   equivalent, returns real PR data.

5. `@smelly-bot check if the docs are current` → bot calls `refresh_repo_doc`,
   Firestore is updated, debug logs confirm a fresh GitHub MCP fetch occurred.

6. Only tool names in `allowedTools` appear in the `tools` array passed to
   Claude. Confirm by inspecting the debug-logged outgoing LLM payload.

7. GitHub MCP server unreachable at startup → WARNING pino log, bot continues
   as plain Claude + Wikipedia bot. No crash, no unhandled rejection.

8. `GITHUB_TOKEN` or `GITHUB_REPO` missing from environment → startup throws
   with a clear error naming the missing var(s). Same behavior if
   `mcp-servers.json` references an HTTP header var that is absent from
   `process.env`.

9. `@smelly-bot tools` → static tool list posted, grouped by server including
   `local`. No LLM call, no progress indicator, no `tryConsume` call. Verify
   via pino logs: no `makeLlmReply` invocation appears.

10. Server connects but all tools filtered out → WARNING log with server name
    and raw `listTools()` names.

11. Security layer rejects `get_file_contents` with a path not in
    `KNOWN_DOC_PATHS` → error `tool_result` returned to LLM, no MCP call,
    WARNING log. LLM receives no information about why it was blocked.

12. Thread containing multiple users by `<@ID>` → LLM response addresses users
    by display name, not raw ID. Verify by posting a thread with two users and
    asking the bot who said what.

13. `refresh_repo_doc` local tool appears in `@smelly-bot tools` output under
    `local`.

14. `PROJECT_PLAN.md` rows for M3 flip to Implemented in the same PR.

## Open questions

- **GitHub hosted MCP server URL:** assumed `https://api.githubcopilot.com/mcp/`
  based on GitHub's MCP announcements. Confirm the exact URL and required auth
  header format at implementation start by checking GitHub's official MCP
  documentation.

- **`get_file_contents` argument shape:** exact field names only knowable after
  inspecting the live `listTools()` response. Confirm at implementation time
  and wire cache key construction and security validation accordingly.
