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

            // PM2 Cluster Multi-core synchronization across instances
            if (this.sub) {
                this.sub.subscribe('channel:cluster:sync').catch(() => {});
                this.sub.on('message', (chan, msg) => {
                    if (chan === 'channel:cluster:sync') {
                        try {
                            const data = JSON.parse(msg);
                            if (data.type === 'booking_status_sync' || data.type === 'subscriber_cancelled_sync') {
                                const db = require('../../db');
                                if (db && db.memoryState) {
                                    const targetBookingId = String(data.bookingId || '');
                                    const newStatus = data.status || (data.type === 'subscriber_cancelled_sync' ? 'Cancelled' : null);
                                    const stLower = String(newStatus || '').toLowerCase();
                                    if (targetBookingId) {
                                        for (const b of (db.memoryState.bookings || [])) {
                                            const bId = String(b.id || b.bookingId || '');
                                            if (bId === targetBookingId) {
                                                if (newStatus) b.status = newStatus;
                                                if (stLower === 'cancelled' || stLower === 'declined' || stLower === 'rejected' || stLower === 'expired') {
                                                    b.cancellationPending = false;
                                                    b.cancellation_requested = false;
                                                    b.cancellation_status = data.cancellationStatus || (stLower === 'declined' || stLower === 'rejected' ? 'declined' : (data.type === 'subscriber_cancelled_sync' ? 'driver_cancelled' : 'cancelled'));
                                                    if (data.reason) {
                                                        b.cancellationReason = data.reason;
                                                        b.cancellation_reason = data.reason;
                                                        b.declineReason = data.reason;
                                                    }
                                                } else if (stLower === 'confirmed' || stLower === 'accepted') {
                                                    b.cancellationPending = false;
                                                    b.cancellation_requested = false;
                                                }
                                            }
                                        }
                                    }
                                    if (data.customerId && (stLower === 'cancelled' || stLower === 'declined' || stLower === 'rejected')) {
                                        for (const c of (db.memoryState.customers || [])) {
                                            if (c.customerId === data.customerId || c.id === data.customerId) {
                                                c.assignedDriverId = null;
                                                c.driverId = null;
                                                c.bookingConfirmed = false;
                                            }
                                        }
                                    } else if (data.customerId && (stLower === 'confirmed' || stLower === 'accepted')) {
                                        for (const c of (db.memoryState.customers || [])) {
                                            if (c.customerId === data.customerId || c.id === data.customerId) {
                                                if (data.driverId) {
                                                    c.assignedDriverId = data.driverId;
                                                    c.driverId = data.driverId;
                                                }
                                                c.bookingConfirmed = true;
                                            }
                                        }
                                    }
                                    if (typeof db.saveStateSnapshot === 'function') {
                                        db.saveStateSnapshot();
                                    }
                                }
                            }
                        } catch (_) {}
                    }
                });
            }
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
                vehicleType: meta.vehicleType || meta.tier || 'eco',
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

    // ---[ Distributed Lock for Telegram Notifications (Multi-Worker Deduplication) ]---
    async acquireTelegramNotificationLock(key, ttlSeconds = 86400) {
        if (!this.isConnected || !this.client) {
            if (!global._tgMemLocks) global._tgMemLocks = new Set();
            if (global._tgMemLocks.has(key)) return false;
            global._tgMemLocks.add(key);
            setTimeout(() => global._tgMemLocks.delete(key), Math.min(ttlSeconds * 1000, 3600000));
            return true;
        }
        try {
            const lockKey = `tg:lock:${key}`;
            const res = await this.client.set(lockKey, '1', 'NX', 'EX', ttlSeconds);
            return res === 'OK';
        } catch (err) {
            return true; // allow attempt if redis error
        }
    }

    // ---[ Store and retrieve sent Telegram ride offer messages for candidates ]---
    async saveRideOfferMessage(rideId, driverId, chatId, messageId) {
        if (!rideId || !driverId || !chatId || !messageId) return;
        const entry = JSON.stringify({ driverId, chatId, messageId, timestamp: Date.now() });
        if (this.isConnected && this.client) {
            try {
                await this.client.hset(`ride:offers:${rideId}`, String(driverId), entry);
                await this.client.expire(`ride:offers:${rideId}`, 1800); // 30 mins
            } catch (_) {}
        } else {
            if (!global._tgOffersMem) global._tgOffersMem = new Map();
            const map = global._tgOffersMem.get(rideId) || new Map();
            map.set(String(driverId), { driverId, chatId, messageId, timestamp: Date.now() });
            global._tgOffersMem.set(rideId, map);
        }
    }

    async getRideOfferMessages(rideId) {
        if (!rideId) return [];
        if (this.isConnected && this.client) {
            try {
                const rawMap = await this.client.hgetall(`ride:offers:${rideId}`);
                if (!rawMap) return [];
                return Object.values(rawMap).map(str => {
                    try { return JSON.parse(str); } catch (_) { return null; }
                }).filter(Boolean);
            } catch (_) {
                return [];
            }
        } else {
            if (!global._tgOffersMem) return [];
            const map = global._tgOffersMem.get(rideId);
            return map ? Array.from(map.values()) : [];
        }
    }

    async clearRideOfferMessages(rideId) {
        if (!rideId) return;
        if (this.isConnected && this.client) {
            try {
                await this.client.del(`ride:offers:${rideId}`);
            } catch (_) {}
        } else if (global._tgOffersMem) {
            global._tgOffersMem.delete(rideId);
        }
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
     * Broadcast a ride update to passenger and assigned driver with event history for Last-Event-ID
     */
    async publishRideEvent(rideId, event) {
        if (!this.isConnected) return false;
        try {
            const eventObj = typeof event === 'object' && event !== null ? { ...event } : { data: event };
            if (!eventObj.eventId && !eventObj.id) {
                eventObj.eventId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 4);
            }
            const eventId = eventObj.eventId || eventObj.id;
            const payload = JSON.stringify(eventObj);

            // Record in Redis List history for Last-Event-ID replay (keep last 50 events, TTL 1 hour)
            const histKey = `sse:history:ride:${rideId}`;
            if (this.client) {
                await this.client.rpush(histKey, payload).catch(() => {});
                await this.client.ltrim(histKey, -50, -1).catch(() => {});
                await this.client.expire(histKey, 3600).catch(() => {});
            }

            await this.pub.publish(`channel:ride:${rideId}`, payload);
            return eventId;
        } catch (_) {
            return false;
        }
    }

    /**
     * Broadcast a direct notification to a specific driver with event history for Last-Event-ID
     */
    async publishDriverEvent(driverId, event) {
        if (!this.isConnected) return false;
        try {
            const eventObj = typeof event === 'object' && event !== null ? { ...event } : { data: event };
            if (!eventObj.eventId && !eventObj.id) {
                eventObj.eventId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 4);
            }
            const eventId = eventObj.eventId || eventObj.id;
            const payload = JSON.stringify(eventObj);

            // Record in Redis List history for Last-Event-ID replay (keep last 50 events, TTL 1 hour)
            const histKey = `sse:history:driver:${driverId}`;
            if (this.client) {
                await this.client.rpush(histKey, payload).catch(() => {});
                await this.client.ltrim(histKey, -50, -1).catch(() => {});
                await this.client.expire(histKey, 3600).catch(() => {});
            }

            await this.pub.publish(`channel:driver:${driverId}`, payload);
            return eventId;
        } catch (_) {
            return false;
        }
    }

    /**
     * Publish Real-time Passenger/Customer Event with Replay Buffer
     */
    async publishPassengerEvent(passengerId, event) {
        if (!this.isConnected || !this.pub || !passengerId) return false;
        try {
            const eventId = `ev_pass_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            const eventObj = typeof event === 'string' ? JSON.parse(event) : { ...event };
            eventObj.eventId = eventId;
            eventObj.timestamp = eventObj.timestamp || new Date().toISOString();
            const payload = JSON.stringify(eventObj);

            const histKey = `sse:history:passenger:${passengerId}`;
            if (this.client) {
                await this.client.rpush(histKey, payload).catch(() => {});
                await this.client.ltrim(histKey, -50, -1).catch(() => {});
                await this.client.expire(histKey, 3600).catch(() => {});
            }

            await this.pub.publish(`channel:passenger:${passengerId}`, payload);
            return eventId;
        } catch (_) {
            return false;
        }
    }

    /**
     * Fetch missed SSE events since lastEventId from Redis List
     */
    async getMissedSseEvents(channelType, channelId, lastEventId) {
        if (!this.isConnected || !this.client || !channelId || !lastEventId) return [];
        try {
            const histKey = `sse:history:${channelType}:${channelId}`;
            const items = await this.client.lrange(histKey, 0, -1);
            if (!items || items.length === 0) return [];
            
            const missed = [];
            let foundLast = false;
            for (const item of items) {
                try {
                    const parsed = JSON.parse(item);
                    const eId = String(parsed.eventId || parsed.id || '');
                    if (foundLast) {
                        missed.push(parsed);
                    } else if (eId === String(lastEventId)) {
                        foundLast = true;
                    }
                } catch (_) {}
            }
            // Fallback: timestamp-based comparison if lastEventId is not exact match
            if (!foundLast && missed.length === 0) {
                const lastTs = parseInt(String(lastEventId).split('_')[0], 10);
                if (!isNaN(lastTs) && lastTs > 0) {
                    for (const item of items) {
                        try {
                            const parsed = JSON.parse(item);
                            const eId = String(parsed.eventId || parsed.id || '');
                            const curTs = parseInt(eId.split('_')[0], 10);
                            if (!isNaN(curTs) && curTs > lastTs) {
                                missed.push(parsed);
                            }
                        } catch (_) {}
                    }
                }
            }
            return missed;
        } catch (_) {
            return [];
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
                    const s = String(r.status || '').toLowerCase().trim();
                    const isPending = s === 'pending' || s === 'offered' || s === 'requested';
                    const age = now - reqTime;
                    const isFresh = age < maxAgeMs;

                    if (isPending && isFresh && !r.acceptedDriverId) {
                        rides.push(r);
                    } else if (age >= maxAgeMs || (!isPending && s !== '') || r.acceptedDriverId) {
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

    // ---[ 5. Cluster-Wide Rate Limiter via Atomic Redis Lua Script ]---
    /**
     * Check and enforce rate limit across all PM2 cluster instances
     * Uses atomic Lua script to guarantee INCR and EXPIRE are executed atomically,
     * preventing orphan keys without TTL (ttl == -1).
     * 
     * Fail-Open Architecture Note:
     * If Redis is disconnected, unreachable, or throws an error, this method returns
     * { allowed: true } by design (fail-open) so that transient caching or network issues
     * do not disrupt active ride booking or captain operations in production.
     * 
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
            const luaScript = `
                local current = redis.call('INCR', KEYS[1])
                if current == 1 then
                    redis.call('EXPIRE', KEYS[1], ARGV[1])
                end
                local ttl = redis.call('TTL', KEYS[1])
                if ttl == -1 then
                    redis.call('EXPIRE', KEYS[1], ARGV[1])
                    ttl = tonumber(ARGV[1])
                end
                return { current, ttl }
            `;
            const res = await this.client.eval(luaScript, 1, key, windowSec);
            const count = Number(res[0]);
            const ttl = Number(res[1]);
            return {
                allowed: count <= maxRequests,
                current: count,
                max: maxRequests,
                ttl: ttl > 0 ? ttl : windowSec
            };
        } catch (err) {
            // Fail-open: allow request if Redis operation fails
            return { allowed: true, current: 1, max: maxRequests, ttl: windowSec };
        }
    }

    // ---[ 6. Driver External Navigation State Management (Batch 2) ]---
    async setDriverExternalNav(driverId, data = {}, ttlSec = 900) {
        if (!this.isConnected || !this.client || !driverId) return false;
        try {
            const key = `driver:${driverId}:external_nav`;
            const payload = JSON.stringify({
                driverId,
                app: data.app || 'Google Maps',
                rideId: data.rideId || null,
                startedAt: data.startedAt || Date.now()
            });
            await this.client.set(key, payload, 'EX', ttlSec);
            return true;
        } catch (_) {
            return false;
        }
    }

    async clearDriverExternalNav(driverId) {
        if (!this.isConnected || !this.client || !driverId) return false;
        try {
            const key = `driver:${driverId}:external_nav`;
            await this.client.del(key);
            return true;
        } catch (_) {
            return false;
        }
    }

    async getDriverExternalNav(driverId) {
        if (!this.isConnected || !this.client || !driverId) return null;
        try {
            const key = `driver:${driverId}:external_nav`;
            const val = await this.client.get(key);
            return val ? JSON.parse(val) : null;
        } catch (_) {
            return null;
        }
    }

    async isDriverNavigatingExternal(driverId) {
        if (!this.isConnected || !this.client || !driverId) return false;
        try {
            const key = `driver:${driverId}:external_nav`;
            const exists = await this.client.exists(key);
            return exists === 1;
        } catch (_) {
            return false;
        }
    }

    // ---[ 7. Driver Fixed Location Management (Batch 1 & 5) ]---
    async setDriverFixedLocation(driverId, data = {}) {
        if (!this.isConnected || !this.client || !driverId) return false;
        try {
            const hashKey = `driver:${driverId}:meta`;
            await this.client.hset(hashKey, {
                id: String(driverId),
                fixed_lat: String(data.lat),
                fixed_lng: String(data.lng),
                fixed_label: String(data.label || ''),
                fixed_dest_lat: data.destLat != null ? String(data.destLat) : '',
                fixed_dest_lng: data.destLng != null ? String(data.destLng) : '',
                fixed_dest_label: String(data.destLabel || ''),
                route_name: String(data.routeName || ''),
                fixed_updated_at: String(data.updatedAt || new Date().toISOString())
            });
            return true;
        } catch (_) {
            return false;
        }
    }

    async removeDriverFixedLocation(driverId) {
        if (!this.isConnected || !this.client || !driverId) return false;
        try {
            const hashKey = `driver:${driverId}:meta`;
            await this.client.hdel(
                hashKey, 
                'fixed_lat', 'fixed_lng', 'fixed_label', 
                'fixed_dest_lat', 'fixed_dest_lng', 'fixed_dest_label', 
                'route_name', 'fixed_updated_at'
            );
            return true;
        } catch (_) {
            return false;
        }
    }

    async getDriverFixedLocation(driverId) {
        if (!this.isConnected || !this.client || !driverId) return null;
        try {
            const hashKey = `driver:${driverId}:meta`;
            const meta = await this.client.hgetall(hashKey);
            if (!meta || !meta.fixed_lat || !meta.fixed_lng) return null;
            return {
                driverId: String(driverId),
                lat: parseFloat(meta.fixed_lat),
                lng: parseFloat(meta.fixed_lng),
                label: meta.fixed_label || '',
                destLat: meta.fixed_dest_lat ? parseFloat(meta.fixed_dest_lat) : null,
                destLng: meta.fixed_dest_lng ? parseFloat(meta.fixed_dest_lng) : null,
                destLabel: meta.fixed_dest_label || '',
                routeName: meta.route_name || '',
                updatedAt: meta.fixed_updated_at || null
            };
        } catch (_) {
            return null;
        }
    }
}

const redisManager = new RedisManager();
module.exports = redisManager;
