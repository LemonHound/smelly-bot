import { composeFallback } from '../fallbacks.js';

const TIMEOUT_MS = 15_000;
const RATE_LIMIT_TIMEOUT_MS = 3_000;

export function buildThreadContext(messages, maxChars) {
  if (messages.length === 0) return [];

  const charCount = (m) => `${m.user}: ${m.text}`.length;

  const root = messages[0];
  const rootChars = charCount(root);

  if (rootChars > maxChars) {
    const suffix = '... [truncated]';
    const prefixLen = maxChars - suffix.length - `${root.user}: `.length;
    const truncatedText = prefixLen > 0
      ? root.text.slice(0, prefixLen) + suffix
      : suffix;
    return [{ user: root.user, text: truncatedText }];
  }

  const included = [];
  let running = rootChars;

  const replies = messages.slice(1);
  for (let i = replies.length - 1; i >= 0; i--) {
    const chars = charCount(replies[i]);
    if (running + chars > maxChars) break;
    running += chars;
    included.unshift(replies[i]);
  }

  return [root, ...included];
}

function buildUserMessage({ channelName, mentionUser, mentionText, threadMessages }) {
  const parts = [`Channel: #${channelName} | Mentioned by: ${mentionUser}`];
  if (threadMessages && threadMessages.length > 0) {
    parts.push('Thread context:');
    for (const m of threadMessages) {
      parts.push(`${m.user}: ${m.text}`);
    }
    parts.push('---');
  }
  parts.push(mentionText);
  return parts.join('\n');
}

export function makeLlmReply({ config, prompts, rateLimit, anthropicClient }) {
  return async (ctx) => {
    let rateLimitOk = true;
    try {
      const deadline = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), RATE_LIMIT_TIMEOUT_MS)
      );
      const { ok } = await Promise.race([rateLimit.tryConsume(), deadline]);
      rateLimitOk = ok;
    } catch (err) {
      console.error('Rate limiter unavailable, failing open:', err.message);
    }
    if (!rateLimitOk) {
      return composeFallback();
    }

    const userMessage = buildUserMessage(ctx);

    if (config.LOG_LLM_PAYLOADS) {
      console.log('[LLM payload]', JSON.stringify({
        system: prompts,
        messages: [{ role: 'user', content: userMessage }],
      }, null, 2));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await anthropicClient.messages.create(
        {
          model: config.CLAUDE_MODEL,
          max_tokens: config.MAX_OUTPUT_TOKENS,
          system: prompts,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: controller.signal }
      );

      if (config.LOG_LLM_PAYLOADS) {
        console.log('[LLM response]', JSON.stringify(response, null, 2));
      }

      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock ? textBlock.text : composeFallback();
    } catch (err) {
      console.error('LLM call failed:', err.message);
      return composeFallback();
    } finally {
      clearTimeout(timer);
    }
  };
}
