import { composeFallback } from '../fallbacks.js';
import { logger } from '../logger.js';

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

function todayString() {
  return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function buildUserMessage({ channelName, mentionUserId, botUserId, mentionText, threadMessages }) {
  const parts = [
    `Date: ${todayString()} | Channel: #${channelName} | Mentioned by: <@${mentionUserId}> | You are: <@${botUserId}>`,
  ];
  if (threadMessages && threadMessages.length > 0) {
    parts.push('Thread context:');
    for (const m of threadMessages) {
      parts.push(`<@${m.user}>: ${m.text}`);
    }
    parts.push('---');
  }
  parts.push(mentionText);
  return parts.join('\n');
}

function buildSystemBlock({ systemMd, topicsMd }) {
  return [
    { type: 'text', text: systemMd },
    { type: 'text', text: topicsMd, cache_control: { type: 'ephemeral' } },
  ];
}

export function makeLlmReply({ config, prompts, rateLimit, anthropicClient, tools = [], callTool = null }) {
  return async (ctx) => {
    let rateLimitOk = true;
    try {
      const deadline = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), RATE_LIMIT_TIMEOUT_MS)
      );
      const { ok } = await Promise.race([rateLimit.tryConsume(), deadline]);
      rateLimitOk = ok;
    } catch (err) {
      logger.error({ err: err.message }, 'Rate limiter unavailable, failing open');
    }
    if (!rateLimitOk) {
      return composeFallback();
    }

    const userMessage = buildUserMessage(ctx);
    const systemBlock = buildSystemBlock(prompts);

    const messages = [{ role: 'user', content: userMessage }];
    const payload = {
      model: config.CLAUDE_MODEL,
      max_tokens: config.MAX_OUTPUT_TOKENS,
      system: systemBlock,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    };

    logger.debug({ payload }, 'LLM request');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      let iterations = 0;
      const maxIterations = config.LLM_MAX_TOOL_ITERATIONS ?? 5;

      while (iterations < maxIterations) {
        iterations++;

        const response = await anthropicClient.messages.create(
          { ...payload, messages: [...payload.messages] },
          { signal: controller.signal }
        );

        logger.debug({ response }, 'LLM response');

        if (response.stop_reason === 'end_turn') {
          const textBlock = response.content.find(b => b.type === 'text');
          return textBlock ? textBlock.text : composeFallback();
        }

        if (response.stop_reason === 'tool_use') {
          payload.messages = [...payload.messages, { role: 'assistant', content: response.content }];

          const toolResultBlocks = await Promise.all(
            response.content
              .filter(b => b.type === 'tool_use')
              .map(async (block) => {
                try {
                  const content = await callTool(block.name, block.input);
                  return { type: 'tool_result', tool_use_id: block.id, content };
                } catch (err) {
                  logger.warn({ err: err.message, tool: block.name }, 'Tool call failed');
                  return {
                    type: 'tool_result',
                    tool_use_id: block.id,
                    is_error: true,
                    content: [{ type: 'text', text: err.message }],
                  };
                }
              })
          );

          payload.messages = [...payload.messages, { role: 'user', content: toolResultBlocks }];
          continue;
        }

        const textBlock = response.content.find(b => b.type === 'text');
        return textBlock ? textBlock.text : composeFallback();
      }

      logger.warn({ iterations }, 'Max tool iterations reached, returning fallback');
      return composeFallback();
    } catch (err) {
      logger.error({ err: err.message }, 'LLM call failed');
      return composeFallback();
    } finally {
      clearTimeout(timer);
    }
  };
}
