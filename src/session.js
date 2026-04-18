import { logger } from './logger.js';

const COLLECTION = 'activeSessions';
const WILDCARD_COLLECTION = 'wildcardChannels';

export function makeSessionStore({ firestore, config }) {
  const ttlMs = config.SESSION_TTL_MS;

  function docRef(threadTs) {
    return firestore.collection(COLLECTION).doc(threadTs.replace('.', '_'));
  }

  async function touch(threadTs) {
    try {
      await docRef(threadTs).set({
        threadTs,
        expiresAt: new Date(Date.now() + ttlMs),
      });
      logger.debug({ threadTs }, 'Session touched');
    } catch (err) {
      logger.warn({ threadTs, err: err.message }, 'Failed to touch session');
    }
  }

  async function isActive(threadTs) {
    try {
      const snap = await docRef(threadTs).get();
      if (!snap.exists) return false;
      const { expiresAt } = snap.data();
      const ms = expiresAt?.toMillis ? expiresAt.toMillis() : (expiresAt instanceof Date ? expiresAt.getTime() : 0);
      return Date.now() < ms;
    } catch (err) {
      logger.warn({ threadTs, err: err.message }, 'Failed to check session, treating as inactive');
      return false;
    }
  }

  async function remove(threadTs) {
    try {
      await docRef(threadTs).delete();
    } catch (err) {
      logger.warn({ threadTs, err: err.message }, 'Failed to remove session');
    }
  }

  return { touch, isActive, remove };
}

export function makeWildcardStore({ firestore, config }) {
  function docRef(channelId) {
    return firestore.collection(WILDCARD_COLLECTION).doc(channelId);
  }

  async function shouldFire(channelId) {
    try {
      const snap = await docRef(channelId).get();
      const now = Date.now();

      if (!snap.exists) {
        await docRef(channelId).set({ lastFiredAt: new Date(now) });
        return false;
      }

      const { lastFiredAt } = snap.data();
      const lastMs = lastFiredAt?.toMillis?.() ?? (lastFiredAt instanceof Date ? lastFiredAt.getTime() : 0);

      if (now - lastMs < config.WILDCARD_COOLDOWN_MS) return false;
      if (Math.random() >= config.WILDCARD_PROBABILITY) return false;

      await docRef(channelId).set({ lastFiredAt: new Date(now) });
      logger.info({ channelId }, 'Wildcard fired');
      return true;
    } catch (err) {
      logger.warn({ channelId, err: err.message }, 'Wildcard check failed');
      return false;
    }
  }

  return { shouldFire };
}
