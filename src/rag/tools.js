import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { SearchServiceClient } from '@google-cloud/discoveryengine';
import { Storage } from '@google-cloud/storage';
import { createRequire } from 'module';
const pdfParse = createRequire(import.meta.url)('pdf-parse');
import { logger } from '../logger.js';

const GOOGLE_APPS_EXPORT = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

function makeDriveAuth(config) {
  return new GoogleAuth({
    credentials: JSON.parse(config.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY),
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

function makeStorageClient(config) {
  const credentials = JSON.parse(config.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY);
  return new Storage({ credentials, projectId: config.GOOGLE_CLOUD_PROJECT });
}

async function fetchFromGcs(config, file_id) {
  const bucket = makeStorageClient(config).bucket(config.GCS_RAG_BUCKET);

  let title = file_id;
  try {
    const [buf] = await bucket.file(`${file_id}.pdf.metadata.json`).download();
    title = JSON.parse(buf.toString()).title || file_id;
  } catch {
  }

  const [buffer] = await bucket.file(`${file_id}.pdf`).download();
  const parsed = await pdfParse(buffer);
  logger.info({ fileId: file_id, title, chars: parsed.text.length }, 'RAG full-document fetch complete');
  return [{ type: 'text', text: `# ${title}\n\n${parsed.text}` }];
}

function makeSearchClient(config) {
  const credentials = JSON.parse(config.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY);
  const apiEndpoint = config.VERTEX_AI_LOCATION === 'global'
    ? 'discoveryengine.googleapis.com'
    : `${config.VERTEX_AI_LOCATION}-discoveryengine.googleapis.com`;
  return new SearchServiceClient({ credentials, apiEndpoint });
}

export const SEARCH_DOCUMENTS_SCHEMA = {
  name: 'search_documents',
  description: `Search the document library for information relevant to a question or topic. Use this when the user asks about policies, procedures, recipes, articles, guides, or any content that may be stored in the document corpus. Returns relevant text chunks and the source document ID for each. Do NOT use this for fetching a specific named file or performing file system operations.`,
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language query describing the information you are looking for.',
      },
    },
    required: ['query'],
  },
};

export const GET_DOCUMENT_CONTENT_SCHEMA = {
  name: 'get_document_content',
  description: `Fetch the full text content of a specific document from the document library by its Drive file ID. Use this after search_documents identifies a relevant document and you need the complete text rather than just the retrieved chunk — for example, when a recipe chunk is missing the full ingredient list, or when a guide chunk lacks the surrounding steps. Pass the source_id returned by search_documents.`,
  input_schema: {
    type: 'object',
    properties: {
      file_id: {
        type: 'string',
        description: 'Google Drive file ID from the source_id field of a search_documents result.',
      },
    },
    required: ['file_id'],
  },
};

export function makeSearchDocumentsHandler({ config }) {
  return async ({ query }) => {
    if (!config.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY || !config.VERTEX_AI_DATASTORE_ID) {
      return [{ type: 'text', text: 'Document search is not configured.' }];
    }

    const searchClient = makeSearchClient(config);

    const servingConfig = `projects/${config.GOOGLE_CLOUD_PROJECT}/locations/${config.VERTEX_AI_LOCATION}/collections/default_collection/engines/${config.VERTEX_AI_ENGINE_ID}/servingConfigs/default_config`;

    logger.info({ query }, 'RAG search started');

    const [hits] = await searchClient.search(
      {
        servingConfig,
        query,
        pageSize: 5,
        contentSearchSpec: {
          snippetSpec: { returnSnippet: true, maxSnippetCount: 2 },
        },
      },
      { autoPaginate: false }
    );

    const results = (hits ?? []).map(result => {
      const doc = result.document;
      const fields = doc?.derivedStructData?.fields ?? {};

      const link = fields.link?.stringValue ?? '';
      const driveFileId = link.split('/').pop()?.replace(/\.[^.]+$/, '') ?? doc?.id ?? '';
      const title = fields.title?.stringValue || driveFileId || 'Unknown';

      const snippetValues = fields.snippets?.listValue?.values ?? [];
      const snippet = snippetValues
        .map(v => v?.structValue?.fields?.snippet?.stringValue)
        .find(s => s && !s.startsWith('No snippet'));

      const excerpt = snippet ?? null;

      return { title, source_id: driveFileId, excerpt };
    });

    logger.info({ query, resultCount: results.length }, 'RAG search complete');

    if (results.length === 0) {
      return [{ type: 'text', text: 'No relevant documents found in the corpus.' }];
    }

    const text = results
      .map((r, i) => `[${i + 1}] "${r.title}" (source_id: ${r.source_id})${r.excerpt ? `\n${r.excerpt}` : ''}`)
      .join('\n\n');

    return [{ type: 'text', text }];
  };
}

export function makeGetDocumentContentHandler({ config }) {
  return async ({ file_id }) => {
    if (!config.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY) {
      return [{ type: 'text', text: 'Document retrieval is not configured.' }];
    }

    const auth = makeDriveAuth(config);
    const drive = google.drive({ version: 'v3', auth });

    logger.info({ fileId: file_id }, 'RAG full-document fetch started');

    let name, mimeType;
    try {
      const meta = await drive.files.get({ fileId: file_id, fields: 'name,mimeType' });
      name = meta.data.name;
      mimeType = meta.data.mimeType;
    } catch (err) {
      logger.info({ fileId: file_id }, 'RAG drive metadata not found, trying GCS fallback');
      try {
        return await fetchFromGcs(config, file_id);
      } catch (gcsErr) {
        logger.warn({ fileId: file_id, err: gcsErr.message }, 'RAG full-document fetch: both Drive and GCS failed');
        return [{ type: 'text', text: `Could not retrieve document with id "${file_id}".` }];
      }
    }

    try {
      const exportMime = GOOGLE_APPS_EXPORT[mimeType];
      let content;

      if (exportMime) {
        const res = await drive.files.export(
          { fileId: file_id, mimeType: exportMime },
          { responseType: 'text' }
        );
        content = res.data;
      } else if (mimeType === 'application/pdf') {
        const res = await drive.files.get(
          { fileId: file_id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const parsed = await pdfParse(Buffer.from(res.data));
        content = parsed.text;
      } else {
        const res = await drive.files.get(
          { fileId: file_id, alt: 'media' },
          { responseType: 'text' }
        );
        content = res.data;
      }

      logger.info({ fileId: file_id, name, chars: content?.length ?? 0 }, 'RAG full-document fetch complete');
      return [{ type: 'text', text: `# ${name}\n\n${content}` }];
    } catch (err) {
      logger.warn({ fileId: file_id, name, err: err.message }, 'RAG full-document fetch: content failed');
      return [{ type: 'text', text: `Could not read content of "${name}".` }];
    }
  };
}
