import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { runIngestion } from '../src/rag/ingest.js';

const config = loadConfig();
const stats = await runIngestion(config);
console.log('Done:', stats);
