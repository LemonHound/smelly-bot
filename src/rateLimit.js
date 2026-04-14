const DOC_PATH = 'rate_limits/global';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function makeRateLimit({ firestore, config }) {
  const hourlyLimit = config.RATE_LIMIT_PER_HOUR;
  const dailyLimit = config.RATE_LIMIT_PER_DAY;
  const ref = firestore.doc(DOC_PATH);

  async function tryConsume() {
    return firestore.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : {};
      const now = Date.now();

      const hourlyStart = data.hourly_window_start ?? 0;
      const dailyStart = data.daily_window_start ?? 0;
      const hourlyCount = (now - hourlyStart < HOUR_MS) ? (data.hourly_count ?? 0) : 0;
      const dailyCount = (now - dailyStart < DAY_MS) ? (data.daily_count ?? 0) : 0;

      if (hourlyCount >= hourlyLimit) {
        return { ok: false, retryAfterMs: HOUR_MS - (now - hourlyStart) };
      }
      if (dailyCount >= dailyLimit) {
        return { ok: false, retryAfterMs: DAY_MS - (now - dailyStart) };
      }

      tx.set(ref, {
        hourly_count: hourlyCount + 1,
        hourly_window_start: hourlyCount === 0 ? now : hourlyStart,
        daily_count: dailyCount + 1,
        daily_window_start: dailyCount === 0 ? now : dailyStart,
      });

      return { ok: true };
    });
  }

  return { tryConsume };
}
