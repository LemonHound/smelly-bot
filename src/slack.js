import bolt from '@slack/bolt';
import { buildThreadContext } from './llm/index.js';

const { App, LogLevel } = bolt;

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
    done = true;
    clearInterval(timer);
    await Promise.all([
      client.reactions.remove({ channel, timestamp: ts, name: 'eyes' }).catch(() => {}),
      client.reactions.remove({ channel, timestamp: ts, name: 'hourglass' }).catch(() => {}),
    ]);
  };

  return { stop };
}

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
  const logLevel = config.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO;

  const app = config.SLACK_APP_TOKEN
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

  app.event('app_mention', async ({ event, client }) => {
    const threadTs = event.thread_ts ?? event.ts;

    const indicator = makeProgressIndicator({
      client,
      channel: event.channel,
      ts: event.ts,
      threadTs,
    });

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

    await indicator.stop();

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text,
    });
  });

  app.error(async (error) => {
    console.error('Slack app error:', error);
  });

  return app;
}
