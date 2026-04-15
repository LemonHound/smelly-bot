import 'dotenv/config';
import { readFileSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { getFirestore } from './firestore.js';
import { makeRateLimit } from './rateLimit.js';
import { loadPrompts } from './llm/prompts.js';
import { makeLlmReply } from './llm/index.js';
import { createMcpClient } from './mcp/client.js';
import { buildSlackApp } from './slack.js';
import { logger } from './logger.js';

const mcpServers = JSON.parse(readFileSync(new URL('../mcp-servers.json', import.meta.url)));

const config = loadConfig();
const firestore = getFirestore(config);
const rateLimit = makeRateLimit({ firestore, config });
const prompts = loadPrompts();
const anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const { tools, callTool } = await createMcpClient(mcpServers);

const reply = makeLlmReply({ config, prompts, rateLimit, anthropicClient, tools, callTool });

const app = await buildSlackApp({ config, reply });
await app.start(config.PORT);
logger.info({ port: config.PORT, toolCount: tools.length }, 'smelly-bot running');
