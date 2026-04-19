import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeProgressIndicator, buildSlackApp, buildToolsMessage } from '../src/slack.js';

const PERSONA_REACTIONS = ['toilet', 'thinking_face', 'brain', 'face_with_monocle', 'nerd_face', 'flushed'];

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
      delete: async (args) => { calls.push({ fn: 'chat.delete', ...args }); },
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('makeProgressIndicator', () => {
  it('does not add any reaction immediately on creation', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await flush();
    assert.ok(!client.calls.some(c => c.fn === 'reactions.add'), 'no reaction before 3s delay');
    t.mock.timers.reset();
  });

  it('adds a random persona emoji after 3s delay', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000);
    await flush();
    const added = client.calls.filter(c => c.fn === 'reactions.add');
    assert.equal(added.length, 1, 'exactly one reaction added after delay');
    assert.ok(PERSONA_REACTIONS.includes(added[0].name), `"${added[0].name}" should be a persona emoji`);
    t.mock.timers.reset();
  });

  it('switches to hourglass after first interval tick (5s total)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000); await flush();
    t.mock.timers.tick(2_000); await flush();
    assert.ok(client.calls.some(c => c.fn === 'reactions.remove'), 'persona reaction removed');
    assert.ok(client.calls.some(c => c.fn === 'reactions.add' && c.name === 'hourglass'), 'hourglass added');
    t.mock.timers.reset();
  });

  it('posts status message and removes hourglass after second tick (10s total)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000); await flush();
    t.mock.timers.tick(2_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    assert.ok(client.calls.some(c => c.fn === 'reactions.remove' && c.name === 'hourglass'), 'hourglass removed');
    assert.ok(client.calls.some(c => c.fn === 'chat.postMessage'), 'status message posted');
    t.mock.timers.reset();
  });

  it('edits status message on subsequent ticks', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000); await flush();
    t.mock.timers.tick(2_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    assert.ok(client.calls.some(c => c.fn === 'chat.update' && c.ts === 'status-ts-001'));
    t.mock.timers.reset();
  });

  it('uses different still-working messages on consecutive ticks', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000); await flush();
    t.mock.timers.tick(2_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    const updates = client.calls.filter(c => c.fn === 'chat.update');
    assert.ok(updates.length >= 2, 'at least two update calls');
    assert.notEqual(updates[0].text, updates[1].text, 'consecutive updates use different messages');
    t.mock.timers.reset();
  });

  it('stop() removes all active reactions', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000); await flush();
    await indicator.stop();
    const removals = client.calls.filter(c => c.fn === 'reactions.remove');
    assert.ok(removals.length > 0, 'at least one reaction removed on stop');
    t.mock.timers.reset();
  });

  it('stop() deletes status message when one was posted', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000); await flush();
    t.mock.timers.tick(2_000); await flush();
    t.mock.timers.tick(5_000); await flush();
    await indicator.stop();
    assert.ok(client.calls.some(c => c.fn === 'chat.delete' && c.ts === 'status-ts-001'), 'status message deleted on stop');
    t.mock.timers.reset();
  });

  it('stop() skips chat.delete when no status message was posted', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await indicator.stop();
    assert.ok(!client.calls.some(c => c.fn === 'chat.delete'), 'no chat.delete when no status message');
    t.mock.timers.reset();
  });

  it('stop() prevents further ticks from firing', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000); await flush();
    await indicator.stop();
    const callsAtStop = client.calls.length;
    t.mock.timers.tick(5_000); await flush();
    assert.equal(client.calls.length, callsAtStop, 'no new calls after stop');
    t.mock.timers.reset();
  });

  it('self-terminates after max lifetime and stops accepting ticks', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(60_001); await flush(); await flush();
    const callsAfterMax = client.calls.length;
    t.mock.timers.tick(5_000); await flush();
    assert.equal(client.calls.length, callsAfterMax, 'no further calls after max lifetime');
    t.mock.timers.reset();
  });

  it('setStatus() posts a message when none exists yet', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await indicator.setStatus('checking something...');
    await flush();
    assert.ok(client.calls.some(c => c.fn === 'chat.postMessage' && c.text === 'checking something...'));
    t.mock.timers.reset();
  });

  it('setStatus() updates the existing message on second call', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await indicator.setStatus('first status');
    await flush();
    await indicator.setStatus('second status');
    await flush();
    assert.ok(client.calls.some(c => c.fn === 'chat.update' && c.ts === 'status-ts-001' && c.text === 'second status'));
    t.mock.timers.reset();
  });

  it('setStatus() removes active reaction before posting', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    t.mock.timers.tick(3_000); await flush();
    await indicator.setStatus('tool is running...');
    await flush();
    const removeIdx = client.calls.findIndex(c => c.fn === 'reactions.remove');
    const postIdx = client.calls.findIndex(c => c.fn === 'chat.postMessage');
    assert.ok(removeIdx !== -1, 'reaction removed');
    assert.ok(postIdx !== -1, 'status posted');
    assert.ok(removeIdx < postIdx, 'reaction removed before status message posted');
    t.mock.timers.reset();
  });

  it('setStatus() is a no-op after stop()', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const client = makeClient();
    const indicator = makeProgressIndicator({ client, channel: 'C1', ts: 'ts1', threadTs: 'thread1' });
    await indicator.stop();
    const callsAtStop = client.calls.length;
    await indicator.setStatus('should not appear');
    await flush();
    assert.equal(client.calls.length, callsAtStop, 'no calls after stop');
    t.mock.timers.reset();
  });
});

function makeSlackClient({ usersInfoName = 'Alice', usersInfoThrows = false } = {}) {
  const posted = [];
  const usersInfoCalls = [];
  return {
    posted,
    usersInfoCalls,
    auth: { test: async () => ({ user_id: 'UBOT', bot_id: 'BBOT' }) },
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
      delete: async () => {},
    },
    conversations: {
      info: async () => ({ channel: { name: 'general' } }),
      replies: async () => ({ messages: [] }),
      history: async () => ({ messages: [] }),
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

function makeSessionStore({ active = false } = {}) {
  const touched = [];
  return {
    touched,
    touch: async (threadTs) => { touched.push(threadTs); },
    isActive: async () => active,
    remove: async () => {},
  };
}

const baseConfig = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: null,
  SLACK_SIGNING_SECRET: 'secret',
  LOG_LEVEL: 'info',
  THREAD_CONTEXT_MAX_CHARS: 6000,
  CHANNEL_HISTORY_MAX_CHARS: 4000,
  CHANNEL_HISTORY_LIMIT: 20,
  WILDCARD_ENABLED: true,
};

describe('buildToolsMessage', () => {
  it('formats tools grouped by server with descriptions', () => {
    const toolsByServer = new Map([
      ['wikipedia', [{ name: 'search', description: 'Search articles' }, { name: 'readArticle', description: 'Read article' }]],
      ['github', []],
      ['local', [{ name: 'refresh_repo_doc', description: 'Refresh a doc' }]],
    ]);
    const msg = buildToolsMessage(toolsByServer);
    assert.ok(msg.includes('wikipedia'), 'should include server name');
    assert.ok(msg.includes('search'), 'should include tool name');
    assert.ok(msg.includes('Search articles'), 'should include tool description');
    assert.ok(msg.includes('(none)'), 'should indicate empty server');
    assert.ok(msg.includes('refresh_repo_doc'), 'should include local tool');
  });
});

describe('@smelly-bot tools intercept', () => {
  it('posts tool list without calling reply for "tools"', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    const toolsByServer = new Map([
      ['wikipedia', [{ name: 'search', description: 'Search' }, { name: 'readArticle', description: 'Read' }]],
      ['github', []],
      ['local', [{ name: 'refresh_repo_doc', description: 'Refresh' }]],
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
    await buildSlackApp({
      config: baseConfig,
      reply: async () => 'ok',
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> hi', ts: 'ts1', thread_ts: 'thread1', channel: 'C1', user: 'U123' },
      client: slackClient,
    });
    const u123Calls = slackClient.usersInfoCalls.filter(id => id === 'U123');
    assert.ok(u123Calls.length <= 2, `U123 should be looked up at most twice, got ${u123Calls.length}`);
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

describe('wildcard behavior', () => {
  it('invokes reply with isWildcard=true when wildcardStore fires', async () => {
    let capturedCtx = null;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async (ctx) => { capturedCtx = ctx; return 'wildcard reply'; },
      toolsByServer: new Map([['local', []]]),
      wildcardStore: { shouldFire: async () => true },
      _createApp: () => mockApp,
    });
    await mockApp._events['message']({
      event: { text: 'random chatter', ts: 'msg-ts', channel: 'C1', user: 'U1' },
      client: slackClient,
    });
    assert.equal(capturedCtx?.isWildcard, true, 'isWildcard should be true for wildcard invocations');
  });

  it('does not invoke reply when wildcardStore.shouldFire returns false', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => { replyCalled = true; return 'x'; },
      toolsByServer: new Map([['local', []]]),
      wildcardStore: { shouldFire: async () => false },
      _createApp: () => mockApp,
    });
    await mockApp._events['message']({
      event: { text: 'random chatter', ts: 'msg-ts', channel: 'C1', user: 'U1' },
      client: slackClient,
    });
    assert.equal(replyCalled, false, 'should not invoke reply when shouldFire is false');
  });

  it('does not invoke wildcard when WILDCARD_ENABLED is false', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: { ...baseConfig, WILDCARD_ENABLED: false },
      reply: async () => { replyCalled = true; return 'x'; },
      toolsByServer: new Map([['local', []]]),
      wildcardStore: { shouldFire: async () => true },
      _createApp: () => mockApp,
    });
    await mockApp._events['message']({
      event: { text: 'random chatter', ts: 'msg-ts', channel: 'C1', user: 'U1' },
      client: slackClient,
    });
    assert.equal(replyCalled, false, 'should not invoke wildcard when WILDCARD_ENABLED is false');
  });
});

describe('channel routing', () => {
  it('posts to channel (no thread_ts) when reply starts with [CHANNEL] and not in thread', async () => {
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => '[CHANNEL]\nhello channel',
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> hey', ts: 'top-ts', channel: 'C1', user: 'U1' },
      client: slackClient,
    });
    const post = slackClient.posted.find(p => p.text === 'hello channel');
    assert.ok(post, 'should post the response');
    assert.equal(post.thread_ts, undefined, 'should not have thread_ts for [CHANNEL] response');
  });

  it('stays in thread when [CHANNEL] prefix used inside an existing thread', async () => {
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => '[CHANNEL]\nhello',
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> hey', ts: 'msg-ts', thread_ts: 'root-ts', channel: 'C1', user: 'U1' },
      client: slackClient,
    });
    const post = slackClient.posted.find(p => p.text === 'hello');
    assert.ok(post, 'should post the response');
    assert.equal(post.thread_ts, 'root-ts', 'should stay in thread when invoked inside one');
  });

  it('strips [CHANNEL] prefix from the posted text', async () => {
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => '[CHANNEL]\nactual message text',
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> hey', ts: 'top-ts', channel: 'C1', user: 'U1' },
      client: slackClient,
    });
    const post = slackClient.posted.find(p => p.text === 'actual message text');
    assert.ok(post, 'should strip [CHANNEL] prefix from posted text');
  });
});

describe('isInThread context', () => {
  it('passes isInThread: false for top-level mentions', async () => {
    let capturedCtx = null;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async (ctx) => { capturedCtx = ctx; return 'ok'; },
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> hi', ts: 'top-ts', channel: 'C1', user: 'U1' },
      client: slackClient,
    });
    assert.equal(capturedCtx?.isInThread, false, 'isInThread should be false for top-level mentions');
  });

  it('passes isInThread: true for in-thread mentions', async () => {
    let capturedCtx = null;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async (ctx) => { capturedCtx = ctx; return 'ok'; },
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    await mockApp._events['app_mention']({
      event: { text: '<@UBOT> hi', ts: 'msg-ts', thread_ts: 'root-ts', channel: 'C1', user: 'U1' },
      client: slackClient,
    });
    assert.equal(capturedCtx?.isInThread, true, 'isInThread should be true for in-thread mentions');
  });
});

describe('reaction_added event', () => {
  it('calls handleInvocation when emoji classified as question on a bot message', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    slackClient.conversations.history = async ({ latest }) => ({
      messages: [{ bot_id: 'BBOT', ts: latest, text: 'bot said this' }],
    });
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => { replyCalled = true; return 'ok'; },
      toolsByServer: new Map([['local', []]]),
      classifyReaction: async () => 'question',
      _createApp: () => mockApp,
    });
    await mockApp._events['reaction_added']({
      event: {
        reaction: 'thinking_face',
        user: 'U1',
        item: { type: 'message', channel: 'C1', ts: 'bot-msg-ts' },
      },
      client: slackClient,
    });
    assert.equal(replyCalled, true, 'should invoke reply for question reaction');
  });

  it('skips when emoji classified as agree', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    slackClient.conversations.history = async () => ({
      messages: [{ bot_id: 'BBOT', ts: 'bot-msg-ts', text: 'bot said this' }],
    });
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => { replyCalled = true; return 'ok'; },
      toolsByServer: new Map([['local', []]]),
      classifyReaction: async () => 'agree',
      _createApp: () => mockApp,
    });
    await mockApp._events['reaction_added']({
      event: { reaction: 'thumbsup', user: 'U1', item: { type: 'message', channel: 'C1', ts: 'bot-msg-ts' } },
      client: slackClient,
    });
    assert.equal(replyCalled, false, 'should not invoke reply for agree reaction');
  });

  it('skips when message is not from this bot', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    slackClient.conversations.history = async () => ({
      messages: [{ bot_id: 'BOTHER', ts: 'msg-ts', text: 'someone else' }],
    });
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => { replyCalled = true; return 'ok'; },
      toolsByServer: new Map([['local', []]]),
      classifyReaction: async () => 'question',
      _createApp: () => mockApp,
    });
    await mockApp._events['reaction_added']({
      event: { reaction: 'thinking_face', user: 'U1', item: { type: 'message', channel: 'C1', ts: 'msg-ts' } },
      client: slackClient,
    });
    assert.equal(replyCalled, false, 'should not invoke reply when message is not from this bot');
  });

  it('does not register reaction_added when classifyReaction is null', async () => {
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => 'ok',
      toolsByServer: new Map([['local', []]]),
      _createApp: () => mockApp,
    });
    assert.equal(mockApp._events['reaction_added'], undefined, 'should not register reaction_added handler when classifyReaction is null');
  });

  it('skips when item type is not message', async () => {
    let replyCalled = false;
    const slackClient = makeSlackClient();
    const mockApp = makeMockBoltApp(slackClient);
    await buildSlackApp({
      config: baseConfig,
      reply: async () => { replyCalled = true; return 'ok'; },
      toolsByServer: new Map([['local', []]]),
      classifyReaction: async () => 'question',
      _createApp: () => mockApp,
    });
    await mockApp._events['reaction_added']({
      event: { reaction: 'thinking_face', user: 'U1', item: { type: 'file', channel: 'C1', ts: 'ts1' } },
      client: slackClient,
    });
    assert.equal(replyCalled, false, 'should not invoke reply for non-message reactions');
  });
});
