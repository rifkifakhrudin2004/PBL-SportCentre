import redisClient, { ensureConnection, KEYS, NAMESPACE } from '../config/services/redis';
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// Waktu TTL default yang lebih rendah untuk responsivitas
const DEFAULT_TTL = Number(process.env.CACHE_TTL || 30); // 30 detik (lebih responsif)

// Daftar endpoint yang memerlukan data terbaru
const DYNAMIC_ENDPOINTS = [
  'branch',
  'field',
  'booking',
  'payment',
  'notification',
  'dashboard',
  'stats',
  'reports',
];

/**
 * Helpers untuk membuat kunci cache yang sesuai dengan namespace sistem
 */
export const CACHE_KEYS = {
  getFieldKey: (fieldId: string) => `${KEYS.CACHE.FIELD}${fieldId}`,
  getBranchKey: (branchId: string) => `${KEYS.CACHE.BRANCH}${branchId}`,
  getUserKey: (userId: string) => `${KEYS.CACHE.USER}${userId}`,
  getBookingKey: (bookingId: string) => `${KEYS.CACHE.BOOKING}${bookingId}`,
  getPaymentKey: (paymentId: string) => `${KEYS.CACHE.PAYMENT}${paymentId}`,
  
  // Untuk cache API yang spesifik
  getApiKey: (prefix: string, method: string, url: string, version: string) => {

    // const cleanUrl = url.split('?')[0];
    // return `${NAMESPACE.PREFIX}:api:${prefix}:${method}:${cleanUrl}:${version}`;
    const hash = crypto.createHash('md5').update(url).digest('hex');
    return `${NAMESPACE.PREFIX}:api:${prefix}:${method}:${hash}:${version}`;
  }
};

/**
 * Fungsi untuk mengatur header cache control sesuai jenis endpoint
 * @param req Request object
 * @param res Response object
 */
export const setCacheControlHeaders = (req: Request, res: Response): void => {
  const url = req.originalUrl?.toLowerCase() || '';

  // Untuk endpoint dinamis, cache hanya 2 detik
  if (DYNAMIC_ENDPOINTS.some((endpoint) => url.includes(endpoint))) {
    res.setHeader('Cache-Control', 'public, max-age=2');
  } else {
    // Untuk endpoint statis yang jarang berubah, izinkan cache lebih lama
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=1800');
  }

  // Tambahkan Vary header untuk mencegah berbagi cache antar pengguna berbeda
  res.setHeader('Vary', 'Accept, Authorization');
};

/**
 * Get data from cache
 * @param key Cache key
 */
export const getCachedData = async <T>(key: string): Promise<T | undefined> => {
  try {
    const data = await ensureConnection.get(key);
    console.log(`[CACHE] Get: ${key} - ${data ? 'HIT' : 'MISS'}`);
    return data ? (JSON.parse(data) as T) : undefined;
  } catch (error) {
    console.error('[CACHE ERROR] Error getting data from Redis cache:', error);
    return undefined;
  }
};

/**
 * Store data in cache
 * @param key Cache key
 * @param data Data to be stored
 * @param ttl Time-to-live in seconds, defaults to configuration TTL
 */
export const setCachedData = async <T>(key: string, data: T, ttl?: number): Promise<boolean> => {
  try {
    const serializedData = JSON.stringify(data);
    const expiryTime = ttl || DEFAULT_TTL;

    // Set dengan expiry menggunakan ensureConnection
    await ensureConnection.setEx(key, expiryTime, serializedData);
    console.log(`[CACHE] Set: ${key} - TTL: ${expiryTime}s`);
    return true;
  } catch (error) {
    console.error('[CACHE ERROR] Error setting data in Redis cache:', error);
    return false;
  }
};

/**
 * Delete data from cache
 * @param key Cache key
 */
export const deleteCachedData = async (key: string): Promise<number> => {
  try {
    const result = await ensureConnection.del(key);
    console.log(`[CACHE] Delete: ${key} - Result: ${result}`);
    return result;
  } catch (error) {
    console.error('[CACHE ERROR] Error deleting data from Redis cache:', error);
    return 0;
  }
};

/**
 * Delete data from cache by pattern - optimized version
 * @param pattern Pattern of keys to delete
 * @param verbose Whether to log detailed information
 */
export const deleteCachedDataByPattern = async (
  pattern: string,
  verbose: boolean = false
): Promise<number> => {
  try {
    // Use ensureConnection instead of direct redisClient access
    const actualPattern = pattern === '' ? '*' : `*${pattern}*`;
    let cursor = 0;
    const keysToDelete: string[] = [];

    // Use the scan method through the wrapper
    do {
      // Use a type-safe approach for scanning
      const scanResult = await ensureConnection.scan(cursor, actualPattern, 100);
      cursor = scanResult.cursor;
      
      if (scanResult.keys.length > 0) {
        keysToDelete.push(...scanResult.keys);
      }
    } while (cursor !== 0);

    // Hapus keys yang ditemukan (tanpa duplikat)
    const uniqueKeys = [...new Set(keysToDelete)];
    let deletedCount = 0;

    if (uniqueKeys.length > 0) {
      // Delete keys one by one to avoid type issues
      for (const key of uniqueKeys) {
        const result = await ensureConnection.del(key);
        deletedCount += result;
      }
      
      if (verbose) {
        console.log(`[CACHE] Delete by pattern: ${pattern} - Deleted ${deletedCount} keys`);
        console.log('[CACHE] Deleted keys:', uniqueKeys);
      } else {
        console.log(`[CACHE] Delete by pattern: ${pattern} - Deleted ${deletedCount} keys`);
      }
    } else if (verbose) {
      console.log(`[CACHE] No keys found for pattern: ${pattern}`);
    }

    return deletedCount;
  } catch (error) {
    console.error('[CACHE ERROR] Error deleting data by pattern from Redis cache:', error);
    return 0;
  }
};

/**
 * Clear entire cache
 */
export const clearCache = async (): Promise<void> => {
  try {
    // Use ensureConnection instead of direct redisClient access
    await ensureConnection.flushAll();
    console.log('[CACHE] Clear all cache');
  } catch (error) {
    console.error('[CACHE ERROR] Error clearing Redis cache:', error);
  }
};

/**
 * Middleware function for API caching implementation with improved invalidation
 * @param keyPrefix Key prefix for the cache
 * @param ttl Time-to-live in seconds
 */
export const cacheMiddleware = (keyPrefix: string, ttl?: number) => {
  // Gunakan TTL yang lebih rendah untuk semua endpoint
  const cacheTTL = ttl || DEFAULT_TTL; // Default 30 detik jika tidak diatur

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Atur header cache control sesuai jenis endpoint
      setCacheControlHeaders(req, res);

      // Skip cache completely if DISABLE_CACHE query param exists
      if (req.query.noCache === 'true' || req.query.refresh === 'true') {
        console.log(`[CACHE] Cache disabled via query param for: ${req.originalUrl}`);
        next();
        return;
      }

      // Skip cache untuk metode mutasi (POST, PUT, DELETE, PATCH)
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        console.log(`[CACHE] Skipping cache for mutating method: ${req.method}`);
        next();
        return;
      }

      // Tambahkan timestamp ke key cache untuk mendukung versioning
      const timestamp = Math.floor(Date.now() / (cacheTTL * 1000)); // Versi cache berdasarkan TTL
      const key = CACHE_KEYS.getApiKey(keyPrefix, req.method, req.originalUrl, `v${timestamp}`);

      // Check if data exists in cache
      const cachedData = await getCachedData<any>(key);

      if (cachedData) {
        // Hitung ETag berdasarkan konten data dengan MD5
        const etag = `W/"${crypto.createHash('md5').update(JSON.stringify(cachedData)).digest('hex')}"`;
        res.setHeader('ETag', etag);

        // Periksa If-None-Match untuk validasi cache
        const clientEtag = req.headers['if-none-match'];
        if (clientEtag === etag) {
          // Data tidak berubah, kirim 304 Not Modified
          console.log(`[CACHE] ETag match, sending 304 Not Modified: ${key}`);
          res.status(304).end();
          return;
        }

        // Log hit ratio untuk monitoring
        console.log(`[CACHE] Serving from cache: ${key}`);

        // Add cache header for transparency
        res.set('X-Cache', 'HIT');
        res.send(cachedData);
        return;
      }

      // Add cache header for transparency
      res.set('X-Cache', 'MISS');

      // Override res.send method to cache response before sending
      const originalSend = res.send;
      res.send = function (body): Response {
        // Don't cache error responses
        if (res.statusCode >= 400) {
          console.log(`[CACHE] Not caching error response: ${res.statusCode} - ${key}`);
          return originalSend.call(this, body);
        }

        // Cache the response
        const responseBody = body;
        setCachedData(key, responseBody, cacheTTL)
          .catch((err) => console.error('[CACHE ERROR] Failed to cache response:', err));

        // Hitung ETag dan tambahkan ke header
        const etag = `W/"${crypto.createHash('md5').update(JSON.stringify(responseBody)).digest('hex')}"`;
        res.setHeader('ETag', etag);

        // Send the original response
        return originalSend.call(this, body);
      };

      next();
    } catch (error) {
      console.error('[CACHE ERROR] Error in cache middleware:', error);
      next();
    }
  };
};

/**
 * Middleware to clear cache for a specific pattern after mutating operations
 * @param pattern Pattern to use for clearing cache
 */
export const clearCacheMiddleware = (pattern: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only clear cache after successful operations
    const originalSend = res.send;
    res.send = function (body) {
      if (res.statusCode < 400) {
        deleteCachedDataByPattern(pattern)
          .then((count) => console.log(`[CACHE] Cleared ${count} cached items with pattern: ${pattern}`))
          .catch((err) => console.error('[CACHE ERROR] Failed to clear cache:', err));
      }
      return originalSend.call(this, body);
    };
    next();
  };
};

// Fungsi untuk mendapatkan statistik Redis
export const getCacheStats = async (): Promise<{
  keys: number;
  hits: number;
  misses: number;
  memory: string;
  clients: number;
  connected: boolean;
}> => {
  try {
    // Use ensureConnection to check connection status
    const isConnected = await ensureConnection.isConnected();
    
    if (!isConnected) {
      return {
        keys: 0,
        hits: 0,
        misses: 0,
        memory: '0 bytes',
        clients: 0,
        connected: false,
      };
    }

    // Get stats through the wrapper
    const info = await ensureConnection.info();
    const dbSize = await ensureConnection.dbSize();

    return {
      keys: dbSize,
      hits: parseInt(info.keyspace_hits || '0'),
      misses: parseInt(info.keyspace_misses || '0'),
      memory: info.used_memory_human || '0 bytes',
      clients: parseInt(info.connected_clients || '0'),
      connected: isConnected,
    };
  } catch (error) {
    console.error('[CACHE ERROR] Error getting Redis stats:', error);
    return {
      keys: 0,
      hits: 0,
      misses: 0,
      memory: '0 bytes',
      clients: 0,
      connected: false,
    };
  }
};


export const flushCacheByPattern = async (pattern: string): Promise<{ 
  deletedCount: number, 
  pattern: string 
}> => {
  try {
    const count = await deleteCachedDataByPattern(pattern, true);
    return { 
      deletedCount: count, 
      pattern 
    };
  } catch (error) {
    console.error(`[CACHE ERROR] Error flushing cache with pattern ${pattern}:`, error);
    return { 
      deletedCount: 0, 
      pattern 
    };
  }
};

/**
 * Find cache keys by pattern
 * @param pattern Pattern to search for
 */
export const findCacheKeys = async (pattern: string = `${NAMESPACE.PREFIX}:*`): Promise<string[]> => {
  try {
    // Use ensureConnection instead of direct redisClient access
    const keys: string[] = [];
    let cursor = 0;

    do {
      const scanResult = await ensureConnection.scan(cursor, pattern, 100);
      cursor = scanResult.cursor;
      
      if (scanResult.keys.length > 0) {
        keys.push(...scanResult.keys);
      }
    } while (cursor !== 0);

    return keys;
  } catch (error) {
    console.error('[CACHE ERROR] Error finding cache keys:', error);
    return [];
  }
};

// Export the Redis client
export default redisClient;
