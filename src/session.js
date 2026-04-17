import { logger } from './logger.js';

const COLLECTION = 'activeSessions';

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
