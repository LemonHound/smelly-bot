import 'dotenv/config';
import bolt from '@slack/bolt';

const { App, LogLevel } = bolt;

const RESPONSES = ['fart', ':dash:', ':cloud:', 'pfffbbbt'];

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

app.event('app_mention', async ({ event, say }) => {
  const reply = RESPONSES[Math.floor(Math.random() * RESPONSES.length)];
  await say({ text: reply, thread_ts: event.thread_ts ?? event.ts });
});

app.error(async (error) => {
  console.error('Unhandled error:', error);
});

const port = Number(process.env.PORT) || 3000;
await app.start(port);
console.log(`smelly-bot running (socket mode, port ${port} reserved for future HTTP use)`);
