# Spec: Milestone 3 — GitHub read via MCP
<!-- status: DRAFT — pending review -->

## Goal

Connect the bot to the official GitHub MCP server so it can answer questions
about the target repo (`game-ai-hub`) using its markdown documentation and
live issue/PR data. A Firestore-backed cache with 24h TTL eliminates redundant
fetches for static docs; an LLM-callable refresh tool lets the bot proactively
pull fresh content when context warrants it.

This milestone also hardens the MCP client layer: dual transport support
(stdio + HTTP), allowlist-only tool exposure with default-deny, `$VAR`
substitution for HTTP headers, and a `@smelly-bot tools` debug command that
bypasses the LLM entirely.

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
  "args": ["wikipedia-mcp@1.0.3"],
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

**Version pinning:** `wikipedia-mcp` is currently invoked via `npx -y wikipedia-mcp`
(unpinned). M3 pins it to `1.0.3` in `args`. HTTP servers have no local
package to pin.

**`allowedTools` — default deny (fail closed):** when `allowedTools` is absent
or empty, zero tools from that server reach the LLM. This is intentional: a
misconfigured or newly-added server contributes nothing until explicitly
allowlisted. There is no "all tools pass through" mode.

### `src/mcp/client.js` — dual transport + allowlist refactor

`createMcpClient` is extended to handle both transport types and the new
allowlist semantics. The return signature gains `toolsByServer` alongside the
existing `tools` and `callTool`.

**Transport selection (branch on `server.type`):**

- `"stdio"` — `StdioClientTransport`. Subprocess inherits the full parent
  `process.env` plus any overrides in `server.env` (merged, not replaced):
  `{ ...process.env, ...(server.env ?? {}) }`. No `$VAR` substitution —
  secrets are already in `process.env`.

- `"http"` — `StreamableHttpClientTransport`. Constructed once at startup with
  resolved headers (see `$VAR` substitution below). Reused for every tool call
  — no per-request spawning.

**`$VAR` substitution (HTTP headers only):**

Before constructing the HTTP transport, resolve header values. Any value
matching `$VARNAME` is replaced with `process.env.VARNAME`. If the referenced
var is absent, throw at startup with a clear error naming the missing var and
the server entry. Substitution happens once at startup — the resolved value is
baked into the transport object for the process lifetime.

```js
function resolveVars(obj) {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      typeof v === 'string' && v.startsWith('$')
        ? requireEnvVar(v.slice(1))
        : v,
    ])
  );
}
```

**Allowlist filtering:**

After `client.listTools()`, filter the response to only names present in
`server.allowedTools`. If the field is absent or empty, zero tools pass
through. The filter runs before merging into the flat `tools` array and before
populating `toolIndex`.

**Startup WARN on zero tools:** if a server connects successfully but
contributes zero tools (either because `allowedTools` is empty/absent or
because none of the listed names match what the server advertises), log a
`WARNING`-severity pino entry including the server name and the raw tool names
returned by `listTools()`. Makes misconfiguration immediately visible in GCP
Cloud Logging without being a hard failure.

**`disabledTools` removal:** the existing `disabledTools` blocklist field is
removed. Any entry that used it must be migrated to `allowedTools`. M2's
Wikipedia entry did not use `disabledTools` in `mcp-servers.json` (it existed
only in the client code) — the code-side handling is removed with no config
migration needed.

**Return shape (extended):**

```js
return { tools, callTool, toolsByServer };
// toolsByServer: Map<serverName, string[]> — tool names per server, post-filter
```

`toolsByServer` is used by the `@smelly-bot tools` handler. `tools` and
`callTool` are unchanged — `llm/index.js` signature does not change.

### `@smelly-bot tools` — debug command (LLM bypass)

When the stripped mention text equals the exact string `"tools"` (case
insensitive), the bot posts a static formatted response listing all registered
tools grouped by server. The LLM is never invoked. The progress indicator is
never started. Rate limiting is not applied.

**Intercept point:** `src/slack.js`, in the `app_mention` handler. Compute
`mentionText` before starting the progress indicator, then branch:

```
mentionText === "tools" (case insensitive)
  → post tool list, return
mentionText !== "tools"
  → start progress indicator, fetch thread context, call reply(), post result
```

**Response format:**

```
*Registered MCP tools*

*wikipedia:* search, readArticle
*github:* (none — allowedTools is empty)

To add tools, update allowedTools in mcp-servers.json and redeploy.
```

If no servers are registered or all have empty allowlists, the response still
posts rather than silently dropping.

`toolsByServer` is threaded from `src/index.js` into `buildSlackApp` as a new
dependency (alongside `reply`).

### `config.js` — GITHUB_TOKEN and GITHUB_REPO required

Both vars exist in `config.js` as optional (`|| null`). M3 makes them required:
add both to `ALWAYS_REQUIRED` and remove the `|| null` fallbacks. Startup
throws if either is missing. Both already exist in `.env.example` and GCP
Secret Manager.

### Firestore doc cache (`src/github/docCache.js`)

Caches fetched file contents from the target repo. Issues and PRs are always
live — only static doc files are cached.

**Cache key:** `{owner}__{repo}__{path}` — forward slashes in path replaced
with `__`. Each document cached independently. Owner + repo in key prevents
collisions if a second target repo is added later.

**Firestore document shape:**
```js
{ content: string, fetchedAt: Timestamp }
```

**Collection:** `docCache`.

**Read path:**
1. Check Firestore for the cache key.
2. Hit and `fetchedAt` within 24h → return `content`. Log DEBUG with key and
   `fetchedAt`.
3. Miss or stale → call GitHub MCP `get_file_contents`, upsert result, return
   `content`.

**Firestore unavailability:** fail open. Skip cache, call GitHub MCP directly,
do not attempt to store. Log WARNING with key and error.

**Write path:** upsert (always overwrites).

**Integration point:** `callTool` routing. When tool is `get_file_contents`
targeting a known doc path on `GITHUB_REPO`, the cache layer intercepts before
the call reaches the MCP server. All other `get_file_contents` calls pass
through unmodified.

**Known doc paths:**
```
README.md
CONTRIBUTING.md
ADR.md
```

Defined as a constant in `src/github/tools.js`. Extending requires a code
change.

**`get_file_contents` argument shape:** the exact field names (`owner`, `repo`,
`path` vs. other formats) are only knowable after inspecting the live
`listTools()` response. Confirm at implementation time before wiring the cache
intercept and key construction.

### `refresh_repo_doc` local tool

A bot-defined tool (not from any MCP server) that the LLM can call to force a
fresh fetch of a cached doc, bypassing the TTL.

**Schema:**
```json
{
  "name": "refresh_repo_doc",
  "description": "Force a fresh fetch of a repo documentation file, bypassing the local cache. Use when the user asks about recent changes or when the cached content may be stale.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "File path within the target repo, e.g. README.md" }
    },
    "required": ["path"]
  }
}
```

**Path validation:** only accepts paths in the known doc list. Any other path
returns an error `tool_result` without calling GitHub MCP.

**Execution:** calls GitHub MCP `get_file_contents` directly (no cache check),
upserts to Firestore, returns fresh content as the tool result.

**Registration:** local tools are merged into the same flat `tools` array as
MCP tools. `callTool` checks tool name first — local handler runs if matched,
otherwise routes to MCP server.

### Lazy fetch behavior

Docs are not fetched at startup. First call to `get_file_contents` for a
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
    client.js       # dual transport, allowlist filter, toolsByServer, $VAR resolution
  github/
    docCache.js     # Firestore-backed cache + fail-open logic
    tools.js        # known doc paths constant + refresh_repo_doc schema + local handler
  slack.js          # @smelly-bot tools intercept + toolsByServer threading
  index.js          # threads toolsByServer from createMcpClient into buildSlackApp
```

`src/github/` is a new directory. `docCache.js` accepts `callTool` as an
injected dependency (keeps it testable without live MCP servers).

`llm/index.js` receives the merged tool list (MCP tools + local tools) and the
unified `callTool` — signature unchanged from M2.

## Non-goals

- Write operations: add comment, update issue/PR description (M4).
- Emoji confirmation UX (M4).
- Caching issue or PR data — always fetched live.
- Scanning Slack channel history to proactively surface related issues.
- Fetching files outside `GITHUB_REPO`.
- Dynamic cache TTL or configurable doc path list — deferred; revisit if doc
  set grows. Noted in ADR as a deferred decision.
- Background cache refresh (no cron, no prewarming).
- Per-user auth for the `@smelly-bot tools` command — it's a debug tool, not
  gated.

## Acceptance criteria

1. `@smelly-bot what does the README say about [topic]?` → bot calls
   `get_file_contents("README.md")`, retrieves from Firestore cache (or fetches
   and caches on first call), answers grounded in the actual file. Verify via
   debug logs: `tool_use` block in Claude response, `tool_result` contains file
   content.

2. Same question within 24h → debug logs show no outbound GitHub MCP call;
   Firestore cache served. (Cache hit DEBUG log must appear.)

3. `@smelly-bot are there any open issues?` → bot calls `list_issues`, returns
   real issue data. Response grounded in actual open issues.

4. `@smelly-bot what PRs are open?` → bot calls `list_pull_requests` or
   equivalent, returns real PR data.

5. `@smelly-bot check if the docs are current` → bot calls `refresh_repo_doc`,
   Firestore is updated, debug logs confirm a fresh GitHub MCP fetch occurred.

6. No write tools appear in the tool list passed to Claude. Confirm by
   inspecting the debug-logged outgoing payload — only allowlisted tool names
   present in the `tools` array.

7. If the GitHub MCP server is unreachable at startup, the bot logs a
   WARNING-severity pino entry and continues as a plain Claude + Wikipedia bot.
   No crash, no unhandled rejection.

8. `GITHUB_TOKEN` and `GITHUB_REPO` missing → startup throws with a clear
   error message naming the missing vars.

9. `@smelly-bot tools` → static tool list posted, no LLM call, no progress
   indicator, no rate limit applied. Tool names grouped by server.

10. Server connects but all tools filtered by allowlist → WARNING log with
    server name and raw tool list from `listTools()`.

11. `PROJECT_PLAN.md` rows for M3 flip to Implemented in the same PR.

## Open questions

- **GitHub hosted MCP server URL:** assumed `https://api.githubcopilot.com/mcp/`
  based on GitHub's MCP announcements. Confirm the exact URL and required auth
  header format (Bearer token vs. other scheme) at implementation start by
  checking GitHub's official MCP documentation.

- **`get_file_contents` argument shape:** exact field names only knowable after
  inspecting the live `listTools()` response. Confirm at implementation time
  and wire cache key construction accordingly.

- **`StreamableHttpClientTransport` availability in `@modelcontextprotocol/sdk@^1.29.0`:**
  confirm the exact import path and constructor signature before implementing
  the HTTP transport branch.
