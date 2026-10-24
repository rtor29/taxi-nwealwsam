// Unified Driver Route Service (خدمة مسار الكابتن الموحدة)
// توحيد مصدر الحقيقة: PostgreSQL drivers.fixed_* هو المصدر الوحيد، وRedis مرآة سريعة (cache)
// كل كتابة تكتب في drivers وRedis وroutes معاً عبر هذه الدالة وتبث cluster:sync

const db = require('../../db');
const redisManager = require('../redis/redisClient');

/**
 * حفظ مسار الكابتن بشكل موحد في المصادر الثلاثة (PostgreSQL drivers + Redis + PostgreSQL routes)
 */
async function saveDriverRouteUnified({
    driverId,
    lat,
    lng,
    label,
    destLat = null,
    destLng = null,
    destLabel = '',
    routeName = '',
    routeLocked = true,
    fare = 3000,
    availableSeats = 4,
    totalSeats = 4,
    departureTime = '07:30 ص',
    geoJsonPolyline = null
}) {
    const canonicalDriverId = String(driverId || '').trim();
    if (!canonicalDriverId) {
        throw new Error('Driver ID is required for saving route');
    }

    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);
    if (isNaN(parsedLat) || isNaN(parsedLng)) {
        throw new Error('Invalid start coordinates');
    }

    const parsedDestLat = destLat !== null && destLat !== undefined && destLat !== '' ? parseFloat(destLat) : null;
    const parsedDestLng = destLng !== null && destLng !== undefined && destLng !== '' ? parseFloat(destLng) : null;
    const cleanLabel = String(label || '').trim();
    const cleanDestLabel = String(destLabel || '').trim();
    let cleanRouteName = String(routeName || '').trim();
    if (!cleanRouteName && cleanLabel) {
        cleanRouteName = cleanDestLabel ? `${cleanLabel} ➔ ${cleanDestLabel}` : cleanLabel;
    }

    const parsedFare = parseFloat(fare) || 3000;
    const parsedTotalSeats = parseInt(totalSeats, 10) || 4;
    const parsedAvailSeats = parseInt(availableSeats, 10) || parsedTotalSeats;
    const cleanDepTime = String(departureTime || '07:30 ص').trim();
    const nowIso = new Date().toISOString();
    const isLocked = Boolean(routeLocked);

    // 1. PostgreSQL drivers table (المصدر الوحيد للحقيقة — أعمدة fixed_* فقط، دون المساس بـ permanent_*)
    if (db.isPostgresConnected && db.pool) {
        try {
            await db.pool.query(`
                UPDATE drivers SET
                    fixed_lat = $1,
                    fixed_lng = $2,
                    fixed_label = $3,
                    fixed_dest_lat = $4,
                    fixed_dest_lng = $5,
                    fixed_dest_label = $6,
                    route_name = $7,
                    route_locked = $8,
                    fixed_route_geometry = COALESCE($9, fixed_route_geometry),
                    fixed_updated_at = NOW(),
                    updated_at = NOW()
                WHERE driver_id = $10 
                   OR driver_id = REPLACE($10, '-', '_') 
                   OR driver_id = REPLACE($10, '_', '-')
            `, [
                parsedLat,
                parsedLng,
                cleanLabel,
                parsedDestLat,
                parsedDestLng,
                cleanDestLabel,
                cleanRouteName,
                isLocked,
                geoJsonPolyline ? JSON.stringify(geoJsonPolyline) : null,
                canonicalDriverId
            ]);
        } catch (pgErr) {
            console.error('[UnifiedRouteService] PG drivers update error:', pgErr.message);
        }
    }

    // 2. PostgreSQL routes table (للتوافق ومطابقة الحجوزات — يضمن مطابقة إحداثيات الوجهة بالكامل)
    if (db.isPostgresConnected && db.pool) {
        try {
            const routeId = `route-${canonicalDriverId}`;
            // جلب اسم الكابتن وهاتفه لضمان سلامة حقول جدول routes
            let driverName = 'كابتن توصيله';
            let driverPhone = '';
            const drvInfo = (db.memoryState.drivers || []).find(d => 
                String(d.driverId || d.id) === canonicalDriverId ||
                String(d.driverId || d.id).replace(/[-_]/g, '') === canonicalDriverId.replace(/[-_]/g, '')
            );
            if (drvInfo) {
                driverName = drvInfo.fullName || driverName;
                driverPhone = drvInfo.phoneNumber || driverPhone;
            }

            await db.pool.query(`
                INSERT INTO routes (
                    id, driver_id, driver_name, driver_phone,
                    start_name, end_name, start_lat, start_lon, end_lat, end_lon,
                    fare, available_seats, total_seats, departure_time, status, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Active', NOW()
                )
                ON CONFLICT (id) DO UPDATE SET
                    start_name = EXCLUDED.start_name,
                    end_name = EXCLUDED.end_name,
                    start_lat = EXCLUDED.start_lat,
                    start_lon = EXCLUDED.start_lon,
                    end_lat = EXCLUDED.end_lat,
                    end_lon = EXCLUDED.end_lon,
                    fare = EXCLUDED.fare,
                    available_seats = EXCLUDED.available_seats,
                    total_seats = EXCLUDED.total_seats,
                    departure_time = EXCLUDED.departure_time,
                    status = 'Active'
            `, [
                routeId,
                canonicalDriverId,
                driverName,
                driverPhone,
                cleanLabel,
                cleanDestLabel || cleanLabel,
                parsedLat,
                parsedLng,
                parsedDestLat != null ? parsedDestLat : parsedLat,
                parsedDestLng != null ? parsedDestLng : parsedLng,
                parsedFare,
                parsedAvailSeats,
                parsedTotalSeats,
                cleanDepTime
            ]);
        } catch (rErr) {
            console.error('[UnifiedRouteService] PG routes sync error:', rErr.message);
        }
    }

    // 3. Redis (مرآة سريعة / Cache عبر أنوية PM2)
    if (redisManager && redisManager.isConnected) {
        try {
            await redisManager.setDriverFixedLocation(canonicalDriverId, {
                lat: parsedLat,
                lng: parsedLng,
                label: cleanLabel,
                destLat: parsedDestLat,
                destLng: parsedDestLng,
                destLabel: cleanDestLabel,
                routeName: cleanRouteName,
                fare: parsedFare,
                updatedAt: nowIso
            });

            if (geoJsonPolyline) {
                if (redisManager.client) {
                    await redisManager.client.set(`route:geometry:${canonicalDriverId}`, JSON.stringify(geoJsonPolyline), 'EX', 86400 * 7).catch(() => {});
                    await redisManager.client.del(`route:places:${canonicalDriverId}`).catch(() => {});
                }
            } else if (redisManager.client) {
                // حذف الكاش القديم إذا تغيرت الإحداثيات دون تمرير هندسة جديدة
                await redisManager.client.del(`route:geometry:${canonicalDriverId}`).catch(() => {});
                await redisManager.client.del(`route:places:${canonicalDriverId}`).catch(() => {});
            }
        } catch (rErr) {
            console.error('[UnifiedRouteService] Redis sync error:', rErr.message);
        }
    }

    // 4. الذاكرة المحلية (db.memoryState)
    if (db.memoryState) {
        if (Array.isArray(db.memoryState.drivers)) {
            const memDrv = db.memoryState.drivers.find(d => 
                String(d.driverId || d.id) === canonicalDriverId ||
                String(d.driverId || d.id).replace(/[-_]/g, '') === canonicalDriverId.replace(/[-_]/g, '')
            );
            if (memDrv) {
                memDrv.fixedLat = parsedLat;
                memDrv.fixedLng = parsedLng;
                memDrv.fixedLabel = cleanLabel;
                memDrv.fixedDestLat = parsedDestLat;
                memDrv.fixedDestLng = parsedDestLng;
                memDrv.fixedDestLabel = cleanDestLabel;
                memDrv.routeName = cleanRouteName;
                memDrv.route_name = cleanRouteName;
                memDrv.routeLocked = isLocked;
                memDrv.route_locked = isLocked;
                memDrv.fare = parsedFare;
                memDrv.pricePerSeat = parsedFare;
                memDrv.fixedUpdatedAt = nowIso;
            }
        }

        if (Array.isArray(db.memoryState.routes)) {
            const memR = db.memoryState.routes.find(r => 
                String(r.driverId) === canonicalDriverId ||
                String(r.driverId).replace(/[-_]/g, '') === canonicalDriverId.replace(/[-_]/g, '')
            );
            if (memR) {
                memR.fare = parsedFare;
                memR.startName = cleanLabel;
                memR.endName = cleanDestLabel || cleanLabel;
                memR.startLat = parsedLat;
                memR.startLon = parsedLng;
                memR.endLat = parsedDestLat != null ? parsedDestLat : parsedLat;
                memR.endLon = parsedDestLng != null ? parsedDestLng : parsedLng;
                memR.totalSeats = parsedTotalSeats;
                memR.availableSeats = parsedAvailSeats;
                memR.departureTime = cleanDepTime;
                memR.status = 'Active';
            } else {
                db.memoryState.routes.push({
                    id: `route-${canonicalDriverId}`,
                    routeId: `route-${canonicalDriverId}`,
                    driverId: canonicalDriverId,
                    driverName: 'كابتن توصيله',
                    driverPhone: '',
                    startName: cleanLabel,
                    endName: cleanDestLabel || cleanLabel,
                    startLat: parsedLat,
                    startLon: parsedLng,
                    endLat: parsedDestLat != null ? parsedDestLat : parsedLat,
                    endLon: parsedDestLng != null ? parsedDestLng : parsedLng,
                    fare: parsedFare,
                    availableSeats: parsedAvailSeats,
                    totalSeats: parsedTotalSeats,
                    departureTime: cleanDepTime,
                    status: 'Active',
                    createdAt: nowIso
                });
            }
        }
    }

    // 5. بث التحديث عبر Redis Pub/Sub لأنوية PM2 الستة
    if (redisManager && redisManager.pub) {
        try {
            await redisManager.pub.publish('channel:cluster:sync', JSON.stringify({
                type: 'driver_route_unified_sync',
                driverId: canonicalDriverId,
                fixed_lat: parsedLat,
                fixed_lng: parsedLng,
                fixed_label: cleanLabel,
                fixed_dest_lat: parsedDestLat,
                fixed_dest_lng: parsedDestLng,
                fixed_dest_label: cleanDestLabel,
                route_name: cleanRouteName,
                route_locked: isLocked,
                fare: parsedFare,
                total_seats: parsedTotalSeats,
                departure_time: cleanDepTime,
                updated_at: nowIso
            }));
        } catch (_) {}
    }

    return {
        success: true,
        driverId: canonicalDriverId,
        fixed_lat: parsedLat,
        fixed_lng: parsedLng,
        fixed_label: cleanLabel,
        fixed_dest_lat: parsedDestLat,
        fixed_dest_lng: parsedDestLng,
        fixed_dest_label: cleanDestLabel,
        route_name: cleanRouteName,
        route_locked: isLocked,
        fare: parsedFare,
        total_seats: parsedTotalSeats,
        departure_time: cleanDepTime,
        updated_at: nowIso
    };
}

/**
 * إزالة وتصفير مسار الكابتن بشكل موحد في المصادر الثلاثة
 */
async function clearDriverRouteUnified({ driverId, routeLocked = false }) {
    const canonicalDriverId = String(driverId || '').trim();
    if (!canonicalDriverId) return { success: false, error: 'Driver ID required' };
    const nowIso = new Date().toISOString();

    // 1. PostgreSQL drivers table
    if (db.isPostgresConnected && db.pool) {
        try {
            await db.pool.query(`
                UPDATE drivers SET
                    fixed_lat = NULL,
                    fixed_lng = NULL,
                    fixed_label = NULL,
                    fixed_dest_lat = NULL,
                    fixed_dest_lng = NULL,
                    fixed_dest_label = NULL,
                    route_name = NULL,
                    fixed_route_geometry = NULL,
                    route_locked = $1,
                    fixed_updated_at = NOW(),
                    updated_at = NOW()
                WHERE driver_id = $2 
                   OR driver_id = REPLACE($2, '-', '_') 
                   OR driver_id = REPLACE($2, '_', '-')
            `, [Boolean(routeLocked), canonicalDriverId]);
        } catch (e) {
            console.error('[UnifiedRouteService] PG drivers clear error:', e.message);
        }
    }

    // 2. PostgreSQL routes table
    if (db.isPostgresConnected && db.pool) {
        try {
            await db.pool.query(`
                UPDATE routes SET status = 'Inactive'
                WHERE driver_id = $1 
                   OR driver_id = REPLACE($1, '-', '_') 
                   OR driver_id = REPLACE($1, '_', '-')
                   OR id = $2
            `, [canonicalDriverId, `route-${canonicalDriverId}`]);
        } catch (e) {
            console.error('[UnifiedRouteService] PG routes clear error:', e.message);
        }
    }

    // 3. Redis
    if (redisManager && redisManager.isConnected) {
        try {
            await redisManager.removeDriverFixedLocation(canonicalDriverId);
            if (redisManager.client) {
                await redisManager.client.del(`route:geometry:${canonicalDriverId}`).catch(() => {});
                await redisManager.client.del(`route:places:${canonicalDriverId}`).catch(() => {});
            }
        } catch (_) {}
    }

    // 4. Memory State
    if (db.memoryState) {
        if (Array.isArray(db.memoryState.drivers)) {
            const memDrv = db.memoryState.drivers.find(d => 
                String(d.driverId || d.id) === canonicalDriverId ||
                String(d.driverId || d.id).replace(/[-_]/g, '') === canonicalDriverId.replace(/[-_]/g, '')
            );
            if (memDrv) {
                memDrv.fixedLat = null;
                memDrv.fixedLng = null;
                memDrv.fixedLabel = null;
                memDrv.fixedDestLat = null;
                memDrv.fixedDestLng = null;
                memDrv.fixedDestLabel = null;
                memDrv.routeName = null;
                memDrv.route_name = null;
                memDrv.routeLocked = Boolean(routeLocked);
                memDrv.route_locked = Boolean(routeLocked);
                memDrv.fixedUpdatedAt = nowIso;
            }
        }

        if (Array.isArray(db.memoryState.routes)) {
            db.memoryState.routes = db.memoryState.routes.filter(r => 
                String(r.driverId) !== canonicalDriverId &&
                String(r.driverId).replace(/[-_]/g, '') !== canonicalDriverId.replace(/[-_]/g, '') &&
                r.id !== `route-${canonicalDriverId}`
            );
        }
    }

    // 5. Cluster Sync
    if (redisManager && redisManager.pub) {
        try {
            await redisManager.pub.publish('channel:cluster:sync', JSON.stringify({
                type: 'driver_route_unified_cleared',
                driverId: canonicalDriverId,
                route_locked: Boolean(routeLocked),
                updated_at: nowIso
            }));
        } catch (_) {}
    }

    return {
        success: true,
        driverId: canonicalDriverId,
        fixed_lat: null,
        fixed_lng: null,
        fixed_label: null,
        fixed_dest_lat: null,
        fixed_dest_lng: null,
        fixed_dest_label: null,
        route_name: null,
        route_locked: Boolean(routeLocked)
    };
}

/**
 * جلب مسار الكابتن من المصدر الموحد (Redis أولاً كمرآة سريعة، ثم PostgreSQL drivers.fixed_* فقط)
 * لا يسقط أبداً على routes المشوه ولا على permanent_*
 */
async function getDriverRouteUnified(driverId) {
    const canonicalDriverId = String(driverId || '').trim();
    if (!canonicalDriverId) return null;

    // 1. فحص Redis أولاً
    if (redisManager && redisManager.isConnected) {
        try {
            const redisLoc = await redisManager.getDriverFixedLocation(canonicalDriverId);
            if (redisLoc && redisLoc.lat != null && redisLoc.lng != null && !isNaN(redisLoc.lat) && !isNaN(redisLoc.lng)) {
                return {
                    driverId: canonicalDriverId,
                    fixed_lat: parseFloat(redisLoc.lat),
                    fixed_lng: parseFloat(redisLoc.lng),
                    fixed_label: redisLoc.label || '',
                    fixed_dest_lat: redisLoc.destLat != null ? parseFloat(redisLoc.destLat) : null,
                    fixed_dest_lng: redisLoc.destLng != null ? parseFloat(redisLoc.destLng) : null,
                    fixed_dest_label: redisLoc.destLabel || '',
                    route_name: redisLoc.routeName || '',
                    fare: redisLoc.fare ? parseFloat(redisLoc.fare) : 3000,
                    route_locked: redisLoc.route_locked === 'true' || redisLoc.route_locked === true,
                    updated_at: redisLoc.updatedAt || null,
                    source: 'redis'
                };
            }
        } catch (_) {}
    }

    // 2. إذا لم يكن في Redis: الاستعلام من PostgreSQL drivers حصراً (أعمدة fixed_* فقط)
    if (db.isPostgresConnected && db.pool) {
        try {
            const pgRes = await db.pool.query(`
                SELECT fixed_lat, fixed_lng, fixed_label,
                       fixed_dest_lat, fixed_dest_lng, fixed_dest_label,
                       route_name, route_locked, fixed_updated_at
                FROM drivers
                WHERE driver_id = $1 
                   OR driver_id = REPLACE($1, '-', '_') 
                   OR driver_id = REPLACE($1, '_', '-')
                LIMIT 1
            `, [canonicalDriverId]);

            if (pgRes.rows && pgRes.rows[0]) {
                const r = pgRes.rows[0];
                const lat = r.fixed_lat != null ? parseFloat(r.fixed_lat) : null;
                const lng = r.fixed_lng != null ? parseFloat(r.fixed_lng) : null;

                if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
                    const result = {
                        driverId: canonicalDriverId,
                        fixed_lat: lat,
                        fixed_lng: lng,
                        fixed_label: r.fixed_label || '',
                        fixed_dest_lat: r.fixed_dest_lat != null ? parseFloat(r.fixed_dest_lat) : null,
                        fixed_dest_lng: r.fixed_dest_lng != null ? parseFloat(r.fixed_dest_lng) : null,
                        fixed_dest_label: r.fixed_dest_label || '',
                        route_name: r.route_name || '',
                        fare: 3000,
                        route_locked: r.route_locked === true,
                        updated_at: r.fixed_updated_at || null,
                        source: 'postgres_drivers'
                    };

                    // إعادة ملء Redis (Read-Through Cache) لتبقى المرآة متطابقة
                    if (redisManager && redisManager.isConnected) {
                        redisManager.setDriverFixedLocation(canonicalDriverId, {
                            lat: result.fixed_lat,
                            lng: result.fixed_lng,
                            label: result.fixed_label,
                            destLat: result.fixed_dest_lat,
                            destLng: result.fixed_dest_lng,
                            destLabel: result.fixed_dest_label,
                            routeName: result.route_name,
                            fare: result.fare,
                            updatedAt: result.updated_at
                        }).catch(() => {});
                    }

                    return result;
                }
            }
        } catch (e) {
            console.error('[UnifiedRouteService] PG read error:', e.message);
        }
    }

    // 3. فحص كائن الذاكرة db.memoryState.drivers إن لم يتوفر اتصال بقاعدة البيانات
    if (db.memoryState && Array.isArray(db.memoryState.drivers)) {
        const mem = db.memoryState.drivers.find(d => 
            String(d.driverId || d.id) === canonicalDriverId ||
            String(d.driverId || d.id).replace(/[-_]/g, '') === canonicalDriverId.replace(/[-_]/g, '')
        );
        if (mem && mem.fixedLat != null && mem.fixedLng != null && !isNaN(mem.fixedLat) && !isNaN(mem.fixedLng)) {
            return {
                driverId: canonicalDriverId,
                fixed_lat: parseFloat(mem.fixedLat),
                fixed_lng: parseFloat(mem.fixedLng),
                fixed_label: mem.fixedLabel || '',
                fixed_dest_lat: mem.fixedDestLat != null ? parseFloat(mem.fixedDestLat) : null,
                fixed_dest_lng: mem.fixedDestLng != null ? parseFloat(mem.fixedDestLng) : null,
                fixed_dest_label: mem.fixedDestLabel || '',
                route_name: mem.routeName || '',
                fare: mem.fare || 3000,
                route_locked: mem.routeLocked === true || mem.route_locked === true,
                updated_at: mem.fixedUpdatedAt || null,
                source: 'memory'
            };
        }
    }

    return null;
}

module.exports = {
    saveDriverRouteUnified,
    clearDriverRouteUnified,
    getDriverRouteUnified
};
