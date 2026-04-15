# Spec: Milestone 3 — GitHub read via MCP
<!-- status: DRAFT — pending review -->

## Goal

Connect the bot to the official GitHub MCP server so it can answer questions
about the target repo (`game-ai-hub`) using its markdown documentation and
live issue/PR data. A Firestore-backed cache with 24h TTL eliminates redundant
fetches for static docs; an LLM-callable refresh tool lets the bot proactively
pull fresh content when context warrants it.

This milestone is primarily about wiring GitHub into the existing MCP client
stack and giving the bot grounded, repo-aware Q&A capability. Write operations
and confirmation UX are deferred to M4.

Depends on: M2 (MCP client scaffolding + Wikipedia) landed and deployed.

## Scope

### `mcp-servers.json` — GitHub server entry + M3 extensions

M2 introduced `mcp-servers.json` as a flat JSON array in the project root,
loaded at startup by `src/index.js`. Each entry has `name`, `command`, and
`args`. M3 adds the GitHub entry and extends the format with two new optional
fields: `env` and `allowedTools`. Both are implemented in M3 — they do not
exist in M2.

M3 adds the following entry to `mcp-servers.json`:

```json
[
  {
    "name": "wikipedia",
    "command": "npx",
    "args": ["@shelm/wikipedia-mcp-server@<pinned-version>"]
  },
  {
    "name": "github",
    "command": "npx",
    "args": ["@modelcontextprotocol/server-github@<pinned-version>"],
    "env": { "GITHUB_TOKEN": "$GITHUB_TOKEN" },
    "allowedTools": []
  }
]
```

**Version pinning:** all entries must specify a pinned version. M2 shipped
Wikipedia unpinned — pin it in the M3 PR alongside the GitHub entry.

**Env var substitution (new in M3):** `src/index.js` (or `src/mcp/client.js`)
must resolve `$VAR` values in `env` objects from `process.env` before passing
them to `createMcpClient`. The JSON file never contains actual secret values.
If a referenced env var is missing, throw at startup.

**`allowedTools` filtering (new in M3):** `createMcpClient` in `src/mcp/client.js`
must be extended to filter each server's `listTools()` response to only the
names in `allowedTools` before merging into the flat tool array. When the field
is absent, all tools pass through (preserving M2 behavior for Wikipedia).
Exact GitHub tool names confirmed at implementation time by inspecting the live
`listTools()` response. Intent: read-only tools only — write tools must not
reach Claude before M4's confirmation UX is in place. To update the list:
edit `mcp-servers.json`, redeploy — no code change required.

`GITHUB_TOKEN` and `GITHUB_REPO` already exist in `config.js` and `.env.example`
as of M2 (added as optional, `|| null`). M3 must make both required: add them
to the required validation in `config.js` and remove the `|| null` fallbacks so
startup fails fast if either is missing.

`GITHUB_REPO` is read from config and used as the default repository context
in tool calls where a repo argument is required.

### Firestore doc cache (`src/github/docCache.js`)

Caches fetched file contents from the target repo. Issues and PRs are always
live — only static doc files are cached.

**Cache key:** `{owner}__{repo}__{path}` — e.g. `user__game-ai-hub__README.md`.
Forward slashes cannot appear in Firestore document IDs (they are interpreted
as path separators). The `__` separator is used between the owner, repo, and
file path segments; any `/` within the path itself is also replaced with `__`.
Each document is cached independently. Including owner and repo avoids
collisions if a second target repo is added in a future milestone.

**Firestore document shape:**
```js
{
  content: string,      // raw file content returned by GitHub MCP
  fetchedAt: Timestamp, // Firestore server timestamp
}
```

**Collection:** `docCache` (single collection, document ID is the cache key).

**Read path:**
1. Check Firestore for a document matching the cache key.
2. If document exists and `fetchedAt` is within 24h → return `content`.
3. Otherwise → call GitHub MCP `get_file_contents`, store result with current
   timestamp, return `content`.

**Cache hit logging:** on a cache hit, log a `DEBUG`-severity pino entry
including the cache key and `fetchedAt` timestamp. This is required for
acceptance criterion verification — the only observable evidence that the
cache was served rather than a GitHub MCP call.

**Firestore unavailability:** if the Firestore read fails for any reason, the
cache fails open — skip the cache, call GitHub MCP directly, and return the
result without attempting to store it. Log a `WARNING`-severity pino entry
including the cache key and the error, so that ignored cache state is visible
in GCP Cloud Logging for troubleshooting.

**Write path:** always overwrites the document (upsert).

**Integration point:** the cache is invoked inside `callTool` routing. When the
tool is `get_file_contents` and it targets a known doc path on the configured
`GITHUB_REPO`, the cache layer intercepts the call before it reaches the MCP
server. All other `get_file_contents` calls (different repo, different path)
pass through to the MCP server unmodified.

Known doc paths that route through cache:
```
README.md
CONTRIBUTING.md
ADR.md
```

This list is defined as a constant alongside the whitelist. Extending it
requires a code change.

### `refresh_repo_doc` local tool

A bot-defined tool (not from any MCP server) that the LLM can call to force a
fresh fetch of a cached doc, bypassing the TTL check.

**Schema (passed to Claude alongside MCP tools):**
```json
{
  "name": "refresh_repo_doc",
  "description": "Force a fresh fetch of a repo documentation file, bypassing the local cache. Use this when the user asks about recent changes or when the cached content may be stale.",
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

**Path validation:** `refresh_repo_doc` only accepts paths in the known doc
list (`README.md`, `CONTRIBUTING.md`, `ADR.md`). If the LLM passes any other
path, the handler returns an error `tool_result` without calling GitHub MCP.
This keeps the tool's blast radius bounded to the three known documents.

**Execution:** when `callTool` routes a `refresh_repo_doc` call with a valid
path, it:
1. Calls GitHub MCP `get_file_contents` directly (no cache check).
2. Writes the result to Firestore (upsert, updating `fetchedAt`).
3. Returns the fresh content to Claude as the tool result.

Local tools are registered in the same flat tool array as MCP tools. `callTool`
routing checks tool name first — if it matches a local handler, it runs
locally; otherwise it routes to the named MCP server as before.

### Lazy fetch behavior

Docs are not fetched at startup. The first LLM call that triggers
`get_file_contents` for a cached path will incur the fetch latency (typically
1-2s for small markdown files). Subsequent calls within 24h are served from
Firestore. This is acceptable given the file sizes and cache hit rate.

No prewarming, no background refresh job.

### system.md — notes for implementation

`system.md` will be in a different state by the time M3 implementation begins.
Do not prescribe specific prompt text here. Instead, record the _topics_ that
system.md must cover for M3 to work correctly:

- When the bot should reach for GitHub tools vs. answer from training knowledge
- When to call `refresh_repo_doc` vs. use the cached `get_file_contents` result
- How to handle issue and PR questions (these are always live — no cache caveat
  to communicate to the user)
- How to frame repo-grounded answers (cite the doc, don't hallucinate structure)
- Appropriate routing for project-state questions ("what's the roadmap?",
  "how do I contribute?", "why was X chosen?", "what issues are open?")

### Module layout

```
src/
  mcp/
    client.js        # extended: local tool registry + whitelist filter
  github/
    docCache.js      # Firestore-backed doc cache + refresh logic
    tools.js         # known doc paths constant + refresh_repo_doc schema
```

`src/github/` is a new directory. `docCache.js` imports `firestore.js` and
accepts `callTool` as an injected dependency (keeps it testable without live
MCP servers).

`llm/index.js` receives the merged tool list (MCP tools + local tools) and the
unified `callTool` function — its signature does not change from M2.

## Non-goals

- Write operations: add comment, update issue/PR description (M4).
- Emoji confirmation UX (M4).
- Caching issue or PR data — issues/PRs are always fetched live.
- Scanning Slack channel history to proactively surface related issues.
- Fetching files outside `GITHUB_REPO`.
- Dynamic cache TTL configuration (24h is hardcoded). Making the cached doc
  path list and TTL configurable is deferred; revisit if the doc set grows
  significantly. Noted in ADR as a deferred decision.
- Background cache refresh (no cron, no prewarming).

## Acceptance criteria

1. `@smelly-bot what does the README say about [topic]?` → bot calls
   `get_file_contents("README.md")`, retrieves content from Firestore cache (or
   fetches and caches on first call), and answers grounded in the actual file.
   Verify via debug logs: tool_use block appears in Claude response, tool_result
   contains file content.

2. Same question asked a second time within 24h → debug logs show no outbound
   GitHub MCP call; Firestore cache is served directly.

3. `@smelly-bot are there any open issues?` → bot calls `list_issues`, returns
   real issue data from the GitHub MCP server. Response is grounded in actual
   open issues.

4. `@smelly-bot what PRs are open?` → bot calls `list_pull_requests` or
   `get_pull_request`, returns real PR data. Response is grounded in actual
   open PRs.

5. `@smelly-bot check if the docs are current` (or equivalent phrasing that
   implies staleness concern) → bot calls `refresh_repo_doc`, Firestore is
   updated, debug logs confirm a fresh GitHub MCP fetch occurred.

6. No write tools appear in the tool list passed to Claude. Confirm by
   inspecting the debug-logged outgoing payload — only whitelisted tool names
   are present in the `tools` array.

7. If the GitHub MCP server fails to start, the bot logs a WARNING-severity
   pino entry and continues functioning as a plain Claude + Wikipedia bot.
   No crash, no unhandled rejection.

8. `GITHUB_TOKEN` and `GITHUB_REPO` are required by `config.js` — startup
   throws if either is missing. (Both already exist in `.env.example` from M2.)

9. PROJECT_PLAN.md rows for M3 flip to Implemented in the same PR.

## Open questions

- **`get_file_contents` argument shape** — The cache intercept fires when a
  `get_file_contents` call targets a known doc path on `GITHUB_REPO`. The
  exact argument structure (separate `owner`, `repo`, `path` fields vs. other
  formats) is only knowable after inspecting the live `listTools()` response
  from the GitHub MCP server. Confirm at implementation time and wire the
  cache key construction accordingly.
