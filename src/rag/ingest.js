import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { Storage } from '@google-cloud/storage';
import { logger } from '../logger.js';

const GOOGLE_APPS_EXPORT = {
  'application/vnd.google-apps.document': { mimeType: 'text/plain', ext: 'txt' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv', ext: 'csv' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain', ext: 'txt' },
};

const SUPPORTED_MIME_TYPES = new Set([
  'text/plain', 'text/html', 'text/csv', 'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function makeAuth(config) {
  return new GoogleAuth({
    credentials: JSON.parse(config.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY),
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
}

async function listAllFiles(drive, rootFolderId) {
  const files = [];
  const folderQueue = [rootFolderId];

  while (folderQueue.length > 0) {
    const folderId = folderQueue.shift();
    let pageToken = null;

    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 200,
        pageToken: pageToken ?? undefined,
      });

      for (const item of res.data.files ?? []) {
        if (item.mimeType === FOLDER_MIME) {
          folderQueue.push(item.id);
        } else {
          files.push(item);
        }
      }

      pageToken = res.data.nextPageToken ?? null;
    } while (pageToken);
  }

  return files;
}

async function fetchContent(drive, file) {
  const exported = GOOGLE_APPS_EXPORT[file.mimeType];
  if (exported) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: exported.mimeType },
      { responseType: 'arraybuffer' }
    );
    return { bytes: Buffer.from(res.data), mimeType: exported.mimeType, ext: exported.ext };
  }

  if (SUPPORTED_MIME_TYPES.has(file.mimeType)) {
    const res = await drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const ext = file.mimeType === 'application/pdf' ? 'pdf' : 'txt';
    return { bytes: Buffer.from(res.data), mimeType: file.mimeType, ext };
  }

  return null;
}

export async function runIngestion(config) {
  if (!config.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY || !config.GOOGLE_DRIVE_FOLDER_ID || !config.GCS_RAG_BUCKET) {
    throw new Error('RAG ingestion requires GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY, GOOGLE_DRIVE_FOLDER_ID, and GCS_RAG_BUCKET');
  }

  const auth = makeAuth(config);
  const drive = google.drive({ version: 'v3', auth });
  const storage = new Storage({ authClient: auth });
  const bucket = storage.bucket(config.GCS_RAG_BUCKET);

  logger.info({ folderId: config.GOOGLE_DRIVE_FOLDER_ID }, 'RAG ingestion: scanning Drive folder recursively');
  const files = await listAllFiles(drive, config.GOOGLE_DRIVE_FOLDER_ID);
  logger.info({ count: files.length }, 'RAG ingestion: files found');

  const stats = { upserted: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (i > 0 && i % 50 === 0) {
      logger.info({ progress: `${i}/${files.length}`, ...stats }, 'RAG ingestion: progress');
    }

    try {
      const fetched = await fetchContent(drive, file);
      if (!fetched) {
        logger.debug({ fileId: file.id, name: file.name, mimeType: file.mimeType }, 'RAG ingestion: skipping unsupported type');
        stats.skipped++;
        continue;
      }

      const objectName = `${file.id}.${fetched.ext}`;

      await bucket.file(objectName).save(fetched.bytes, { contentType: fetched.mimeType });
      await bucket.file(`${objectName}.metadata.json`).save(
        JSON.stringify({ title: file.name, driveFileId: file.id }),
        { contentType: 'application/json' }
      );

      logger.info({ fileId: file.id, name: file.name, objectName }, 'RAG ingestion: uploaded');
      stats.upserted++;
    } catch (err) {
      logger.error({ fileId: file.id, name: file.name, err: err.message }, 'RAG ingestion: upload failed');
      stats.errors++;
    }
  }

  logger.info(stats, 'RAG ingestion complete');
  return stats;
}

export async function removeFromCorpus(config, driveFileIds) {
  const auth = makeAuth(config);
  const storage = new Storage({ authClient: auth });
  const bucket = storage.bucket(config.GCS_RAG_BUCKET);

  for (const fileId of driveFileIds) {
    for (const ext of ['txt', 'pdf', 'csv']) {
      const name = `${fileId}.${ext}`;
      await bucket.file(name).delete({ ignoreNotFound: true });
      await bucket.file(`${name}.metadata.json`).delete({ ignoreNotFound: true });
    }
    logger.info({ fileId }, 'RAG ingestion: removed from corpus');
  }
}
