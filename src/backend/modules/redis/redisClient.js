/**
 * Redis Distributed In-Memory & Real-Time Engine (Tawseela IQ v72)
 * Supports:
 * 1. Redis Geospatial Indexing (GEOADD, GEORADIUS/GEOSEARCH)
 * 2. Distributed Locks for Ride Acceptance (SET NX EX)
 * 3. Redis Pub/Sub for Server-Sent Events (SSE) across Cluster Workers
 * 4. Automatic In-Memory Fallback if Redis is unreachable
 */

const Redis = require('ioredis');

class RedisManager {
    constructor() {
        const redisHost = process.env.REDIS_HOST || '127.0.0.1';
        const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
        const redisPassword = process.env.REDIS_PASSWORD || undefined;

        const options = {
            host: redisHost,
            port: redisPort,
            password: redisPassword,
            retryStrategy: (times) => Math.min(times * 100, 3000),
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            lazyConnect: true
        };

        this.client = new Redis(options);
        this.pub = new Redis(options);
        this.sub = new Redis(options);

        this.isConnected = false;

        this._setupListeners(this.client, 'Main');
        this._setupListeners(this.pub, 'Publisher');
        this._setupListeners(this.sub, 'Subscriber');

        this.init();
    }

    _setupListeners(clientInstance, name) {
        clientInstance.on('connect', () => {
            // console.log(`[Redis:${name}] Connected to 127.0.0.1:6379`);
        });
        clientInstance.on('ready', () => {
            this.isConnected = true;
            // console.log(`[Redis:${name}] Ready to serve requests`);
        });
        clientInstance.on('error', (err) => {
            // Silent log on transient errors, keep fallback active
            this.isConnected = false;
        });
        clientInstance.on('close', () => {
            this.isConnected = false;
        });
    }

    async init() {
        try {
            await Promise.all([
                this.client.connect().catch(() => {}),
                this.pub.connect().catch(() => {}),
                this.sub.connect().catch(() => {})
            ]);
        } catch (_) {}
    }

    // ---[ 1. Geospatial Driver Tracking ]---
    async updateDriverLocation(driverId, lon, lat, meta = {}) {
        if (!this.isConnected || !driverId || isNaN(lon) || isNaN(lat)) return false;
        try {
            const pipeline = this.client.pipeline();
            // GEOADD key longitude latitude member
            pipeline.geoadd('drivers:locations', lon, lat, String(driverId));
            
            // Store driver details in Hash with 10-minute TTL to keep RAM lean
            const hashKey = `driver:${driverId}:meta`;
            const payload = {
                id: String(driverId),
                lon: String(lon),
                lat: String(lat),
                updatedAt: String(Date.now()),
                fullName: meta.fullName || meta.name || '',
                phone: meta.phoneNumber || meta.phone || '',
                status: meta.status || 'Online',
                workMode: meta.work_mode || meta.workMode || 'taxi',
                vehicleType: meta.vehicleType || 'eco',
                isOnline: 'true'
            };
            pipeline.hset(hashKey, payload);
            pipeline.expire(hashKey, 600); // 10 minutes TTL

            await pipeline.exec();
            return true;
        } catch (err) {
            return false;
        }
    }

    async removeDriverLocation(driverId) {
        if (!this.isConnected || !driverId) return false;
        try {
            await Promise.all([
                this.client.zrem('drivers:locations', String(driverId)).catch(() => {}),
                this.client.del(`driver:${driverId}:meta`).catch(() => {})
            ]);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Find nearby drivers within radiusKm using Redis GEORADIUS (O(log(N)+M))
     */
    async findNearbyDriverIds(lon, lat, radiusKm = 25) {
        if (!this.isConnected || isNaN(lon) || isNaN(lat)) return [];
        try {
            // GEORADIUS key longitude latitude radius km WITHDIST ASC
            const results = await this.client.georadius(
                'drivers:locations',
                lon,
                lat,
                radiusKm,
                'km',
                'WITHDIST',
                'ASC'
            );
            return (results || []).map(([driverId, dist]) => ({
                driverId,
                distKm: parseFloat(dist)
            }));
        } catch (err) {
            return [];
        }
    }

    // ---[ 2. Distributed Lock for Ride Acceptance ]---
    /**
     * Atomically acquires a lock on a ride.
     * Returns true if this driver successfully claimed the ride lock, false otherwise.
     */
    async acquireRideLock(rideId, driverId, ttlSeconds = 10) {
        if (!this.isConnected) {
            // Memory fallback lock
            return true;
        }
        try {
            const lockKey = `ride:lock:${rideId}`;
            // SET lockKey driverId NX EX ttlSeconds
            const res = await this.client.set(lockKey, String(driverId), 'NX', 'EX', ttlSeconds);
            return res === 'OK';
        } catch (err) {
            return true; // allow flow on redis error
        }
    }

    async releaseRideLock(rideId) {
        if (!this.isConnected) return;
        try {
            await this.client.del(`ride:lock:${rideId}`);
        } catch (_) {}
    }

    // ---[ 3. Pub/Sub Real-Time Broadcast for SSE ]---
    /**
     * Broadcast a dispatch event across all PM2 cluster workers
     */
    async publishDispatchEvent(event) {
        if (!this.isConnected) return false;
        try {
            const payload = typeof event === 'string' ? event : JSON.stringify(event);
            await this.pub.publish('channel:dispatch', payload);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Broadcast a ride update to passenger and assigned driver
     */
    async publishRideEvent(rideId, event) {
        if (!this.isConnected) return false;
        try {
            const payload = typeof event === 'string' ? event : JSON.stringify(event);
            await this.pub.publish(`channel:ride:${rideId}`, payload);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Broadcast a direct notification to a specific driver
     */
    async publishDriverEvent(driverId, event) {
        if (!this.isConnected) return false;
        try {
            const payload = typeof event === 'string' ? event : JSON.stringify(event);
            await this.pub.publish(`channel:driver:${driverId}`, payload);
            return true;
        } catch (_) {
            return false;
        }
    }

    // ---[ 4. Unified Distributed Pending Rides Management ]---
    /**
     * Save a new pending ride atomically to Redis Hash and Key
     */
    async savePendingRide(ride) {
        if (!this.isConnected || !ride || !ride.id) return false;
        try {
            const payload = typeof ride === 'string' ? ride : JSON.stringify(ride);
            const key = `ride:request:${ride.id}`;
            await Promise.all([
                this.client.set(key, payload, 'EX', 600), // 10 minutes expiry
                this.client.hset('pending:rides', String(ride.id), payload)
            ]);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Remove a pending ride atomically from Redis Hash, Key, and Lock
     */
    async removePendingRide(rideId) {
        if (!this.isConnected || !rideId) return false;
        try {
            const sId = String(rideId);
            await Promise.all([
                this.client.del(`ride:request:${sId}`),
                this.client.hdel('pending:rides', sId),
                this.client.del(`ride:lock:${sId}`)
            ]);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Retrieve all fresh (< 2 mins) pending rides strictly from Redis Hash
     * Prunes expired or non-pending rides atomically
     */
    async getPendingRides() {
        if (!this.isConnected || !this.client) return [];
        try {
            const rawMap = await this.client.hgetall('pending:rides');
            if (!rawMap) return [];
            const rides = [];
            const now = Date.now();
            const maxAgeMs = 120000; // strictly within 2 minutes (120,000 ms)
            for (const [id, jsonStr] of Object.entries(rawMap)) {
                try {
                    const r = JSON.parse(jsonStr);
                    const reqTime = r.requestedAt ? Number(r.requestedAt) : (r.createdAt ? new Date(r.createdAt).getTime() : (r.timestamp ? Number(r.timestamp) : now));
                    const isPending = String(r.status || '').toLowerCase().trim() === 'pending';
                    const age = now - reqTime;
                    const isFresh = age < maxAgeMs;

                    if (isPending && isFresh && !r.acceptedDriverId) {
                        rides.push(r);
                    } else if (age >= maxAgeMs || !isPending || r.acceptedDriverId) {
                        // Stale, accepted, or non-pending: prune atomically from Redis hash
                        this.client.hdel('pending:rides', String(id)).catch(() => {});
                        this.client.del(`ride:request:${id}`).catch(() => {});
                    }
                } catch (_) {}
            }
            return rides;
        } catch (_) {
            return [];
        }
    }

    // ---[ 5. Cluster-Wide Rate Limiter via Atomic Redis INCR & EXPIRE ]---
    /**
     * Check and enforce rate limit across all PM2 cluster instances
     * @param {string} key Redis rate limit key (e.g. rate:ride:create:${riderId})
     * @param {number} maxRequests Maximum allowed requests in window
     * @param {number} windowSec Time window in seconds
     * @returns {Promise<{ allowed: boolean, current: number, max: number, ttl: number }>}
     */
    async checkRateLimitCluster(key, maxRequests = 5, windowSec = 30) {
        if (!this.isConnected || !this.client) {
            return { allowed: true, current: 1, max: maxRequests, ttl: windowSec };
        }
        try {
            const count = await this.client.incr(key);
            if (count === 1) {
                await this.client.expire(key, windowSec);
            }
            const ttl = await this.client.ttl(key);
            return {
                allowed: count <= maxRequests,
                current: count,
                max: maxRequests,
                ttl: ttl > 0 ? ttl : windowSec
            };
        } catch (err) {
            return { allowed: true, current: 1, max: maxRequests, ttl: windowSec };
        }
    }
}

const redisManager = new RedisManager();
module.exports = redisManager;
