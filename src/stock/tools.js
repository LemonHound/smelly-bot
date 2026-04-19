import { logger } from '../logger.js';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

const COMMODITY_SYMBOLS = {
  silver: 'SLV',
  gold: 'GLD',
  'crude oil': 'USO',
  oil: 'USO',
  'natural gas': 'UNG',
  copper: 'CPER',
  platinum: 'PPLT',
  palladium: 'PALL',
  bitcoin: 'BINANCE:BTCUSDT',
  btc: 'BINANCE:BTCUSDT',
  ethereum: 'BINANCE:ETHUSDT',
  eth: 'BINANCE:ETHUSDT',
  'us dollar': 'UUP',
  dollar: 'UUP',
  dxy: 'UUP',
};

async function finnhubGet(path, apiKey) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${FINNHUB_BASE}${path}${sep}token=${apiKey}`);
  if (!res.ok) throw new Error(`Finnhub ${res.status} ${res.statusText}`);
  return res.json();
}

async function resolveSymbol(query, apiKey) {
  const normalized = query.trim().toLowerCase();
  if (COMMODITY_SYMBOLS[normalized]) return COMMODITY_SYMBOLS[normalized];
  if (/^[A-Z0-9:=\-\.]{1,20}$/i.test(query.trim())) return query.trim().toUpperCase();
  try {
    const data = await finnhubGet(`/search?q=${encodeURIComponent(query)}`, apiKey);
    const hit = (data.result ?? []).find(r => ['Common Stock', 'ETP', 'ADR', 'Crypto'].includes(r.type));
    return hit?.symbol ?? query.toUpperCase();
  } catch {
    return query.toUpperCase();
  }
}

function formatQuote(symbol, q, name) {
  const price = q.c?.toFixed(2) ?? 'N/A';
  const pct = q.dp != null ? `${q.dp >= 0 ? '+' : ''}${q.dp.toFixed(2)}%` : 'N/A';
  const label = name ?? symbol;
  return `${label} (${symbol}): $${price} (${pct})`;
}

export const GET_STOCK_QUOTE_SCHEMA = {
  name: 'get_stock_quote',
  description: 'Get the current price, daily change, and recent headlines for stocks, ETFs, crypto, or commodities. Accepts ticker symbols (AAPL) or names (Apple, gold, bitcoin). Use when conversation involves prices, investments, or market values.',
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ticker symbols or names, e.g. ["NVDA", "Apple", "gold", "bitcoin"]. Up to 5.',
        minItems: 1,
        maxItems: 5,
      },
      include_news: {
        type: 'boolean',
        description: 'If true, include up to 3 recent news headlines per asset.',
      },
    },
    required: ['queries'],
  },
};

export function makeGetStockQuoteHandler({ config }) {
  return async ({ queries, include_news = false }) => {
    const apiKey = config.FINNHUB_API_KEY;
    if (!apiKey) return 'Stock quotes unavailable: FINNHUB_API_KEY not configured.';

    const results = await Promise.all(
      queries.map(async (query) => {
        const symbol = await resolveSymbol(query, apiKey);
        try {
          const q = await finnhubGet(`/quote?symbol=${encodeURIComponent(symbol)}`, apiKey);
          if (!q.c) return `${symbol}: no data (symbol may be invalid)`;

          let line = formatQuote(symbol, q, null);

          if (include_news) {
            try {
              const today = new Date();
              const from = new Date(today - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
              const to = today.toISOString().slice(0, 10);
              const news = await finnhubGet(`/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`, apiKey);
              const headlines = (news ?? []).slice(0, 3).map(n => `  - ${n.headline}`).join('\n');
              if (headlines) line += `\nRecent news:\n${headlines}`;
            } catch {
              // news is best-effort
            }
          }

          return line;
        } catch (err) {
          logger.warn({ symbol, query, err: err.message }, 'Stock quote failed');
          return `${symbol}: failed to fetch (${err.message})`;
        }
      })
    );

    return results.join('\n\n');
  };
}

export const GET_MARKET_OVERVIEW_SCHEMA = {
  name: 'get_market_overview',
  description: 'Get a snapshot of overall market health: major indices (S&P 500, Nasdaq, Dow), sector ETFs, and top market news. Use when someone asks how the market is doing, what\'s hot, or for general market context.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const INDEX_SYMBOLS = [
  { symbol: 'SPY', label: 'S&P 500 (SPY)' },
  { symbol: 'QQQ', label: 'Nasdaq (QQQ)' },
  { symbol: 'DIA', label: 'Dow Jones (DIA)' },
  { symbol: 'IWM', label: 'Russell 2000 (IWM)' },
  { symbol: 'VIX', label: 'VIX (volatility)' },
];

export function makeGetMarketOverviewHandler({ config }) {
  return async () => {
    const apiKey = config.FINNHUB_API_KEY;
    if (!apiKey) return 'Market overview unavailable: FINNHUB_API_KEY not configured.';

    const parts = [];

    const indexResults = await Promise.all(
      INDEX_SYMBOLS.map(async ({ symbol, label }) => {
        try {
          const q = await finnhubGet(`/quote?symbol=${encodeURIComponent(symbol)}`, apiKey);
          if (!q.c) return `${label}: unavailable`;
          return formatQuote(symbol, q, label.split(' (')[0]);
        } catch {
          return `${label}: unavailable`;
        }
      })
    );
    parts.push('*Major indices:*\n' + indexResults.join('\n'));

    try {
      const news = await finnhubGet('/news?category=general&minId=0', apiKey);
      const headlines = (news ?? []).slice(0, 5).map(n => `  - ${n.headline}`).join('\n');
      if (headlines) parts.push('*Market headlines:*\n' + headlines);
    } catch (err) {
      logger.warn({ err: err.message }, 'Market news fetch failed');
    }

    return parts.join('\n\n') || 'Market data unavailable.';
  };
}
