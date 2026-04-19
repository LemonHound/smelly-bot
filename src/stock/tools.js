import yahooFinance from 'yahoo-finance2';
import { logger } from '../logger.js';

const COMMODITY_TICKERS = {
  silver: 'SI=F',
  gold: 'GC=F',
  'crude oil': 'CL=F',
  oil: 'CL=F',
  'natural gas': 'NG=F',
  copper: 'HG=F',
  platinum: 'PL=F',
  palladium: 'PA=F',
  bitcoin: 'BTC-USD',
  btc: 'BTC-USD',
  ethereum: 'ETH-USD',
  eth: 'ETH-USD',
  'us dollar': 'DX-Y.NYB',
  dollar: 'DX-Y.NYB',
  dxy: 'DX-Y.NYB',
};

async function resolveTicker(query) {
  const normalized = query.trim().toLowerCase();
  if (COMMODITY_TICKERS[normalized]) return COMMODITY_TICKERS[normalized];
  if (/^[A-Z0-9=\-\.]{1,10}$/i.test(query.trim())) return query.trim().toUpperCase();
  try {
    const result = await yahooFinance.search(query, { quotesCount: 3, newsCount: 0 }, { validateResult: false });
    const hit = result.quotes?.find(q => ['EQUITY', 'ETF', 'FUTURE', 'CRYPTOCURRENCY', 'INDEX'].includes(q.quoteType));
    return hit?.symbol ?? query.toUpperCase();
  } catch {
    return query.toUpperCase();
  }
}

export const GET_STOCK_QUOTE_SCHEMA = {
  name: 'get_stock_quote',
  description: 'Get the current stock price, daily change, and recent headlines for one or more stocks. Accepts ticker symbols (AAPL) or company names (Apple). Use when conversation involves stocks, investments, market prices, or company valuations.',
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ticker symbols or company names, e.g. ["NVDA", "Apple", "Tesla"]. Up to 5.',
        minItems: 1,
        maxItems: 5,
      },
      include_news: {
        type: 'boolean',
        description: 'If true, include up to 3 recent news headlines per stock.',
      },
    },
    required: ['queries'],
  },
};

export function makeGetStockQuoteHandler() {
  return async ({ queries, include_news = false }) => {
    const results = await Promise.all(
      queries.map(async (query) => {
        const ticker = await resolveTicker(query);
        try {
          const quote = await yahooFinance.quote(ticker, {}, { validateResult: false });
          const price = quote.regularMarketPrice?.toFixed(2) ?? 'N/A';
          const change = quote.regularMarketChangePercent?.toFixed(2) ?? 'N/A';
          const direction = parseFloat(change) >= 0 ? '+' : '';
          const name = quote.shortName ?? ticker;
          let line = `${name} (${ticker}): $${price} (${direction}${change}%)`;

          if (include_news) {
            try {
              const search = await yahooFinance.search(ticker, { newsCount: 3 }, { validateResult: false });
              const headlines = (search.news ?? []).slice(0, 3).map(n => `  - ${n.title}`).join('\n');
              if (headlines) line += `\nRecent news:\n${headlines}`;
            } catch {
              // news fetch is best-effort
            }
          }

          return line;
        } catch (err) {
          logger.warn({ ticker, query, err: err.message }, 'Stock quote failed');
          return `${ticker}: failed to fetch (${err.message})`;
        }
      })
    );

    return results.join('\n\n');
  };
}

export const GET_MARKET_OVERVIEW_SCHEMA = {
  name: 'get_market_overview',
  description: 'Get a snapshot of overall market health: major indices (S&P 500, Nasdaq, Dow), trending stocks, and biggest movers. Use when someone asks how the market is doing, what\'s hot, or for general market context before discussing specific stocks.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export function makeGetMarketOverviewHandler() {
  return async () => {
    const parts = [];

    try {
      const summary = await yahooFinance.quoteSummary('^GSPC', { modules: ['price'] }, { validateResult: false });
      const sp = summary.price;
      const spChange = sp?.regularMarketChangePercent?.toFixed(2) ?? 'N/A';
      const spDir = parseFloat(spChange) >= 0 ? '+' : '';

      const indices = ['^GSPC', '^IXIC', '^DJI'];
      const indexNames = { '^GSPC': 'S&P 500', '^IXIC': 'Nasdaq', '^DJI': 'Dow Jones' };
      const indexLines = await Promise.all(
        indices.map(async (sym) => {
          try {
            const q = await yahooFinance.quote(sym, {}, { validateResult: false });
            const chg = q.regularMarketChangePercent?.toFixed(2) ?? 'N/A';
            const dir = parseFloat(chg) >= 0 ? '+' : '';
            return `${indexNames[sym]}: ${q.regularMarketPrice?.toFixed(2)} (${dir}${chg}%)`;
          } catch {
            return `${indexNames[sym]}: unavailable`;
          }
        })
      );
      parts.push('*Major indices:*\n' + indexLines.join('\n'));
    } catch (err) {
      logger.warn({ err: err.message }, 'Market index fetch failed');
      parts.push('Major indices: unavailable');
    }

    try {
      const trending = await yahooFinance.trendingSymbols('US', { count: 5 }, { validateResult: false });
      const symbols = (trending.quotes ?? []).slice(0, 5).map(q => q.symbol);
      if (symbols.length > 0) {
        const quotes = await Promise.all(
          symbols.map(async (sym) => {
            try {
              const q = await yahooFinance.quote(sym, {}, { validateResult: false });
              const chg = q.regularMarketChangePercent?.toFixed(2) ?? 'N/A';
              const dir = parseFloat(chg) >= 0 ? '+' : '';
              return `${q.shortName ?? sym} (${sym}): $${q.regularMarketPrice?.toFixed(2)} (${dir}${chg}%)`;
            } catch {
              return `${sym}: unavailable`;
            }
          })
        );
        parts.push('*Trending today:*\n' + quotes.join('\n'));
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Trending fetch failed');
    }

    return parts.join('\n\n') || 'Market data unavailable.';
  };
}
