import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { DocumentServiceClient } from '@google-cloud/discoveryengine';

const config = loadConfig();

const credentials = JSON.parse(config.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY);
const apiEndpoint = config.VERTEX_AI_LOCATION === 'global'
  ? 'discoveryengine.googleapis.com'
  : `${config.VERTEX_AI_LOCATION}-discoveryengine.googleapis.com`;
const docClient = new DocumentServiceClient({ credentials, apiEndpoint });

const parent = `projects/${config.GOOGLE_CLOUD_PROJECT}/locations/${config.VERTEX_AI_LOCATION}/collections/default_collection/dataStores/${config.VERTEX_AI_DATASTORE_ID}/branches/default_branch`;

const [operation] = await docClient.importDocuments({
  parent,
  gcsSource: {
    inputUris: [
      `gs://${config.GCS_RAG_BUCKET}/*.pdf`,
    ],
    dataSchema: 'content',
  },
  reconciliationMode: 'INCREMENTAL',
});

console.log('Import operation started:', operation.name);
console.log('Check status in the Vertex AI Search console under Activity.');
