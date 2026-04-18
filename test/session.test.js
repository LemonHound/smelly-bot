import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeSessionStore, makeWildcardStore } from '../src/session.js';

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

const makeWildcardConfig = (overrides = {}) => ({
  WILDCARD_COOLDOWN_MS: 7 * 24 * 60 * 60 * 1000,
  WILDCARD_PROBABILITY: 0.03,
  ...overrides,
});

describe('makeWildcardStore', () => {
  it('returns false and seeds the record on first call for a channel', async () => {
    const firestore = makeFirestore();
    const store = makeWildcardStore({ firestore, config: makeWildcardConfig() });
    const result = await store.shouldFire('C1');
    assert.equal(result, false, 'should return false on first call (no prior record)');
    assert.equal(firestore.docs.size, 1, 'should write initial record');
  });

  it('returns false within the cooldown window', async () => {
    const lastFiredAt = { toMillis: () => Date.now() - 1_000 };
    const firestore = makeFirestore({ snap: { lastFiredAt } });
    const store = makeWildcardStore({ firestore, config: makeWildcardConfig() });
    const result = await store.shouldFire('C1');
    assert.equal(result, false, 'should not fire within cooldown');
  });

  it('returns false after cooldown when probability check fails', async () => {
    const lastFiredAt = { toMillis: () => Date.now() - (8 * 24 * 60 * 60 * 1000) };
    const firestore = makeFirestore({ snap: { lastFiredAt } });
    const store = makeWildcardStore({ firestore, config: makeWildcardConfig({ WILDCARD_PROBABILITY: 0 }) });
    const result = await store.shouldFire('C1');
    assert.equal(result, false, 'should not fire when probability is 0');
  });

  it('returns true and updates timestamp after cooldown when probability passes', async () => {
    const lastFiredAt = { toMillis: () => Date.now() - (8 * 24 * 60 * 60 * 1000) };
    const firestore = makeFirestore({ snap: { lastFiredAt } });
    const store = makeWildcardStore({ firestore, config: makeWildcardConfig({ WILDCARD_PROBABILITY: 1 }) });
    const result = await store.shouldFire('C1');
    assert.equal(result, true, 'should fire when past cooldown and probability is 1');
    assert.equal(firestore.docs.size, 1, 'should update the record');
    const [, data] = [...firestore.docs.entries()][0];
    assert.ok(data.lastFiredAt instanceof Date, 'lastFiredAt should be updated to a Date');
    assert.ok(data.lastFiredAt.getTime() > Date.now() - 1000, 'lastFiredAt should be recent');
  });

  it('returns false and does not throw when Firestore fails', async () => {
    const firestore = makeFirestore({ throwOn: 'get' });
    const store = makeWildcardStore({ firestore, config: makeWildcardConfig() });
    const result = await store.shouldFire('C1');
    assert.equal(result, false, 'should fail closed on Firestore error');
  });
});
