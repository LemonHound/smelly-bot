import { composeFallback } from '../fallbacks.js';
import { logger } from '../logger.js';

const TIMEOUT_MS = 45_000;
const RATE_LIMIT_TIMEOUT_MS = 3_000;

export function buildThreadContext(messages, maxChars) {
  if (messages.length === 0) return [];

  const label = (m) => m.displayName ? `${m.displayName} (<@${m.userId}>)` : (m.user ?? m.userId ?? 'unknown');
  const charCount = (m) => `${label(m)}: ${m.text}`.length;

  const root = messages[0];
  const rootChars = charCount(root);

  if (rootChars > maxChars) {
    const suffix = '... [truncated]';
    const prefixLen = maxChars - suffix.length - `${label(root)}: `.length;
    const truncatedText = prefixLen > 0
      ? root.text.slice(0, prefixLen) + suffix
      : suffix;
    return [{ ...root, text: truncatedText }];
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

function buildUserMessage({ channelName, mentionUserId, mentionDisplayName, botUserId, mentionText, threadMessages, channelMessages, otherThreads, githubRepo, isWildcard }) {
  const mentionLabel = mentionDisplayName
    ? `${mentionDisplayName} (<@${mentionUserId}>)`
    : `<@${mentionUserId}>`;
  const meta = [`Date: ${todayString()}`, `Channel: #${channelName}`, `Mentioned by: ${mentionLabel}`, `You are: <@${botUserId}>`];
  if (githubRepo) meta.push(`Target repo: ${githubRepo}`);
  const parts = [meta.join(' | ')];

  if (channelMessages && channelMessages.length > 0) {
    parts.push('Recent channel messages:');
    for (const m of channelMessages) {
      const label = m.displayName ? `${m.displayName} (<@${m.userId}>)` : (m.user ? `<@${m.user}>` : `<@${m.userId}>`);
      parts.push(`${label}: ${m.text}`);
    }
    parts.push('---');
  }

  if (otherThreads && otherThreads.length > 0) {
    parts.push('Other recent threads in this channel:');
    for (const thread of otherThreads) {
      const rootLabel = thread.root.displayName
        ? `${thread.root.displayName} (<@${thread.root.userId}>)`
        : (thread.root.user ? `<@${thread.root.user}>` : `<@${thread.root.userId}>`);
      parts.push(`[Thread] ${rootLabel}: ${thread.root.text}`);
      for (const r of thread.replies) {
        const rLabel = r.displayName ? `${r.displayName} (<@${r.userId}>)` : (r.user ? `<@${r.user}>` : `<@${r.userId}>`);
        parts.push(`  ${rLabel}: ${r.text}`);
      }
    }
    parts.push('---');
  }

  if (threadMessages && threadMessages.length > 0) {
    parts.push('Current thread context:');
    for (const m of threadMessages) {
      const label = m.displayName ? `${m.displayName} (<@${m.userId}>)` : (m.user ? `<@${m.user}>` : `<@${m.userId}>`);
      parts.push(`${label}: ${m.text}`);
    }
    parts.push('---');
  }
  if (isWildcard) {
    parts.push('[You have jumped into this conversation uninvited. Make it brief and make it count — a quick quip, roast, or sharp observation. Do not announce or explain that you jumped in uninvited.]');
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

    const { onTool, isWildcard, ...ctxFields } = ctx;
    const userMessage = buildUserMessage({ ...ctxFields, githubRepo: config.GITHUB_REPO, isWildcard });
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

    try {
      while (true) {

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let response;
        try {
          response = await anthropicClient.messages.create(
            { ...payload, messages: [...payload.messages] },
            { signal: controller.signal }
          );
        } finally {
          clearTimeout(timer);
        }

        logger.debug({ response }, 'LLM response');

        if (response.stop_reason === 'end_turn') {
          const textBlock = response.content.find(b => b.type === 'text');
          return textBlock ? textBlock.text : composeFallback();
        }

        if (response.stop_reason === 'tool_use') {
          payload.messages = [...payload.messages, { role: 'assistant', content: response.content }];

          const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
          if (onTool && toolUseBlocks.length > 0) onTool(toolUseBlocks[0].name);

          const toolResultBlocks = await Promise.all(
            toolUseBlocks
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
    } catch (err) {
      logger.error({ err: err.message }, 'LLM call failed');
      return composeFallback();
    }
  };
}
