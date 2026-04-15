import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeProgressIndicator, buildSlackApp, buildToolsMessage } from '../src/slack.js';

function makeClient() {
  const calls = [];
  return {
    calls,
    reactions: {
      add: async (args) => { calls.push({ fn: 'reactions.add', ...args }); },
      remove: async (args) => { calls.push({ fn: 'reactions.remove', ...args }); },
    },
    chat: {
      postMessage: async (args) => {
        calls.push({ fn: 'chat.postMessage', ...args });
        return { ts: 'status-ts-001' };
      },
      update: async (args) => { calls.push({ fn: 'chat.update', ...args }); },
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('makeProgressIndicator', () => {
  it('adds eyes reaction immediately on creation', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();
    assert.ok(client.calls.some(c => c.fn === 'reactions.add' && c.name === 'eyes'));
    t.mock.timers.reset();
  });

  it('switches to hourglass after first tick (5s)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();

    t.mock.timers.tick(5_000);
    await flush();

    assert.ok(client.calls.some(c => c.fn === 'reactions.remove' && c.name === 'eyes'));
    assert.ok(client.calls.some(c => c.fn === 'reactions.add' && c.name === 'hourglass'));
    t.mock.timers.reset();
  });

  it('posts status message and removes hourglass after second tick (10s)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();

    t.mock.timers.tick(5_000);
    await flush();
    t.mock.timers.tick(5_000);
    await flush();

    assert.ok(client.calls.some(c => c.fn === 'reactions.remove' && c.name === 'hourglass'));
    assert.ok(client.calls.some(c => c.fn === 'chat.postMessage'));
    t.mock.timers.reset();
  });

  it('edits status message on subsequent ticks', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();

    t.mock.timers.tick(5_000);
    await flush();
    t.mock.timers.tick(5_000);
    await flush();
    t.mock.timers.tick(5_000);
    await flush();

    assert.ok(client.calls.some(c => c.fn === 'chat.update' && c.ts === 'status-ts-001'));
    t.mock.timers.reset();
  });

  it('edits with different messages on consecutive ticks', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();

    t.mock.timers.tick(5_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    t.mock.timers.tick(5_000); await flush();

    const updates = client.calls.filter(c => c.fn === 'chat.update');
    assert.ok(updates.length >= 2, 'should have at least two updates');
    assert.notEqual(updates[0].text, updates[1].text, 'consecutive updates should differ');
    t.mock.timers.reset();
  });

  it('stop() removes active emoji reactions', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();

    await indicator.stop();

    const removals = client.calls.filter(c => c.fn === 'reactions.remove');
    assert.ok(removals.some(c => c.name === 'eyes') || removals.some(c => c.name === 'hourglass'));
    t.mock.timers.reset();
  });

  it('stop() prevents further ticks from firing', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();

    await indicator.stop();
    const callCountAtStop = client.calls.length;

    t.mock.timers.tick(5_000);
    await flush();

    assert.equal(client.calls.length, callCountAtStop, 'no new calls after stop');
    t.mock.timers.reset();
  });

  it('self-terminates after max lifetime even if stop() is never called', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();

    t.mock.timers.tick(60_000);
    await flush();

    const removals = client.calls.filter(c => c.fn === 'reactions.remove');
    assert.ok(removals.length > 0, 'reactions should be cleaned up by max lifetime');

    t.mock.timers.tick(5_000);
    await flush();
    const callsAfterMax = client.calls.length;

    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(client.calls.length, callsAfterMax, 'no further calls after self-termination');
    t.mock.timers.reset();
  });
});

function makeSlackClient({ usersInfoName = 'Alice', usersInfoThrows = false } = {}) {
  const posted = [];
  const usersInfoCalls = [];
  return {
    posted,
    usersInfoCalls,
    auth: { test: async () => ({ user_id: 'UBOT' }) },
    reactions: {
      add: async () => {},
      remove: async () => {},
    },
    chat: {
      postMessage: async (args) => {
        posted.push(args);
        return { ts: 'msg-ts' };
      },
      update: async () => {},
    },
    conversations: {
      info: async () => ({ channel: { name: 'general' } }),
      replies: async () => ({ messages: [] }),
    },
    users: {
      info: async ({ user }) => {
        usersInfoCalls.push(user);
        if (usersInfoThrows) throw new Error('users.info failed');
        return { user: { profile: { display_name: usersInfoName }, real_name: usersInfoName } };
      },
    },
  };
}

function makeMockBoltApp(slackClient) {
  const events = {};
  const errHandlers = [];
  return {
    _events: events,
    event: (name, handler) => { events[name] = handler; },
    error: (handler) => errHandlers.push(handler),
    start: async () => {},
    client: slackClient,
  };
}

const baseConfig = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: null,
  SLACK_SIGNING_SECRET: 'secret',
  LOG_LEVEL: 'info',
  THREAD_CONTEXT_MAX_CHARS: 6000,
};

describe('buildToolsMessage', () => {
  it('formats tools grouped by server', () => {
    const toolsByServer = new Map([
      ['wikipedia', ['search', 'readArticle']],
      ['github', []],
      ['local', ['refresh_repo_doc']],
    ]);
    const msg = buildToolsMessage(toolsByServer);
    assert.ok(msg.includes('wikipedia'), 'should include server name');
    assert.ok(msg.includes('search, readArticle'), 'should include tool names');
    assert.ok(msg.includes('(none — allowedTools is empty)'), 'should indicate empty server');
    assert.ok(msg.includes('refresh_repo_doc'), 'should include local tool');
  });
});

describe('@smelly-bot tools intercept', () => {
  it('posts tool list without calling reply for "tools"', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    const toolsByServer = new Map([
      ['wikipedia', ['search', 'readArticle']],
      ['github', []],
      ['local', ['refresh_repo_doc']],
    ]);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => { replyCalled = true; return 'reply text'; },
      toolsByServer,
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> tools', ts: 'ts1', channel: 'C1', user: 'U123' },
      client: slackClient,
    });
    assert.equal(replyCalled, false, 'reply should not be called for tools command');
    assert.ok(slackClient.posted.length > 0, 'should post a message');
    assert.ok(slackClient.posted[0].text.includes('wikipedia'), 'tool list should include wikipedia server');
    assert.ok(slackClient.posted[0].text.includes('refresh_repo_doc'), 'tool list should include local tool');
  });

  it('treats "TOOLS" case-insensitively', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => { replyCalled = true; return 'x'; },
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> TOOLS', ts: 'ts1', channel: 'C1', user: 'U123' },
      client: slackClient,
    });
    assert.equal(replyCalled, false, 'reply should not be called for TOOLS');
  });

  it('does not intercept "tools please"', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => { replyCalled = true; return 'LLM response'; },
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> tools please', ts: 'ts1', channel: 'C1', user: 'U123' },
      client: slackClient,
    });
    assert.equal(replyCalled, true, 'reply should be called for "tools please"');
  });
});

describe('display name resolution', () => {
  it('deduplicates users.info calls for same user across thread messages', async () => {
    const slackClient = makeSlackClient({ usersInfoName: 'Bob' });
    slackClient.conversations.replies = async () => ({
      messages: [
        { user: 'U123', text: 'first' },
        { user: 'U123', text: 'second' },
      ],
    });
    const mockApp = makeMockBoltApp(slackClient);
    let capturedCtx = null;
    await buildSlackApp({
      config: baseConfig,
      reply: async (ctx) => { capturedCtx = ctx; return 'ok'; },
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> hi', ts: 'ts1', thread_ts: 'thread1', channel: 'C1', user: 'U123' },
      client: slackClient,
    });
    const u123Calls = slackClient.usersInfoCalls.filter(id => id === 'U123');
    assert.ok(u123Calls.length <= 2, `U123 should be looked up at most twice (thread + mention), got ${u123Calls.length}`);
  });

  it('falls back to raw user ID when users.info throws', async () => {
    const slackClient = makeSlackClient({ usersInfoThrows: true });
    const mockApp = makeMockBoltApp(slackClient);
    let capturedCtx = null;
    await buildSlackApp({
      config: baseConfig,
      reply: async (ctx) => { capturedCtx = ctx; return 'ok'; },
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> hi', ts: 'ts1', channel: 'C1', user: 'U999' },
      client: slackClient,
    });
    assert.equal(capturedCtx.mentionDisplayName, 'U999', 'should fall back to raw user ID');
  });
});
