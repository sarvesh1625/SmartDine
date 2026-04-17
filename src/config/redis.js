const logger = require('../utils/logger');

// Redis is disabled — using in-memory fallback
const memoryCache = new Map();

async function connectRedis() {
  logger.warn('⚠️  Redis disabled — using in-memory cache (restart clears cache)');
}

function getRedis() { return null; }

async function cacheGet(key) {
  try {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      memoryCache.delete(key);
      return null;
    }
    return entry.value;
  } catch { return null; }
}

async function cacheSet(key, value, ttlSeconds = 600) {
  try {
    memoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  } catch {}
}

async function cacheDel(key) {
  try { memoryCache.delete(key); } catch {}
}

async function cacheDelPattern(pattern) {
  try {
    const regex = new RegExp(pattern.replace('*', '.*'));
    for (const key of memoryCache.keys()) {
      if (regex.test(key)) memoryCache.delete(key);
    }
  } catch {}
}

module.exports = { connectRedis, getRedis, cacheGet, cacheSet, cacheDel, cacheDelPattern };