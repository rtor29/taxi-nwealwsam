'use strict';

/**
 * Ride State Machine & Distributed Lifecycle Engine (Tawseela IQ v82)
 * 
 * Canonical Path:
 *   REQUESTED -> OFFERED -> ACCEPTED -> DRIVER_ARRIVED -> IN_TRIP -> ARRIVED_DESTINATION -> COMPLETED
 * 
 * Branch / Terminal States:
 *   CANCELLED_BY_RIDER, CANCELLED_BY_DRIVER, EXPIRED, NO_DRIVERS
 */

const db = require('../../db');
const auditService = require('../audit/auditService');

const RIDE_STATES = {
    REQUESTED: 'REQUESTED',
    OFFERED: 'OFFERED',
    ACCEPTED: 'ACCEPTED',
    DRIVER_ARRIVED: 'DRIVER_ARRIVED',
    IN_TRIP: 'IN_TRIP',
    ARRIVED_DESTINATION: 'ARRIVED_DESTINATION',
    COMPLETED: 'COMPLETED',
    CANCELLED_BY_RIDER: 'CANCELLED_BY_RIDER',
    CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
    EXPIRED: 'EXPIRED',
    NO_DRIVERS: 'NO_DRIVERS'
};

const ALLOWED_TRANSITIONS = {
    [RIDE_STATES.REQUESTED]: [
        RIDE_STATES.OFFERED, 
        RIDE_STATES.NO_DRIVERS, 
        RIDE_STATES.CANCELLED_BY_RIDER, 
        RIDE_STATES.EXPIRED
    ],
    [RIDE_STATES.OFFERED]: [
        RIDE_STATES.ACCEPTED, 
        RIDE_STATES.OFFERED, 
        RIDE_STATES.NO_DRIVERS, 
        RIDE_STATES.CANCELLED_BY_RIDER, 
        RIDE_STATES.EXPIRED
    ],
    [RIDE_STATES.ACCEPTED]: [
        RIDE_STATES.DRIVER_ARRIVED, 
        RIDE_STATES.CANCELLED_BY_RIDER, 
        RIDE_STATES.CANCELLED_BY_DRIVER,
        RIDE_STATES.REQUESTED // Re-dispatch to alternative candidate
    ],
    [RIDE_STATES.DRIVER_ARRIVED]: [
        RIDE_STATES.IN_TRIP, 
        RIDE_STATES.CANCELLED_BY_RIDER, 
        RIDE_STATES.CANCELLED_BY_DRIVER,
        RIDE_STATES.REQUESTED
    ],
    [RIDE_STATES.IN_TRIP]: [
        RIDE_STATES.ARRIVED_DESTINATION, 
        RIDE_STATES.COMPLETED, 
        RIDE_STATES.CANCELLED_BY_RIDER, 
        RIDE_STATES.CANCELLED_BY_DRIVER
    ],
    [RIDE_STATES.ARRIVED_DESTINATION]: [
        RIDE_STATES.COMPLETED
    ],
    [RIDE_STATES.COMPLETED]: [],
    [RIDE_STATES.CANCELLED_BY_RIDER]: [],
    [RIDE_STATES.CANCELLED_BY_DRIVER]: [],
    [RIDE_STATES.EXPIRED]: [],
    [RIDE_STATES.NO_DRIVERS]: []
};

function toCanonicalState(status) {
    if (!status) return RIDE_STATES.REQUESTED;
    const s = String(status).trim().toUpperCase();
    if (s === 'PENDING') return RIDE_STATES.OFFERED;
    if (s === 'OFFERED') return RIDE_STATES.OFFERED;
    if (s === 'REQUESTED') return RIDE_STATES.REQUESTED;
    if (s === 'ACCEPTED') return RIDE_STATES.ACCEPTED;
    if (s === 'ARRIVED' || s === 'DRIVER_ARRIVED') return RIDE_STATES.DRIVER_ARRIVED;
    if (s === 'INPROGRESS' || s === 'IN_PROGRESS' || s === 'STARTED' || s === 'ONTHEWAY' || s === 'IN_TRIP') return RIDE_STATES.IN_TRIP;
    if (s === 'ARRIVED_DESTINATION' || s === 'ARRIVEDDESTINATION') return RIDE_STATES.ARRIVED_DESTINATION;
    if (s === 'COMPLETED') return RIDE_STATES.COMPLETED;
    if (s === 'CANCELLED' || s === 'CANCELED' || s === 'CANCELLED_BY_RIDER') return RIDE_STATES.CANCELLED_BY_RIDER;
    if (s === 'CANCELLED_BY_DRIVER') return RIDE_STATES.CANCELLED_BY_DRIVER;
    if (s === 'EXPIRED') return RIDE_STATES.EXPIRED;
    if (s === 'NODRIVERSAVAILABLE' || s === 'NO_DRIVERS') return RIDE_STATES.NO_DRIVERS;
    return s;
}

// In-memory idempotency cache (TTL 5 minutes)
const idempotencyStore = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of idempotencyStore.entries()) {
        if (now - v.timestamp > 300000) {
            idempotencyStore.delete(k);
        }
    }
}, 60000);

// In-memory Rate Limiter per user/IP
const rateLimitStore = new Map();
function checkRateLimit(key, maxRequests = 5, windowMs = 30000) {
    const now = Date.now();
    let entry = rateLimitStore.get(key);
    if (!entry || now - entry.startTime > windowMs) {
        entry = { count: 1, startTime: now };
        rateLimitStore.set(key, entry);
        return true;
    }
    if (entry.count >= maxRequests) {
        return false;
    }
    entry.count += 1;
    return true;
}

/**
 * Address Normalization Fallback Chain (Architectural Invariant)
 */
function normalizeAddresses(ride) {
    if (!ride) return ride;
    ride.pickupName = ride.pickupName || ride.pickupAddress || ride.pickup_title || ride.originAddress || 'موقعي الحالي عبر الـ GPS';
    ride.pickupAddress = ride.pickupAddress || ride.pickupName || ride.pickup_title || ride.originAddress || 'موقعي الحالي عبر الـ GPS';
    ride.dropoffName = ride.dropoffName || ride.dropoffAddress || ride.dropoff_title || ride.destination || ride.destinationAddress || 'الوجهة المحددة';
    ride.dropoffAddress = ride.dropoffAddress || ride.dropoffName || ride.dropoff_title || ride.destination || ride.destinationAddress || 'الوجهة المحددة';
    ride.destination = ride.destination || ride.dropoffName || ride.dropoffAddress;
    ride.destinationAddress = ride.destinationAddress || ride.dropoffAddress || ride.dropoffName;
    return ride;
}

/**
 * Haversine Distance in Kilometers
 */
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const p1 = parseFloat(lat1);
    const l1 = parseFloat(lon1);
    const p2 = parseFloat(lat2);
    const l2 = parseFloat(lon2);
    if (isNaN(p1) || isNaN(l1) || isNaN(p2) || isNaN(l2)) return 0;
    const R = 6371;
    const dLat = (p2 - p1) * Math.PI / 180;
    const dLon = (l2 - l1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(p1 * Math.PI / 180) * Math.cos(p2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return parseFloat((R * c).toFixed(2));
}

/**
 * Validate speed jump between coordinate updates (Rejects > 140 km/h)
 */
function validateLocationSpeed(prevLat, prevLon, prevTime, nextLat, nextLon, nextTime) {
    if (!prevLat || !prevLon || !prevTime || !nextTime || nextTime <= prevTime) return { valid: true };
    const distKm = calculateDistanceKm(prevLat, prevLon, nextLat, nextLon);
    const hours = (nextTime - prevTime) / 3600000;
    if (hours <= 0) return { valid: true };
    const speedKmh = distKm / hours;
    if (speedKmh > 140) {
        return {
            valid: false,
            speedKmh: Math.round(speedKmh),
            distKm,
            reason: `سرعة غير منطقية (${Math.round(speedKmh)} كم/س)`
        };
    }
    return { valid: true, speedKmh: Math.round(speedKmh) };
}

/**
 * Log granular state transition into PostgreSQL ride_events table
 */
async function logRideEvent(rideId, fromStatus, toStatus, actorId, actorRole, lat = null, lon = null, metadata = {}) {
    if (!db.isPostgresConnected || !db.pool) return;
    try {
        await db.pool.query(
            `INSERT INTO ride_events (ride_id, from_status, to_status, actor_id, actor_role, lat, lon, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [
                String(rideId),
                fromStatus || null,
                String(toStatus),
                actorId ? String(actorId) : null,
                actorRole ? String(actorRole) : 'System',
                lat !== null ? parseFloat(lat) : null,
                lon !== null ? parseFloat(lon) : null,
                JSON.stringify(metadata || {})
            ]
        );
    } catch (err) {
        console.error('[RideEvents] Logging error:', err.message);
    }
}

/**
 * Persist finalized ride to PostgreSQL `rides` table
 */
async function persistFinalRideToPostgres(ride) {
    if (!db.isPostgresConnected || !db.pool || !ride || !ride.id) return;
    normalizeAddresses(ride);
    try {
        await db.pool.query(
            `INSERT INTO rides (
                id, rider_id, rider_name, rider_phone,
                driver_id, driver_name, driver_phone, vehicle_info, vehicle_plate,
                status, pickup_name, pickup_address, pickup_lat, pickup_lon,
                dropoff_name, dropoff_address, dropoff_lat, dropoff_lon,
                vehicle_type, distance_km, duration_mins,
                estimated_fare, final_fare, received_amount, fare_difference,
                review_flag, cancellation_fee, cancel_reason, cancelled_by,
                payment_method, payment_status, reconciliation_status,
                idempotency_key, requested_at, offered_at, accepted_at,
                arrived_at, started_at, arrived_destination_at, completed_at, cancelled_at,
                created_at, updated_at
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8, $9,
                $10, $11, $12, $13, $14,
                $15, $16, $17, $18,
                $19, $20, $21,
                $22, $23, $24, $25,
                $26, $27, $28, $29,
                $30, $31, $32,
                $33, $34, $35, $36,
                $37, $38, $39, $40, $41,
                NOW(), NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                driver_id = EXCLUDED.driver_id,
                driver_name = EXCLUDED.driver_name,
                driver_phone = EXCLUDED.driver_phone,
                vehicle_info = EXCLUDED.vehicle_info,
                vehicle_plate = EXCLUDED.vehicle_plate,
                status = EXCLUDED.status,
                distance_km = EXCLUDED.distance_km,
                duration_mins = EXCLUDED.duration_mins,
                final_fare = EXCLUDED.final_fare,
                received_amount = EXCLUDED.received_amount,
                fare_difference = EXCLUDED.fare_difference,
                review_flag = EXCLUDED.review_flag,
                cancellation_fee = EXCLUDED.cancellation_fee,
                cancel_reason = EXCLUDED.cancel_reason,
                cancelled_by = EXCLUDED.cancelled_by,
                payment_status = EXCLUDED.payment_status,
                reconciliation_status = EXCLUDED.reconciliation_status,
                arrived_at = EXCLUDED.arrived_at,
                started_at = EXCLUDED.started_at,
                arrived_destination_at = EXCLUDED.arrived_destination_at,
                completed_at = EXCLUDED.completed_at,
                cancelled_at = EXCLUDED.cancelled_at,
                updated_at = NOW()`,
            [
                String(ride.id),
                String(ride.customerId || ride.riderId || 'guest'),
                ride.customerName || ride.riderName || 'راكب توصيلة',
                ride.customerPhone || ride.riderPhone || '',
                ride.assignedDriverId || ride.acceptedDriverId || ride.driverId || null,
                ride.assignedDriverName || ride.driverName || null,
                ride.assignedDriverPhone || ride.driverPhone || null,
                ride.assignedDriverVehicle || ride.vehicleInfo || null,
                ride.driverPlate || null,
                String(ride.status),
                ride.pickupName,
                ride.pickupAddress,
                parseFloat(ride.pickupLat) || 0,
                parseFloat(ride.pickupLon) || 0,
                ride.dropoffName,
                ride.dropoffAddress,
                parseFloat(ride.dropoffLat) || 0,
                parseFloat(ride.dropoffLon) || 0,
                ride.vehicleType || 'توفير',
                parseFloat(ride.distanceKm) || 0,
                parseInt(ride.durationMins, 10) || 0,
                parseFloat(ride.estimatedFare || ride.fare) || 0,
                parseFloat(ride.finalFare || ride.fare) || 0,
                parseFloat(ride.receivedAmount) || 0,
                parseFloat(ride.fareDifference) || 0,
                Boolean(ride.reviewFlag),
                parseFloat(ride.cancellationFee) || 0,
                ride.cancelReason || null,
                ride.cancelledBy || null,
                ride.paymentMethod || 'Cash',
                ride.paymentStatus || 'Pending',
                ride.reconciliationStatus || 'settled',
                ride.idempotencyKey || null,
                ride.requestedAt ? new Date(Number(ride.requestedAt) || ride.requestedAt) : new Date(),
                ride.offeredAt ? new Date(ride.offeredAt) : null,
                ride.acceptedAt ? new Date(ride.acceptedAt) : null,
                ride.arrivedAt ? new Date(ride.arrivedAt) : null,
                ride.startedAt ? new Date(ride.startedAt) : null,
                ride.arrivedDestinationAt ? new Date(ride.arrivedDestinationAt) : null,
                ride.completedAt ? new Date(ride.completedAt) : null,
                ride.cancelledAt ? new Date(ride.cancelledAt) : null
            ]
        );
    } catch (err) {
        console.error('[PostgresRides] Persistence error:', err.message);
    }
}

/**
 * Execute Atomic State Transition
 */
async function transitionRideState(redisManager, rideId, targetStatus, actorInfo = {}, extraData = {}) {
    if (!rideId || !targetStatus) {
        return { success: false, error: 'rideId and targetStatus are required' };
    }
    const sId = String(rideId).trim();
    const toStatus = toCanonicalState(targetStatus);

    // 1. Acquire Distributed Transition Lock (TTL 5s)
    const lockAcquired = await redisManager.acquireRideLock(sId, `trans_${toStatus}`, 5);
    if (!lockAcquired) {
        return {
            success: false,
            conflict: true,
            status: 409,
            error: 'عذراً، جارٍ معالجة حالة هذا المشوار بالتزامن. يرجى الانتظار قليلاً.'
        };
    }

    try {
        // 2. Fetch current ride state from Redis or Memory
        let ride = null;
        if (redisManager.isConnected && redisManager.client) {
            const activeStr = await redisManager.client.get('ride:active:' + sId);
            if (activeStr) ride = JSON.parse(activeStr);
            if (!ride) {
                const pendStr = await redisManager.client.hget('pending:rides', sId);
                if (pendStr) ride = JSON.parse(pendStr);
            }
            if (!ride) {
                const reqStr = await redisManager.client.get('ride:request:' + sId);
                if (reqStr) ride = JSON.parse(reqStr);
            }
        }
        if (!ride) {
            ride = (db.memoryState.rideRequests || []).find(r => String(r.id) === sId);
        }

        if (!ride) {
            return {
                success: false,
                notFound: true,
                status: 200,
                error: 'لم يتم العثور على المشوار المطلوب'
            };
        }

        const rawFromStatus = ride.status || RIDE_STATES.REQUESTED;
        const fromStatus = toCanonicalState(rawFromStatus);

        // Check if transition is allowed
        const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
        if (!allowed.includes(toStatus)) {
            // Already in desired status? (Idempotent return)
            if (fromStatus === toStatus) {
                return { success: true, ride, idempotent: true };
            }
            return {
                success: false,
                conflict: true,
                status: 409,
                fromStatus,
                toStatus,
                error: `تعارض حالات: لا يمكن الانتقال من الحالة [${fromStatus}] إلى [${toStatus}]`
            };
        }

        // Apply state transition
        const nowIso = new Date().toISOString();
        ride.status = toStatus;
        ride.updatedAt = nowIso;
        Object.assign(ride, extraData);

        if (toStatus === RIDE_STATES.OFFERED) {
            ride.offeredAt = nowIso;
        } else if (toStatus === RIDE_STATES.ACCEPTED) {
            ride.acceptedAt = nowIso;
        } else if (toStatus === RIDE_STATES.DRIVER_ARRIVED) {
            ride.arrivedAt = nowIso;
        } else if (toStatus === RIDE_STATES.IN_TRIP) {
            ride.startedAt = nowIso;
        } else if (toStatus === RIDE_STATES.ARRIVED_DESTINATION) {
            ride.arrivedDestinationAt = nowIso;
        } else if (toStatus === RIDE_STATES.COMPLETED) {
            ride.completedAt = nowIso;
        } else if (toStatus.startsWith('CANCELLED')) {
            ride.cancelledAt = nowIso;
        }

        normalizeAddresses(ride);

        // 3. Update Redis Keys atomically
        if (redisManager.isConnected && redisManager.client) {
            const rideStr = JSON.stringify(ride);
            const pipeline = redisManager.client.pipeline();

            const driverId = ride.assignedDriverId || ride.acceptedDriverId || ride.driverId;
            const riderId = ride.customerId || ride.riderId;
            const cleanDriverPhone = driverId && db.findDriver ? (db.findDriver(driverId)?.phoneNumber || '') : '';
            const cleanRiderPhone = String(ride.customerPhone || '').replace(/\D/g, '');

            const isTerminal = [
                RIDE_STATES.COMPLETED, 
                RIDE_STATES.CANCELLED_BY_RIDER, 
                RIDE_STATES.CANCELLED_BY_DRIVER, 
                RIDE_STATES.EXPIRED, 
                RIDE_STATES.NO_DRIVERS
            ].includes(toStatus);

            if (isTerminal) {
                // Remove active keys and pending hashes
                pipeline.del('ride:active:' + sId);
                pipeline.hdel('pending:rides', sId);
                pipeline.del('ride:request:' + sId);
                if (driverId) pipeline.del('driver:active:' + driverId);
                if (cleanDriverPhone) pipeline.del('driver:active:' + cleanDriverPhone);
                if (riderId) pipeline.del('rider:active:' + riderId);
                if (cleanRiderPhone) pipeline.del('rider:active:' + cleanRiderPhone);
            } else if (toStatus === RIDE_STATES.REQUESTED || toStatus === RIDE_STATES.OFFERED) {
                // Pending status
                pipeline.hset('pending:rides', sId, rideStr);
                pipeline.set('ride:request:' + sId, rideStr, 'EX', 1200);
            } else {
                // Active ride status: TTL 7200s extended on every transition
                pipeline.hdel('pending:rides', sId);
                pipeline.set('ride:active:' + sId, rideStr, 'EX', 7200);
                if (driverId) pipeline.set('driver:active:' + driverId, rideStr, 'EX', 7200);
                if (cleanDriverPhone) pipeline.set('driver:active:' + cleanDriverPhone, rideStr, 'EX', 7200);
                if (riderId) pipeline.set('rider:active:' + riderId, rideStr, 'EX', 7200);
                if (cleanRiderPhone) pipeline.set('rider:active:' + cleanRiderPhone, rideStr, 'EX', 7200);
            }

            await pipeline.exec();
        }

        // 4. Update memory state for current PM2 instance fallback
        db.memoryState.rideRequests = db.memoryState.rideRequests || [];
        const memIdx = db.memoryState.rideRequests.findIndex(r => String(r.id) === sId);
        if (memIdx >= 0) {
            db.memoryState.rideRequests[memIdx] = ride;
        } else {
            db.memoryState.rideRequests.unshift(ride);
        }

        // 5. Save finalized ride to PostgreSQL & update stats
        const isTerminalState = [
            RIDE_STATES.COMPLETED, 
            RIDE_STATES.CANCELLED_BY_RIDER, 
            RIDE_STATES.CANCELLED_BY_DRIVER, 
            RIDE_STATES.EXPIRED, 
            RIDE_STATES.NO_DRIVERS
        ].includes(toStatus);

        if (isTerminalState) {
            await persistFinalRideToPostgres(ride);
            if (toStatus === RIDE_STATES.COMPLETED) {
                db.memoryState.stats = db.memoryState.stats || {};
                db.memoryState.stats.totalBookings = (db.memoryState.stats.totalBookings || 0) + 1;
                db.memoryState.stats.totalRevenue = (db.memoryState.stats.totalRevenue || 0) + (Number(ride.finalFare || ride.fare) || 0);
            }
        }

        db.saveStateSnapshot();

        // 6. Log transition to PostgreSQL ride_events
        await logRideEvent(
            sId,
            fromStatus,
            toStatus,
            actorInfo.id,
            actorInfo.role,
            actorInfo.lat,
            actorInfo.lon,
            { extraData, timestamp: nowIso }
        );

        // 7. Audit log for sensitive transitions
        if ([RIDE_STATES.ACCEPTED, RIDE_STATES.COMPLETED, RIDE_STATES.CANCELLED_BY_RIDER, RIDE_STATES.CANCELLED_BY_DRIVER].includes(toStatus)) {
            await auditService.logEvent({
                action: `RIDE_STATE_${toStatus}`,
                targetType: 'ride',
                targetId: sId,
                userId: actorInfo.id || 'system',
                details: { fromStatus, toStatus, fare: ride.finalFare || ride.fare, receivedAmount: ride.receivedAmount }
            });
        }

        // 8. Publish real-time events via Redis Pub/Sub
        await redisManager.publishRideEvent(sId, {
            type: 'ride_status_changed',
            event: 'ride_status_changed',
            rideId: sId,
            fromStatus,
            toStatus,
            request: ride
        });

        return {
            success: true,
            fromStatus,
            toStatus,
            ride
        };
    } finally {
        await redisManager.releaseRideLock(sId);
    }
}

module.exports = {
    RIDE_STATES,
    ALLOWED_TRANSITIONS,
    toCanonicalState,
    idempotencyStore,
    checkRateLimit,
    normalizeAddresses,
    calculateDistanceKm,
    validateLocationSpeed,
    logRideEvent,
    persistFinalRideToPostgres,
    transitionRideState
};
