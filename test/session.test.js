import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeSessionStore } from '../src/session.js';

function makeFirestore({ snap = null, throwOn = null } = {}) {
  const docs = new Map();
  return {
    docs,
    collection: () => ({
      doc: (id) => ({
        set: async (data) => {
          if (throwOn === 'set') throw new Error('set failed');
          docs.set(id, { ...data });
        },
        get: async () => {
          if (throwOn === 'get') throw new Error('get failed');
          const data = snap !== null ? snap : docs.get(id);
          if (!data) return { exists: false, data: () => undefined };
          return { exists: true, data: () => data };
        },
        delete: async () => {
          if (throwOn === 'delete') throw new Error('delete failed');
          docs.delete(id);
        },
      }),
    }),
  };
}

const makeConfig = (overrides = {}) => ({
  SESSION_TTL_MS: 30 * 60 * 1000,
  ...overrides,
});

describe('makeSessionStore', () => {
  it('touch writes a doc with expiresAt in the future', async () => {
    const firestore = makeFirestore();
    const store = makeSessionStore({ firestore, config: makeConfig() });
    const before = Date.now();
    await store.touch('thread-ts-1');
    const after = Date.now();

    const [, data] = [...firestore.docs.entries()][0];
    assert.ok(data.expiresAt instanceof Date, 'expiresAt should be a Date');
    assert.ok(data.expiresAt.getTime() > before, 'expiresAt should be in the future');
    assert.ok(data.expiresAt.getTime() <= after + 30 * 60 * 1000 + 100, 'expiresAt should be within TTL');
  });

  it('isActive returns true when expiresAt is in the future', async () => {
    const expiresAt = { toMillis: () => Date.now() + 60_000 };
    const firestore = makeFirestore({ snap: { threadTs: 'thread-ts-1', expiresAt } });
    const store = makeSessionStore({ firestore, config: makeConfig() });
    const result = await store.isActive('thread-ts-1');
    assert.equal(result, true);
  });

  it('isActive returns false when expiresAt is in the past', async () => {
    const expiresAt = { toMillis: () => Date.now() - 1000 };
    const firestore = makeFirestore({ snap: { threadTs: 'thread-ts-1', expiresAt } });
    const store = makeSessionStore({ firestore, config: makeConfig() });
    const result = await store.isActive('thread-ts-1');
    assert.equal(result, false);
  });

  it('isActive returns false when doc does not exist', async () => {
    const firestore = makeFirestore();
    const store = makeSessionStore({ firestore, config: makeConfig() });
    const result = await store.isActive('no-such-thread');
    assert.equal(result, false);
  });

  it('isActive returns false when Firestore throws', async () => {
    const firestore = makeFirestore({ throwOn: 'get' });
    const store = makeSessionStore({ firestore, config: makeConfig() });
    const result = await store.isActive('thread-ts-1');
    assert.equal(result, false);
  });

  it('remove deletes the doc', async () => {
    const firestore = makeFirestore();
    const store = makeSessionStore({ firestore, config: makeConfig() });
    await store.touch('thread-ts-del');
    assert.equal(firestore.docs.size, 1);
    await store.remove('thread-ts-del');
    assert.equal(firestore.docs.size, 0);
  });

  it('touch does not throw when Firestore throws', async () => {
    const firestore = makeFirestore({ throwOn: 'set' });
    const store = makeSessionStore({ firestore, config: makeConfig() });
    await assert.doesNotReject(() => store.touch('thread-ts-fail'));
  });

  it('isActive handles Date objects (not Timestamps) in expiresAt', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const firestore = makeFirestore({ snap: { threadTs: 'thread-ts-1', expiresAt } });
    const store = makeSessionStore({ firestore, config: makeConfig() });
    const result = await store.isActive('thread-ts-1');
    assert.equal(result, true);
  });
});
