import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_DOC_PATHS, REFRESH_REPO_DOC_SCHEMA, makeRefreshRepoDocHandler } from '../src/github/tools.js';

describe('KNOWN_DOC_PATHS', () => {
  it('contains the three expected paths', () => {
    assert.ok(KNOWN_DOC_PATHS.includes('README.md'));
    assert.ok(KNOWN_DOC_PATHS.includes('CONTRIBUTING.md'));
    assert.ok(KNOWN_DOC_PATHS.includes('ADR.md'));
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(KNOWN_DOC_PATHS));
  });
});

describe('makeRefreshRepoDocHandler', () => {
  it('calls fetchDirect and returns content as tool result', async () => {
    const docCache = {
      fetchDirect: async (path) => `content of ${path}`,
    };
    const handler = makeRefreshRepoDocHandler({ docCache });
    const result = await handler({ path: 'README.md' });
    assert.deepEqual(result, [{ type: 'text', text: 'content of README.md' }]);
  });

  it('propagates errors from fetchDirect', async () => {
    const docCache = {
      fetchDirect: async () => { throw new Error('MCP unreachable'); },
    };
    const handler = makeRefreshRepoDocHandler({ docCache });
    await assert.rejects(() => handler({ path: 'README.md' }), /MCP unreachable/);
  });
});

describe('REFRESH_REPO_DOC_SCHEMA', () => {
  it('has correct name and required path field', () => {
    assert.equal(REFRESH_REPO_DOC_SCHEMA.name, 'refresh_repo_doc');
    assert.ok(REFRESH_REPO_DOC_SCHEMA.input_schema.required.includes('path'));
  });
});
