import yahooFinance from 'yahoo-finance2';
import { logger } from '../logger.js';

export const GET_STOCK_QUOTE_SCHEMA = {
  name: 'get_stock_quote',
  description: 'Get the current stock price, daily change, and recent headlines for one or more ticker symbols. Use when conversation involves stocks, investments, market prices, or company valuations.',
  input_schema: {
    type: 'object',
    properties: {
      tickers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Stock ticker symbols, e.g. ["AAPL", "NVDA"]. Look up the ticker from context if only a company name is given.',
        minItems: 1,
        maxItems: 5,
      },
      include_news: {
        type: 'boolean',
        description: 'If true, include up to 3 recent news headlines per ticker.',
      },
    },
    required: ['tickers'],
  },
};

export function makeGetStockQuoteHandler() {
  return async ({ tickers, include_news = false }) => {
    const results = await Promise.all(
      tickers.map(async (ticker) => {
        try {
          const quote = await yahooFinance.quote(ticker, {}, { validateResult: false });
          const price = quote.regularMarketPrice?.toFixed(2) ?? 'N/A';
          const change = quote.regularMarketChangePercent?.toFixed(2) ?? 'N/A';
          const direction = parseFloat(change) >= 0 ? '+' : '';
          const name = quote.shortName ?? ticker;
          let line = `${name} (${ticker.toUpperCase()}): $${price} (${direction}${change}%)`;

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
          logger.warn({ ticker, err: err.message }, 'Stock quote failed');
          return `${ticker.toUpperCase()}: failed to fetch (${err.message})`;
        }
      })
    );

    return results.join('\n\n');
  };
}
