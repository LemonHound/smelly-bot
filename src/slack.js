import bolt from '@slack/bolt';
import { buildThreadContext } from './llm/index.js';
import { logger } from './logger.js';

function buildChannelContext(messages, maxChars) {
  let total = 0;
  const included = [];
  for (const m of messages) {
    const chars = `${m.displayName ?? m.userId}: ${m.text}`.length;
    if (total + chars > maxChars) break;
    total += chars;
    included.push(m);
  }
  return included.reverse();
}

const { App, LogLevel } = bolt;

const MAX_INDICATOR_MS = 60_000;

const PERSONALITY_REACTIONS = [
  'poop', 'brain', 'smiling_imp', 'toilet', 'dash', 'sunglasses',
  'face_with_raised_eyebrow', 'nerd_face', 'exploding_head', 'fire',
];

const STILL_WORKING_MESSAGES = [
  "still thinking... :brain:",
  "still here, don't flush yet... :toilet:",
  "processing at maximum flatulence... :dash:",
  "almost there... maybe... :crossed_fingers:",
  "still brewing... :coffee:",
  "my one brain cell is working overtime... :sweat_smile:",
];

export function makeProgressIndicator({ client, channel, ts, threadTs }) {
  let done = false;
  let phase = 0;
  let statusTs = null;
  let updateIdx = 0;

  client.reactions.add({ channel, timestamp: ts, name: 'eyes' }).catch(() => {});

  const tick = async () => {
    if (done) return;
    phase++;

    if (phase === 1) {
      await Promise.all([
        client.reactions.remove({ channel, timestamp: ts, name: 'eyes' }).catch(() => {}),
        client.reactions.add({ channel, timestamp: ts, name: 'hourglass' }).catch(() => {}),
      ]);
    } else if (phase === 2) {
      await client.reactions.remove({ channel, timestamp: ts, name: 'hourglass' }).catch(() => {});
      const result = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: 'hang on, this is taking a minute... :hourglass_flowing_sand:',
      }).catch(() => null);
      statusTs = result?.ts ?? null;
    } else if (statusTs) {
      const text = STILL_WORKING_MESSAGES[updateIdx % STILL_WORKING_MESSAGES.length];
      updateIdx++;
      await client.chat.update({ channel, ts: statusTs, text }).catch(() => {});
    }
  };

  const timer = setInterval(tick, 5_000);

  const stop = async () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearTimeout(maxTimer);
    await Promise.all([
      client.reactions.remove({ channel, timestamp: ts, name: 'eyes' }).catch(() => {}),
      client.reactions.remove({ channel, timestamp: ts, name: 'hourglass' }).catch(() => {}),
    ]);
  };

  const maxTimer = setTimeout(stop, MAX_INDICATOR_MS);

  return { stop };
}

function resolveDisplayName(client, userId, cache) {
  if (cache.has(userId)) return cache.get(userId);
  const promise = client.users.info({ user: userId })
    .then(result => result.user?.profile?.display_name || result.user?.real_name || userId)
    .catch(() => userId);
  cache.set(userId, promise);
  return promise;
}

async function fetchThreadMessages(client, channel, threadTs, maxChars, nameCache) {
  let replies;
  try {
    const result = await client.conversations.replies({ channel, ts: threadTs });
    replies = result.messages ?? [];
  } catch {
    return null;
  }

  const messages = await Promise.all(
    replies.map(async (m) => {
      const userId = m.user ?? 'unknown';
      const displayName = await resolveDisplayName(client, userId, nameCache);
      return { userId, displayName, text: m.text ?? '' };
    })
  );

  return buildThreadContext(messages, maxChars);
}

async function fetchChannelContext(client, event, config, nameCache) {
  const { channel, ts, thread_ts } = event;
  const currentThreadTs = thread_ts ?? ts;
  const limit = config.CHANNEL_HISTORY_LIMIT;
  const maxChars = config.CHANNEL_HISTORY_MAX_CHARS;

  let historyMessages = [];
  try {
    const result = await client.conversations.history({ channel, limit });
    historyMessages = result.messages ?? [];
  } catch {
    return { channelMessages: [], otherThreads: [] };
  }

  const topLevelMessages = historyMessages.filter(m => !m.thread_ts || m.thread_ts === m.ts);
  const threadRoots = historyMessages.filter(
    m => m.thread_ts && m.thread_ts === m.ts && m.reply_count > 0 && m.thread_ts !== currentThreadTs
  );

  const channelMsgs = await Promise.all(
    topLevelMessages.map(async (m) => {
      const userId = m.user ?? 'unknown';
      const displayName = await resolveDisplayName(client, userId, nameCache);
      return { userId, displayName, text: m.text ?? '' };
    })
  );

  const otherThreads = [];
  for (const rootMsg of threadRoots.slice(0, 5)) {
    try {
      const result = await client.conversations.replies({ channel, ts: rootMsg.ts });
      const replies = (result.messages ?? []).slice(1, 4);
      const rootUserId = rootMsg.user ?? 'unknown';
      const rootDisplayName = await resolveDisplayName(client, rootUserId, nameCache);
      const replyMsgs = await Promise.all(
        replies.map(async (r) => {
          const userId = r.user ?? 'unknown';
          const displayName = await resolveDisplayName(client, userId, nameCache);
          return { userId, displayName, text: r.text ?? '' };
        })
      );
      otherThreads.push({
        root: { userId: rootUserId, displayName: rootDisplayName, text: rootMsg.text ?? '' },
        replies: replyMsgs,
      });
    } catch {
      // skip threads that fail to load
    }
  }

  return { channelMessages: buildChannelContext(channelMsgs, maxChars), otherThreads };
}

export function buildToolsMessage(toolsByServer) {
  const lines = ['*Registered MCP tools*', ''];
  for (const [serverName, tools] of toolsByServer) {
    if (tools.length === 0) {
      lines.push(`*${serverName}:* (none)`);
    } else {
      lines.push(`*${serverName}:*`);
      for (const tool of tools) {
        lines.push(`  ${tool.name} \u2014 ${tool.description}`);
      }
    }
    lines.push('');
  }
  lines.push('To enable tools for the LLM, add them to allowedTools in mcp-servers.json and redeploy.');
  return lines.join('\n');
}

export async function buildSlackApp({ config, reply, toolsByServer, sessionStore = null, _createApp = null }) {
  const logLevel = config.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO;

  const app = _createApp
    ? _createApp()
    : config.SLACK_APP_TOKEN
      ? new App({
          token: config.SLACK_BOT_TOKEN,
          appToken: config.SLACK_APP_TOKEN,
          socketMode: true,
          logLevel,
        })
      : new App({
          token: config.SLACK_BOT_TOKEN,
          signingSecret: config.SLACK_SIGNING_SECRET,
          logLevel,
        });

  const { user_id: botUserId } = await app.client.auth.test();
  logger.info({ botUserId }, 'Bot identity confirmed');

  async function handleInvocation({ event, client, mentionText }) {
    const threadTs = event.thread_ts ?? event.ts;

    const indicator = makeProgressIndicator({
      client,
      channel: event.channel,
      ts: event.ts,
      threadTs,
    });

    const nameCache = new Map();
    const [threadMessages, { channelMessages, otherThreads }, channelInfo, mentionDisplayName] = await Promise.all([
      fetchThreadMessages(client, event.channel, threadTs, config.THREAD_CONTEXT_MAX_CHARS, nameCache),
      fetchChannelContext(client, event, config, nameCache),
      client.conversations.info({ channel: event.channel }).catch(() => null),
      resolveDisplayName(client, event.user, nameCache),
    ]);

    const channelName = channelInfo?.channel?.name ?? event.channel;

    const text = await reply({
      channelName,
      mentionUserId: event.user,
      mentionDisplayName,
      botUserId,
      mentionText,
      threadMessages,
      channelMessages,
      otherThreads,
    });

    await indicator.stop();

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text,
    });

    const reaction = PERSONALITY_REACTIONS[Math.floor(Math.random() * PERSONALITY_REACTIONS.length)];
    client.reactions.add({ channel: event.channel, timestamp: event.ts, name: reaction }).catch(() => {});
  }

  app.event('app_mention', async ({ event, client }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const mentionText = event.text.replace(`<@${botUserId}>`, '').trim();

    if (mentionText.toLowerCase() === 'tools') {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: buildToolsMessage(toolsByServer),
      });
      return;
    }

    if (sessionStore) {
      await sessionStore.touch(threadTs);
    }

    await handleInvocation({ event, client, mentionText });
  });

  app.event('message', async ({ event, client }) => {
    if (!sessionStore) return;
    if (event.bot_id) return;
    if (!event.text) return;
    if (event.text.includes(`<@${botUserId}>`)) return;

    const threadTs = event.thread_ts;
    if (!threadTs) return;

    const active = await sessionStore.isActive(threadTs);
    if (!active) return;

    await handleInvocation({ event, client, mentionText: event.text });
  });

  app.error(async (error) => {
    logger.error({ err: error.message }, 'Slack app error');
  });

  return app;
}
