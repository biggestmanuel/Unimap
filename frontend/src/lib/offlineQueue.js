/**
 * Thin re-export so components import one obvious name.
 * The implementation lives in offlineCache.js alongside the POI cache.
 */
export {
  queueCorrection,
  listQueued,
  flushQueue,
  estimateUsage,
  requestPersistence,
} from './offlineCache.js';