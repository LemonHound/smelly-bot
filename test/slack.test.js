import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeProgressIndicator } from '../src/slack.js';

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
});
