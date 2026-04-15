const ALWAYS_REQUIRED = ['SLACK_BOT_TOKEN', 'GOOGLE_CLOUD_PROJECT'];

export function loadConfig() {
  const missing = ALWAYS_REQUIRED.filter(k => !process.env[k]);

  const isSocketMode = Boolean(process.env.SLACK_APP_TOKEN);
  if (!isSocketMode && !process.env.SLACK_SIGNING_SECRET) {
    missing.push('SLACK_SIGNING_SECRET');
  }

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return Object.freeze({
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN || null,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET || null,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
    FIRESTORE_DATABASE_ID: process.env.FIRESTORE_DATABASE_ID,
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || null,
    PORT: Number(process.env.PORT) || 3000,
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    RATE_LIMIT_PER_HOUR: Number(process.env.RATE_LIMIT_PER_HOUR) || 30,
    RATE_LIMIT_PER_DAY: Number(process.env.RATE_LIMIT_PER_DAY) || 200,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
    LOG_LLM_PAYLOADS: process.env.LOG_LLM_PAYLOADS === 'true',
    THREAD_CONTEXT_MAX_CHARS: Number(process.env.THREAD_CONTEXT_MAX_CHARS) || 6000,
    CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
    MAX_OUTPUT_TOKENS: Number(process.env.MAX_OUTPUT_TOKENS) || 400,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,
    GITHUB_REPO: process.env.GITHUB_REPO || null,
  });
}
