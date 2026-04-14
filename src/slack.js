import bolt from '@slack/bolt';

const { App, LogLevel } = bolt;

export function buildSlackApp({ config, reply }) {
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: config.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
  });

  app.event('app_mention', async ({ event, say }) => {
    const text = await reply({
      channelId: event.channel,
      mentionUserId: event.user,
      mentionText: event.text,
      threadTs: event.thread_ts ?? null,
      eventTs: event.ts,
    });
    await say({ text, thread_ts: event.thread_ts ?? event.ts });
  });

  app.error(async (error) => {
    console.error('Slack app error:', error);
  });

  return app;
}
