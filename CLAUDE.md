# Stack

Derived from `package.json`. Key dependencies: `@slack/bolt`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `@google-cloud/firestore`, `pino`. Runtime: Node.js 20+, ESM. Test runner: `node --test`.

# Architecture

See `ADR.md` for all system-wide decisions — MCP client design, LLM integration, Slack transport modes, hosting, rate limiting, and persistence.

# Security

A `security-reviewer` pass is required after any change that introduces external integrations, new environment variables or secrets, new MCP servers, or new untrusted input paths.
