# Contributing

Small, agile project. Keep changes minimal and obvious.

## Dev loop

1. Fork/branch from `main`.
2. `npm install` once.
3. Copy `.env.example` to `.env` and fill in Slack tokens (see README).
4. `npm run dev` - Node's `--watch` restarts on save.
5. Test by `@smelly-bot`-mentioning the bot in its channel.

## Project layout

```
src/
  index.js        # bot entry; Bolt app, event handlers
ADR.md            # architecture decisions (single doc, amend in place)
README.md         # setup + hosting notes
.env.example      # canonical list of env vars
```

Add new features as focused modules under `src/` and wire them into `src/index.js`. Avoid premature framework layering; this project stays small on purpose.

## Adding a new bot behavior

1. Decide the trigger (Slack event type, slash command, etc.).
2. Register a handler in `src/index.js` (or a small module imported by it).
3. Keep handlers short; push any non-trivial logic into a dedicated module.
4. If the feature needs a new env var, add it to `.env.example` with a placeholder value and update the README if setup steps change.

## Updating the bot

- Code changes: PR into `main`. Rules may be added later; for now direct commits to `main` are allowed while bootstrapping.
- Dependency bumps: `npm install <pkg>@latest`, commit the `package.json` + `package-lock.json` together.
- Behavior changes worth remembering: add a section to `ADR.md`.

## Style

- No inline comments unless logic is genuinely non-obvious.
- No emojis or em-dashes in code or docs (except Slack response strings, which are the point).
- Prefer deleting code over commenting it out.

## Testing

No test suite yet. For now, exercise changes in Socket Mode locally against the real Slack workspace before merging. Once the bot grows real logic (LLM calls, GitHub actions), add unit tests for the pure pieces.
