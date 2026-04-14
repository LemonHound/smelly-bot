import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { getFirestore } from './firestore.js';
import { makeRateLimit } from './rateLimit.js';
import { loadPrompts } from './llm/prompts.js';
import { makeLlmReply } from './llm/index.js';
import { buildSlackApp } from './slack.js';

const config = loadConfig();
const firestore = getFirestore(config);
const rateLimit = makeRateLimit({ firestore, config });
const prompts = loadPrompts();
const anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const reply = makeLlmReply({ config, prompts, rateLimit, anthropicClient });

const app = buildSlackApp({ config, reply });
await app.start(config.PORT);
console.log('smelly-bot running (socket mode)');
