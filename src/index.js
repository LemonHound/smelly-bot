import 'dotenv/config';
import { readFileSync } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { getFirestore } from './firestore.js';
import { makeRateLimit } from './rateLimit.js';
import { loadPrompts } from './llm/prompts.js';
import { makeLlmReply } from './llm/index.js';
import { createMcpClient } from './mcp/client.js';
import { makeDocCache, wrapCallToolWithCache } from './github/docCache.js';
import { REFRESH_REPO_DOC_SCHEMA, makeRefreshRepoDocHandler } from './github/tools.js';
import { CREATE_CALENDAR_EVENT_SCHEMA, makeCreateCalendarEventHandler } from './calendar/tools.js';
import { GET_STOCK_QUOTE_SCHEMA, makeGetStockQuoteHandler, GET_MARKET_OVERVIEW_SCHEMA, makeGetMarketOverviewHandler } from './stock/tools.js';
import { makeSessionStore, makeWildcardStore } from './session.js';
import { makeEngagementCheck } from './engage.js';
import { makeAnalyticsStore } from './analytics.js';
import { buildSlackApp } from './slack.js';
import { logger } from './logger.js';

const mcpServers = JSON.parse(readFileSync(new URL('../mcp-servers.json', import.meta.url)));

const config = loadConfig();
const firestore = getFirestore(config);
const rateLimit = makeRateLimit({ firestore, config });
const prompts = loadPrompts();
const anthropicClient = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
const sessionStore = makeSessionStore({ firestore, config });
const wildcardStore = makeWildcardStore({ firestore, config });
const checkEngagement = makeEngagementCheck({ anthropicClient, config });
const analyticsStore = makeAnalyticsStore({ firestore });

const slackClientRef = { client: null };

let docCache = null;

const localTools = [
  {
    ...REFRESH_REPO_DOC_SCHEMA,
    handler: async (args) => makeRefreshRepoDocHandler({ docCache })(args),
  },
  {
    ...CREATE_CALENDAR_EVENT_SCHEMA,
    handler: makeCreateCalendarEventHandler({ slackClientRef, config }),
  },
  {
    ...GET_STOCK_QUOTE_SCHEMA,
    handler: makeGetStockQuoteHandler({ config }),
  },
  {
    ...GET_MARKET_OVERVIEW_SCHEMA,
    handler: makeGetMarketOverviewHandler({ config }),
  },
];

const { tools, callTool: rawCallTool, toolsByServer } = await createMcpClient(mcpServers, localTools);

docCache = makeDocCache({ firestore, callTool: rawCallTool, config });

const callTool = wrapCallToolWithCache(rawCallTool, docCache, config);

const reply = makeLlmReply({ config, prompts, rateLimit, anthropicClient, tools, callTool });

const app = await buildSlackApp({ config, reply, toolsByServer, sessionStore, wildcardStore, checkEngagement, analyticsStore });
slackClientRef.client = app.client;
await app.start(config.PORT);
logger.info({ port: config.PORT, toolCount: tools.length }, 'smelly-bot running');
