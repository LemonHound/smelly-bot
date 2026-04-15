export const REFRESH_REPO_DOC_SCHEMA = {
  name: 'refresh_repo_doc',
  description: 'Force a fresh fetch of a repo documentation file, bypassing the local cache. Use when the user asks about recent changes or when the cached content may be stale.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path within the target repo, e.g. README.md',
      },
    },
    required: ['path'],
  },
};

export function makeRefreshRepoDocHandler({ docCache }) {
  return async ({ path }) => {
    const text = await docCache.fetchDirect(path);
    return [{ type: 'text', text }];
  };
}
