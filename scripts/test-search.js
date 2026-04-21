import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { makeSearchDocumentsHandler } from '../src/rag/tools.js';

const config = loadConfig();
const search = makeSearchDocumentsHandler({ config });

const query = process.argv[2] ?? 'chocolate chip cookies';
console.log(`Query: "${query}"\n`);

const result = await search({ query });
console.log(result[0].text);
