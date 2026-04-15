import bolt from '@slack/bolt';
import { buildThreadContext } from './llm/index.js';
import { logger } from './logger.js';

const { App, LogLevel } = bolt;

const MAX_INDICATOR_MS = 60_000;

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

async function fetchThreadContext(client, event, maxChars) {
  const { thread_ts, ts, channel } = event;
  const isReplyInThread = thread_ts && thread_ts !== ts;
  if (!isReplyInThread) return null;

  let replies;
  try {
    const result = await client.conversations.replies({ channel, ts: thread_ts });
    replies = result.messages ?? [];
  } catch {
    return null;
  }

  const nameCache = new Map();
  const messages = await Promise.all(
    replies.map(async (m) => {
      const userId = m.user ?? 'unknown';
      const displayName = await resolveDisplayName(client, userId, nameCache);
      return { userId, displayName, text: m.text ?? '' };
    })
  );

  return buildThreadContext(messages, maxChars);
}

export function buildToolsMessage(toolsByServer) {
  const lines = ['*Registered MCP tools*', ''];
  for (const [serverName, toolNames] of toolsByServer) {
    const toolList = toolNames.length > 0 ? toolNames.join(', ') : '(none — allowedTools is empty)';
    lines.push(`*${serverName}:* ${toolList}`);
  }
  lines.push('', 'To add tools, update allowedTools in mcp-servers.json and redeploy.');
  return lines.join('\n');
}

export async function buildSlackApp({ config, reply, toolsByServer, _createApp = null }) {
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

    const indicator = makeProgressIndicator({
      client,
      channel: event.channel,
      ts: event.ts,
      threadTs,
    });

    const nameCache = new Map();
    const [threadMessages, channelInfo, mentionDisplayName] = await Promise.all([
      fetchThreadContext(client, event, config.THREAD_CONTEXT_MAX_CHARS),
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
    });

    await indicator.stop();

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text,
    });
  });

  app.error(async (error) => {
    logger.error({ err: error.message }, 'Slack app error');
  });

  return app;
}
