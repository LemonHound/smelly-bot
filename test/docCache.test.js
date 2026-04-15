import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocCache } from '../src/github/docCache.js';

const TTL_MS = 24 * 60 * 60 * 1000;

function makeConfig(repo = 'owner/myrepo') {
  return { GITHUB_REPO: repo };
}

function makeFirestore({ snap = null, throwOnGet = false, throwOnSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        get: throwOnGet
          ? async () => { throw new Error('Firestore unavailable'); }
          : async () => snap,
        set: throwOnSet
          ? async () => { throw new Error('Firestore write failed'); }
          : async () => {},
      }),
    }),
  };
}

function makeSnap(content, ageMs = 0) {
  const fetchedAt = new Date(Date.now() - ageMs);
  return {
    exists: true,
    data: () => ({
      content,
      fetchedAt: { toMillis: () => fetchedAt.getTime(), toDate: () => fetchedAt },
    }),
  };
}

const missingSnap = { exists: false };

function makeCallTool(resultText = 'fresh content') {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      return [{ type: 'text', text: resultText }];
    },
    get calls() { return calls; },
  };
}

describe('makeDocCache — getOrFetch', () => {
  it('returns cached content on hit within TTL without calling MCP', async () => {
    const callTool = makeCallTool();
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: makeSnap('cached content', 1000) }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.equal(result, 'cached content');
    assert.equal(callTool.calls, 0);
  });

  it('calls MCP and upserts on cache miss', async () => {
    let upserted = null;
    const firestore = {
      collection: () => ({
        doc: () => ({
          get: async () => missingSnap,
          set: async (data) => { upserted = data; },
        }),
      }),
    };
    const callTool = makeCallTool('fresh data');
    const cache = makeDocCache({ firestore, callTool: callTool.fn, config: makeConfig() });
    const result = await cache.getOrFetch('README.md');
    assert.equal(result, 'fresh data');
    assert.equal(callTool.calls, 1);
    assert.equal(upserted.content, 'fresh data');
  });

  it('treats stale cache as miss and refetches', async () => {
    const callTool = makeCallTool('newer content');
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: makeSnap('old content', TTL_MS + 1) }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.equal(result, 'newer content');
    assert.equal(callTool.calls, 1);
  });

  it('fails open when Firestore read throws', async () => {
    const callTool = makeCallTool('direct content');
    const cache = makeDocCache({
      firestore: makeFirestore({ throwOnGet: true }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.equal(result, 'direct content');
    assert.equal(callTool.calls, 1);
  });

  it('returns content even when Firestore write fails after MCP success', async () => {
    const callTool = makeCallTool('fetched content');
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap, throwOnSet: true }),
      callTool: callTool.fn,
      config: makeConfig(),
    });
    const result = await cache.getOrFetch('README.md');
    assert.equal(result, 'fetched content');
  });
});

describe('makeDocCache — fetchDirect', () => {
  it('always calls MCP and upserts regardless of cache state', async () => {
    let upserted = null;
    const firestore = {
      collection: () => ({
        doc: () => ({
          get: async () => makeSnap('old content', 100),
          set: async (data) => { upserted = data; },
        }),
      }),
    };
    const callTool = makeCallTool('fresh direct');
    const cache = makeDocCache({ firestore, callTool: callTool.fn, config: makeConfig() });
    const result = await cache.fetchDirect('README.md');
    assert.equal(result, 'fresh direct');
    assert.equal(callTool.calls, 1);
    assert.equal(upserted.content, 'fresh direct');
  });
});

describe('wrapCallToolWithCache', () => {
  it('intercepts get_file_contents for any path on GITHUB_REPO and serves from cache', async () => {
    const { wrapCallToolWithCache } = await import('../src/github/docCache.js');
    let mcpCalled = false;
    const rawCallTool = async () => { mcpCalled = true; return [{ type: 'text', text: 'raw' }]; };

    const cache = makeDocCache({
      firestore: makeFirestore({ snap: makeSnap('cached doc', 100) }),
      callTool: rawCallTool,
      config: makeConfig(),
    });

    const wrapped = wrapCallToolWithCache(rawCallTool, cache, makeConfig());
    const result = await wrapped('get_file_contents', { owner: 'owner', repo: 'myrepo', path: 'src/index.js' });
    assert.equal(result[0].text, 'cached doc');
    assert.equal(mcpCalled, false);
  });

  it('intercepts get_file_contents for arbitrary paths on GITHUB_REPO', async () => {
    const { wrapCallToolWithCache } = await import('../src/github/docCache.js');
    let mcpCalled = false;
    const rawCallTool = async () => { mcpCalled = true; return [{ type: 'text', text: 'fetched' }]; };
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap }),
      callTool: rawCallTool,
      config: makeConfig(),
    });
    const wrapped = wrapCallToolWithCache(rawCallTool, cache, makeConfig());
    const result = await wrapped('get_file_contents', { owner: 'owner', repo: 'myrepo', path: 'src/config.js' });
    assert.equal(result[0].text, 'fetched');
    assert.equal(mcpCalled, true, 'MCP called on cache miss');
  });

  it('passes through get_file_contents for different repo', async () => {
    const { wrapCallToolWithCache } = await import('../src/github/docCache.js');
    let mcpCalled = false;
    const rawCallTool = async () => { mcpCalled = true; return [{ type: 'text', text: 'other repo result' }]; };
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap }),
      callTool: rawCallTool,
      config: makeConfig(),
    });
    const wrapped = wrapCallToolWithCache(rawCallTool, cache, makeConfig());
    const result = await wrapped('get_file_contents', { owner: 'other', repo: 'repo', path: 'README.md' });
    assert.equal(mcpCalled, true);
    assert.equal(result[0].text, 'other repo result');
  });

  it('passes through non-file-contents tool calls unchanged', async () => {
    const { wrapCallToolWithCache } = await import('../src/github/docCache.js');
    const rawCallTool = async (name) => [{ type: 'text', text: `result:${name}` }];
    const cache = makeDocCache({
      firestore: makeFirestore({ snap: missingSnap }),
      callTool: rawCallTool,
      config: makeConfig(),
    });
    const wrapped = wrapCallToolWithCache(rawCallTool, cache, makeConfig());
    const result = await wrapped('list_issues', { state: 'open' });
    assert.equal(result[0].text, 'result:list_issues');
  });
});
