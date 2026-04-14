import 'dotenv/config';
import { loadConfig } from './config.js';
import { getFirestore } from './firestore.js';
import { makeRateLimit } from './rateLimit.js';
import { loadPrompts } from './llm/prompts.js';
import { buildSlackApp } from './slack.js';

const RESPONSES = ['fart', ':dash:', ':cloud:', 'pfffbbbt'];

const config = loadConfig();
const firestore = getFirestore(config);
const rateLimit = makeRateLimit({ firestore, config });
const prompts = loadPrompts();

const reply = () => RESPONSES[Math.floor(Math.random() * RESPONSES.length)];

const app = buildSlackApp({ config, reply });
await app.start(config.PORT);
console.log('smelly-bot running (socket mode)');
