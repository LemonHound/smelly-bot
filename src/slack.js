import bolt from '@slack/bolt';
import { buildThreadContext } from './llm/index.js';

const { App, LogLevel } = bolt;

async function resolveDisplayName(client, userId) {
  try {
    const result = await client.users.info({ user: userId });
    return result.user?.profile?.display_name || result.user?.real_name || userId;
  } catch {
    return userId;
  }
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

  const messages = replies.map(m => ({ user: m.user ?? 'unknown', text: m.text ?? '' }));
  return buildThreadContext(messages, maxChars);
}

export function buildSlackApp({ config, reply }) {
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: config.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
  });

  app.event('app_mention', async ({ event, say, client }) => {
    const [mentionUser, threadMessages] = await Promise.all([
      resolveDisplayName(client, event.user),
      fetchThreadContext(client, event, config.THREAD_CONTEXT_MAX_CHARS),
    ]);

    const channelInfo = await client.conversations.info({ channel: event.channel }).catch(() => null);
    const channelName = channelInfo?.channel?.name ?? event.channel;

    const text = await reply({
      channelName,
      mentionUser,
      mentionText: event.text,
      threadMessages,
    });

    await say({ text, thread_ts: event.thread_ts ?? event.ts });
  });

  app.error(async (error) => {
    console.error('Slack app error:', error);
  });

  return app;
}
