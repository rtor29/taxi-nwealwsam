const db = require('../../db');
const backupService = require('../backup/backupService');
const auditService = require('../audit/auditService');
const pricingService = require('../pricing/pricingService');
const complaintService = require('../complaint/complaintService');

// In-Memory Lean Cache for Instant Dashboard Response (<5ms)
let _leanDriversCache = null;
let _leanDriversCacheTime = 0;
let _leanCustomersCache = null;
let _leanCustomersCacheTime = 0;
const DASHBOARD_CACHE_TTL = 3000; // 3 seconds with instant mutation invalidation

function invalidateDriversCache() {
    _leanDriversCache = null;
    _leanDriversCacheTime = 0;
}

function invalidateCustomersCache() {
    _leanCustomersCache = null;
    _leanCustomersCacheTime = 0;
}

function toLeanDriver(d) {
    const routeObj = (db.memoryState.routes || []).find(r => r.driverId === d.driverId);
    const routeName = (routeObj ? (routeObj.name || `${routeObj.startName} - ${routeObj.endName}`) : null) || d.route || 'غير محدد';
    let vType = 'eco';
    const rawVT = String(d.vehicleType || d.vehicle_type || '').toLowerCase();
    if (rawVT === 'super' || rawVT === 'سوبر') vType = 'super';
    else if (rawVT === 'plus' || rawVT === 'vip' || rawVT === 'بلس' || rawVT === 'بلَس') vType = 'plus';
    else vType = 'eco';

    return {
        id: d.id || d.driverId,
        driverId: d.driverId,
        fullName: d.fullName || d.name || 'كابتن توصيلة',
        phoneNumber: d.phoneNumber || d.phone || '',
        email: d.email || '',
        vehicleMake: d.vehicleMake || (d.vehicles && d.vehicles[0] && d.vehicles[0].make) || 'تويوتا',
        vehicleModel: d.vehicleModel || (d.vehicles && d.vehicles[0] && d.vehicles[0].model) || 'كورولا',
        vehiclePlate: d.vehiclePlate || d.plateNumber || (d.vehicles && d.vehicles[0] && d.vehicles[0].plateNumber) || 'النجف',
        vehicleColor: d.vehicleColor || (d.vehicles && d.vehicles[0] && d.vehicles[0].color) || 'أبيض',
        vehicleType: vType,
        serviceType: d.serviceType || 'Both',
        isActive: d.isActive !== false && d.status !== 'Inactive',
        status: d.status || 'Active',
        isApproved: d.is_approved === true || d.isApproved === true,
        isVerified: d.is_verified === true || d.isVerified === true,
        isOnline: d.isOnline === true || d.status === 'Online',
        tripStatus: d.tripStatus || d.trip_status || d.status || 'Offline',
        approvalStatus: d.approvalStatus || (d.is_approved || d.isApproved ? 'Approved' : 'Pending'),
        rating: parseFloat(d.rating || 5.0),
        points: parseInt(d.points || d.rewardScore || 0, 10),
        isBlocked: !!d.isBlocked,
        route: routeName,
        route_name: d.routeName || routeName,
        fixed_lat: d.fixedLat,
        fixed_lng: d.fixedLng,
        fixed_label: d.fixedLabel,
        fixed_dest_lat: d.fixedDestLat,
        fixed_dest_lng: d.fixedDestLng,
        fixed_dest_label: d.fixedDestLabel,
        route_locked: Boolean(d.routeLocked === true || d.route_locked === true),
        governorate: d.governorate || 'najaf',
        password: d.plainPassword || (d.passwordHash ? '••••••••' : '123456'),
        createdAt: d.createdAt || d.registeredAt || new Date().toISOString(),
        telegramChatId: d.telegramChatId || d.telegram_chat_id || '',
        telegramUsername: d.telegramUsername || d.telegram_username || '',
        telegramLinkedAt: d.telegramLinkedAt || d.telegram_linked_at || null,
        workMode: d.work_mode || d.workMode || 'كلاهما'
    };
}

function toLeanCustomer(c) {
    return {
        id: c.id || c.customerId || c.userId,
        customerId: c.customerId || c.id || c.userId,
        fullName: c.fullName || c.name || 'راكب',
        phoneNumber: c.phoneNumber || c.phone || '',
        email: c.email || '',
        isActive: c.isActive !== false && !c.isBlocked,
        isBlocked: !!c.isBlocked,
        route: c.route || c.preferredRoute || c.area || 'النجف الأشرف',
        address: c.address || c.area || 'النجف الأشرف',
        createdAt: c.createdAt || new Date().toISOString(),
        telegramChatId: c.telegramChatId || c.telegram_chat_id || '',
        telegramUsername: c.telegramUsername || c.telegram_username || '',
        telegramLinkedAt: c.telegramLinkedAt || c.telegram_linked_at || null
    };
}

class AdminController {
    // 1. Dynamic Stats (Calculated on the fly from current active records)
    async getStats() {
        return {
            success: true,
            stats: db.getComputedStats()
        };
    }

    // 2. Dynamic Notifications (Real-time pending items with zero stale cache)
    async getNotifications() {
        return {
            success: true,
            ...db.getDynamicNotifications()
        };
    }

    // 3. Drivers Management (Instant In-Memory Lean Cache synced with PostgreSQL single source of truth)
    async getDrivers(search = '') {
        const now = Date.now();
        if (!_leanDriversCache || now - _leanDriversCacheTime > DASHBOARD_CACHE_TTL) {
            let fetched = false;
            if (db.isPostgresConnected && db.pool) {
                try {
                    const pgRes = await db.pool.query(`
                        SELECT d.driver_id, d.full_name, d.phone_number, d.email,
                               d.license_number, d.vehicle_make, d.vehicle_model, d.vehicle_year,
                               d.vehicle_plate, d.vehicle_type, d.status, d.is_verified, d.is_blocked,
                               d.is_approved, d.rating_average, d.total_trips, d.created_at,
                               d.telegram_chat_id, d.telegram_username, d.telegram_linked_at,
                               d.work_mode, d.points, d.governorate,
                               d.fixed_lat, d.fixed_lng, d.fixed_label,
                               d.fixed_dest_lat, d.fixed_dest_lng, d.fixed_dest_label,
                               d.route_name, d.route_locked,
                               r.start_name, r.end_name
                        FROM drivers d
                        LEFT JOIN routes r ON r.driver_id = d.driver_id
                        ORDER BY d.created_at DESC
                    `);
                    if (pgRes.rows) {
                        const memMap = new Map((db.memoryState.drivers || []).map(m => [m.driverId, m]));
                        _leanDriversCache = pgRes.rows.map(r => {
                            const m = memMap.get(r.driver_id) || {};
                            const fixedLat = r.fixed_lat != null ? parseFloat(r.fixed_lat) : (m.fixedLat != null ? parseFloat(m.fixedLat) : null);
                            const fixedLng = r.fixed_lng != null ? parseFloat(r.fixed_lng) : (m.fixedLng != null ? parseFloat(m.fixedLng) : null);
                            const fixedLabel = r.fixed_label || m.fixedLabel || '';
                            const fixedDestLat = r.fixed_dest_lat != null ? parseFloat(r.fixed_dest_lat) : (m.fixedDestLat != null ? parseFloat(m.fixedDestLat) : null);
                            const fixedDestLng = r.fixed_dest_lng != null ? parseFloat(r.fixed_dest_lng) : (m.fixedDestLng != null ? parseFloat(m.fixedDestLng) : null);
                            const fixedDestLabel = r.fixed_dest_label || m.fixedDestLabel || '';
                            const routeLocked = r.route_locked === true || m.routeLocked === true || m.route_locked === true;
                            const routeName = r.route_name || (r.start_name && r.end_name ? `${r.start_name} - ${r.end_name}` : null) || m.route || 'غير محدد';
                            let vType = 'eco';
                            const rawVT = String(r.vehicle_type || m.vehicleType || '').toLowerCase();
                            if (rawVT === 'super' || rawVT === 'سوبر') vType = 'super';
                            else if (rawVT === 'plus' || rawVT === 'vip' || rawVT === 'بلس' || rawVT === 'بلَس') vType = 'plus';
                            else vType = 'eco';

                            // مزامنة كائن الذاكرة أيضاً
                            m.fixedLat = fixedLat;
                            m.fixedLng = fixedLng;
                            m.fixedLabel = fixedLabel;
                            m.fixedDestLat = fixedDestLat;
                            m.fixedDestLng = fixedDestLng;
                            m.fixedDestLabel = fixedDestLabel;
                            m.routeName = routeName;
                            m.route_name = routeName;
                            m.routeLocked = routeLocked;
                            m.route_locked = routeLocked;

                            return {
                                id: r.driver_id,
                                driverId: r.driver_id,
                                fullName: r.full_name || m.fullName || 'كابتن توصيلة',
                                phoneNumber: r.phone_number || m.phoneNumber || '',
                                email: r.email || m.email || '',
                                vehicleMake: r.vehicle_make || m.vehicleMake || 'تويوتا',
                                vehicleModel: r.vehicle_model || m.vehicleModel || 'كورولا',
                                vehiclePlate: r.vehicle_plate || m.vehiclePlate || 'النجف',
                                vehicleColor: m.vehicleColor || 'أبيض',
                                vehicleType: vType,
                                serviceType: m.serviceType || 'Both',
                                isActive: !r.is_blocked && r.status !== 'Inactive',
                                status: r.status || m.status || 'Active',
                                isApproved: r.is_approved === true || m.isApproved === true,
                                isVerified: r.is_verified === true || m.isVerified === true,
                                isOnline: m.isOnline === true || r.status === 'Online',
                                tripStatus: m.tripStatus || r.status || 'Offline',
                                approvalStatus: r.is_approved ? 'Approved' : (m.approvalStatus || 'Pending'),
                                rating: parseFloat(r.rating_average || m.rating || 5.0),
                                points: parseInt(r.points || m.points || 0, 10),
                                isBlocked: !!r.is_blocked,
                                route: routeName,
                                routeName: routeName,
                                route_name: routeName,
                                fixed_lat: fixedLat,
                                fixed_lng: fixedLng,
                                fixed_label: fixedLabel,
                                fixed_dest_lat: fixedDestLat,
                                fixed_dest_lng: fixedDestLng,
                                fixed_dest_label: fixedDestLabel,
                                route_locked: routeLocked,
                                createdAt: r.created_at ? new Date(r.created_at).toISOString() : (m.createdAt || new Date().toISOString()),
                                telegramChatId: r.telegram_chat_id || m.telegramChatId || '',
                                telegramUsername: r.telegram_username || m.telegramUsername || '',
                                telegramLinkedAt: r.telegram_linked_at || m.telegramLinkedAt || null,
                                workMode: r.work_mode || m.workMode || 'كلاهما'
                            };
                        });
                        _leanDriversCacheTime = now;
                        fetched = true;
                    }
                } catch (pgErr) {
                    console.warn('[AdminController] PG drivers fetch error, falling back to memoryState:', pgErr.message);
                }
            }

            if (!fetched) {
                _leanDriversCache = (db.memoryState.drivers || []).map(toLeanDriver);
                _leanDriversCacheTime = now;
            }
        }

        let drivers = _leanDriversCache;
        if (search) {
            const q = search.toLowerCase();
            drivers = drivers.filter(d => 
                (d.fullName && d.fullName.toLowerCase().includes(q)) ||
                (d.phoneNumber && d.phoneNumber.includes(q)) ||
                (d.vehiclePlate && d.vehiclePlate.toLowerCase().includes(q))
            );
        }

        return {
            success: true,
            total: drivers.length,
            drivers: drivers
        };
    }

    async updateDriver(driverId, data) {
        let driver = db.memoryState.drivers.find(d => d.driverId === driverId);
        if (!driver && db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM drivers WHERE driver_id = $1 LIMIT 1', [driverId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    const row = pgRes.rows[0];
                    driver = {
                        driverId: row.driver_id,
                        fullName: row.full_name,
                        phoneNumber: row.phone_number,
                        email: row.email,
                        plainPassword: row.plain_password,
                        passwordHash: row.password_hash,
                        status: row.status,
                        isVerified: row.is_verified,
                        isBlocked: row.is_blocked,
                        governorate: row.governorate || 'najaf',
                        vehicleType: row.vehicle_type || 'eco',
                        telegramChatId: row.telegram_chat_id ? String(row.telegram_chat_id) : null
                    };
                    db.memoryState.drivers.unshift(driver);
                }
            } catch (_) {}
        }
        if (!driver) return { success: false, error: 'السائق غير موجود' };

        const nameVal = data.fullName !== undefined ? data.fullName : (data.name !== undefined ? data.name : (data.full_name !== undefined ? data.full_name : undefined));
        if (nameVal !== undefined) driver.fullName = String(nameVal).trim();
        const phoneVal = data.phoneNumber !== undefined ? data.phoneNumber : (data.phone !== undefined ? data.phone : (data.phone_number !== undefined ? data.phone_number : undefined));
        if (phoneVal !== undefined) {
            const rawP = String(phoneVal).trim();
            driver.phoneNumber = rawP;
            const normP = rawP.replace(/[^0-9]/g, '');
            if (normP.length >= 7) {
                db.memoryState.customers = (db.memoryState.customers || []).filter(c => {
                    const cn = String(c.phoneNumber || c.phone || '').replace(/[^0-9]/g, '');
                    return !(cn === normP || (cn.length >= 7 && (cn.endsWith(normP) || normP.endsWith(cn))));
                });
                if (db.isPostgresConnected && db.pool) {
                    db.pool.query('DELETE FROM customers WHERE phone_number LIKE $1 OR phone_number LIKE $2', [`%${normP}`, `%0${normP}`]).catch(() => {});
                }
            }
        }
        if (data.governorate !== undefined) driver.governorate = String(data.governorate).trim();
        if (data.vehicleType !== undefined) {
            const rawVT = String(data.vehicleType || '').toLowerCase();
            if (rawVT === 'super' || rawVT === 'سوبر') driver.vehicleType = 'super';
            else if (rawVT === 'plus' || rawVT === 'vip' || rawVT === 'بلس' || rawVT === 'بلَس') driver.vehicleType = 'plus';
            else driver.vehicleType = 'eco';
        }
        if (data.telegramChatId !== undefined || data.telegram_chat_id !== undefined) {
            const rawTg = String(data.telegramChatId !== undefined ? data.telegramChatId : data.telegram_chat_id).trim();
            driver.telegramChatId = rawTg || null;
            driver.telegram_chat_id = driver.telegramChatId;
            if (driver.telegramChatId && !driver.telegramLinkedAt) {
                driver.telegramLinkedAt = new Date().toISOString();
                driver.telegram_linked_at = driver.telegramLinkedAt;
            }
            if (db.isPostgresConnected && db.pool) {
                try {
                    await db.pool.query('UPDATE drivers SET telegram_chat_id = $1, telegram_linked_at = CASE WHEN $1 IS NOT NULL AND telegram_linked_at IS NULL THEN NOW() ELSE telegram_linked_at END WHERE driver_id = $2', [driver.telegramChatId, driverId]);
                } catch (_) {}
            }
        }
        if (data.availableSeats !== undefined) {
            driver.availableSeats = parseInt(data.availableSeats, 10) || 4;
            driver.totalSeats = driver.totalSeats || driver.availableSeats;
        }
        if (data.totalSeats !== undefined) {
            driver.totalSeats = parseInt(data.totalSeats, 10) || 4;
        }
        if (data.route) {
            driver.serviceType = 'Both';
            driver.work_mode = 'خط دائمي';
        }

        if (data.password !== undefined && String(data.password).trim() !== '') {
            const crypto = require('crypto');
            const pass = String(data.password).trim();
            driver.plainPassword = pass;
            driver.passwordHash = crypto.createHash('sha256').update(pass).digest('hex');
        }

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE drivers 
                    SET full_name = $1, phone_number = $2, password_hash = COALESCE($3, password_hash), plain_password = COALESCE($4, plain_password),
                        vehicle_type = COALESCE($5, vehicle_type), governorate = COALESCE($6, governorate), updated_at = NOW()
                    WHERE driver_id = $7
                `, [driver.fullName, driver.phoneNumber, driver.passwordHash || null, driver.plainPassword || null, driver.vehicleType || 'eco', driver.governorate || 'najaf', driverId]);

                await db.pool.query(`
                    UPDATE users 
                    SET full_name = $1, phone_number = $2, password_hash = COALESCE($3, password_hash), plain_password = COALESCE($4, plain_password), updated_at = NOW()
                    WHERE id = $5
                `, [driver.fullName, driver.phoneNumber, driver.passwordHash || null, driver.plainPassword || null, driverId]);
            } catch (e) {
                console.error('[AdminController] updateDriver PG error:', e);
            }
        }

        // Batch 7: إدارة المسار الموحدة عبر unifiedRouteService
        const unifiedRouteService = require('../routes/unifiedRouteService');
        _leanDriversCache = null; // تفريغ كاش الداش بورد فوراً ليرى التعديلات

        if (data.clearRoute === true || data.clear_route === true) {
            await unifiedRouteService.clearDriverRouteUnified({
                driverId,
                routeLocked: false
            });
        } else {
            // فحص المدخلات: لا نكتب NULL فوق إحداثيات موجودة إن كانت الحقول فارغة في النموذج (تجاهل الفارغ)
            const rawStartLat = data.fixed_lat !== undefined ? data.fixed_lat : data.fixedLat;
            const rawStartLng = data.fixed_lng !== undefined ? data.fixed_lng : data.fixedLng;
            const rawStartLabel = data.fixed_label !== undefined ? data.fixed_label : data.fixedLabel;
            const rawDestLat = data.fixed_dest_lat !== undefined ? data.fixed_dest_lat : data.fixedDestLat;
            const rawDestLng = data.fixed_dest_lng !== undefined ? data.fixed_dest_lng : data.fixedDestLng;
            const rawDestLabel = data.fixed_dest_label !== undefined ? data.fixed_dest_label : data.fixedDestLabel;
            const rawRouteName = data.route_name !== undefined ? data.route_name : (data.routeName || data.route);
            const rawLocked = data.route_locked !== undefined ? data.route_locked : data.routeLocked;

            const hasValidStartLat = rawStartLat !== undefined && rawStartLat !== '' && rawStartLat !== null && !isNaN(parseFloat(rawStartLat));
            const hasValidStartLng = rawStartLng !== undefined && rawStartLng !== '' && rawStartLng !== null && !isNaN(parseFloat(rawStartLng));
            const hasValidDestLat = rawDestLat !== undefined && rawDestLat !== '' && rawDestLat !== null && !isNaN(parseFloat(rawDestLat));
            const hasValidDestLng = rawDestLng !== undefined && rawDestLng !== '' && rawDestLng !== null && !isNaN(parseFloat(rawDestLng));

            // الاحتفاظ بالإحداثيات القائمة وعدم استبدالها بـ NULL عند الفراغ
            const effectiveLat = hasValidStartLat ? parseFloat(rawStartLat) : (driver.fixedLat != null ? driver.fixedLat : null);
            const effectiveLng = hasValidStartLng ? parseFloat(rawStartLng) : (driver.fixedLng != null ? driver.fixedLng : null);
            const effectiveDestLat = hasValidDestLat ? parseFloat(rawDestLat) : (driver.fixedDestLat != null ? driver.fixedDestLat : null);
            const effectiveDestLng = hasValidDestLng ? parseFloat(rawDestLng) : (driver.fixedDestLng != null ? driver.fixedDestLng : null);
            const effectiveLabel = (rawStartLabel !== undefined && String(rawStartLabel).trim() !== '') ? String(rawStartLabel).trim() : (driver.fixedLabel || '');
            const effectiveDestLabel = (rawDestLabel !== undefined && String(rawDestLabel).trim() !== '') ? String(rawDestLabel).trim() : (driver.fixedDestLabel || '');
            const effectiveRouteName = (rawRouteName !== undefined && String(rawRouteName).trim() !== '') ? String(rawRouteName).trim() : (driver.routeName || driver.route || '');
            const effectiveLocked = rawLocked !== undefined ? (rawLocked === true || rawLocked === 'true') : Boolean(driver.routeLocked === true || driver.route_locked === true);

            if (effectiveLat != null && effectiveLng != null) {
                // حفظ المسار في drivers و Redis و routes معاً عبر الدالة الموحدة
                await unifiedRouteService.saveDriverRouteUnified({
                    driverId,
                    lat: effectiveLat,
                    lng: effectiveLng,
                    label: effectiveLabel || 'نقطة الانطلاق',
                    destLat: effectiveDestLat,
                    destLng: effectiveDestLng,
                    destLabel: effectiveDestLabel || 'نقطة الوصول',
                    routeName: effectiveRouteName,
                    routeLocked: effectiveLocked,
                    fare: driver.fare || 3000,
                    availableSeats: driver.availableSeats || 4,
                    totalSeats: driver.totalSeats || 4
                });
            } else if (rawLocked !== undefined) {
                // تعديل حالة القفل فقط إن لم تتوفر إحداثيات
                driver.routeLocked = effectiveLocked;
                driver.route_locked = effectiveLocked;
                if (db.isPostgresConnected && db.pool) {
                    await db.pool.query('UPDATE drivers SET route_locked = $1 WHERE driver_id = $2', [effectiveLocked, driverId]).catch(() => {});
                }
                const redisManager = require('../redis/redisClient');
                if (redisManager && redisManager.client) {
                    await redisManager.client.hset(`driver:${driverId}:meta`, 'route_locked', String(effectiveLocked)).catch(() => {});
                }
            }
        }

        if (redisManager && redisManager.client) {
            redisManager.client.hset(`driver:${driverId}:meta`, {
                fullName: String(driver.fullName || ''),
                phoneNumber: String(driver.phoneNumber || ''),
                route_name: String(driver.routeName || driver.route || ''),
                route_locked: String(driver.routeLocked === true),
                governorate: String(driver.governorate || 'najaf'),
                vehicleType: String(driver.vehicleType || 'eco'),
                tier: String(driver.vehicleType || 'eco')
            }).catch(() => {});
        }

        if (redisManager && redisManager.pub) {
            redisManager.pub.publish('channel:cluster:sync', JSON.stringify({
                type: 'driver_update_sync',
                driverId,
                fullName: driver.fullName,
                phoneNumber: driver.phoneNumber,
                route: driver.route,
                routeName: driver.routeName,
                governorate: driver.governorate || 'najaf',
                vehicleType: driver.vehicleType || 'eco',
                fixed_lat: driver.fixedLat,
                fixed_lng: driver.fixedLng,
                fixed_label: driver.fixedLabel,
                fixed_dest_lat: driver.fixedDestLat,
                fixed_dest_lng: driver.fixedDestLng,
                fixed_dest_label: driver.fixedDestLabel,
                route_locked: driver.routeLocked === true,
                work_mode: driver.work_mode
            })).catch(() => {});
        }

        invalidateDriversCache();

        db.addAuditLog('DriverUpdated', 'Driver', driverId, {
            fullName: driver.fullName,
            phoneNumber: driver.phoneNumber,
            route: driver.route
        });
        db.saveStateSnapshot();
        return { success: true, driver };
    }

    async getDriverById(driverId) {
        let driver = db.memoryState.drivers.find(d => d.driverId === driverId || d.id === driverId || String(d.driverId).replace(/[-_]/g, '') === String(driverId).replace(/[-_]/g, ''));
        if (db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM drivers WHERE driver_id = $1 OR driver_id = $2 OR driver_id = $3 LIMIT 1', [driverId, String(driverId).replace(/-/g, '_'), String(driverId).replace(/_/g, '-')]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    const row = pgRes.rows[0];
                    if (!driver) {
                        driver = {
                            driverId: row.driver_id,
                            fullName: row.full_name,
                            phoneNumber: row.phone_number,
                            status: row.status,
                            isVerified: row.is_verified,
                            isBlocked: row.is_blocked,
                            route_locked: row.route_locked === true,
                            fixedLat: row.fixed_lat ? parseFloat(row.fixed_lat) : null,
                            fixedLng: row.fixed_lng ? parseFloat(row.fixed_lng) : null,
                            fixedLabel: row.fixed_label || '',
                            fixedDestLat: row.fixed_dest_lat ? parseFloat(row.fixed_dest_lat) : null,
                            fixedDestLng: row.fixed_dest_lng ? parseFloat(row.fixed_dest_lng) : null,
                            fixedDestLabel: row.fixed_dest_label || '',
                            routeName: row.route_name || '',
                            governorate: row.governorate || 'najaf',
                            vehicleType: row.vehicle_type || 'eco'
                        };
                        db.memoryState.drivers.push(driver);
                    } else {
                        driver.fullName = row.full_name || driver.fullName;
                        driver.phoneNumber = row.phone_number || driver.phoneNumber;
                        driver.status = row.status || driver.status;
                        driver.route_locked = row.route_locked === true;
                        driver.routeLocked = row.route_locked === true;
                        driver.governorate = row.governorate || driver.governorate || 'najaf';
                        driver.vehicleType = row.vehicle_type || driver.vehicleType || 'eco';
                        if (row.fixed_lat) driver.fixedLat = parseFloat(row.fixed_lat);
                        if (row.fixed_lng) driver.fixedLng = parseFloat(row.fixed_lng);
                        if (row.fixed_label) driver.fixedLabel = row.fixed_label;
                        if (row.fixed_dest_lat) driver.fixedDestLat = parseFloat(row.fixed_dest_lat);
                        if (row.fixed_dest_lng) driver.fixedDestLng = parseFloat(row.fixed_dest_lng);
                        if (row.fixed_dest_label) driver.fixedDestLabel = row.fixed_dest_label;
                        if (row.route_name) driver.routeName = row.route_name;
                    }
                }
            } catch (_) {}
        }
        if (!driver) return { success: false, error: 'السائق غير موجود' };

        // Attach documents, vehicle details, and routes
        const documents = db.memoryState.verifications.filter(v => v.driverId === driverId);
        const routes = db.memoryState.routes.filter(r => r.driverId === driverId);
        const vehicles = [{
            make: driver.vehicleMake || 'تويوتا',
            model: driver.vehicleModel || 'كورولا',
            year: driver.vehicleYear || 2023,
            plateNumber: driver.vehiclePlate || 'النجف 1000'
        }];

        return {
            success: true,
            driverId: driver.driverId,
            fullName: driver.fullName,
            phoneNumber: driver.phoneNumber,
            email: driver.email,
            licenseNumber: driver.licenseNumber,
            status: driver.status,
            isVerified: driver.isVerified,
            isBlocked: driver.isBlocked,
            rejectionReason: driver.rejectionReason,
            ratingAverage: driver.ratingAverage,
            totalTrips: driver.totalTrips,
            fixed_lat: driver.fixedLat,
            fixed_lng: driver.fixedLng,
            fixed_label: driver.fixedLabel,
            fixed_dest_lat: driver.fixedDestLat,
            fixed_dest_lng: driver.fixedDestLng,
            fixed_dest_label: driver.fixedDestLabel,
            route_name: driver.routeName,
            route_locked: Boolean(driver.routeLocked === true || driver.route_locked === true),
            vehicles,
            documents,
            routes
        };
    }

    async setDriverStatus(driverId, newStatus, reason = null) {
        const validStatuses = ['Approved', 'Rejected', 'Suspended', 'Pending', 'Online', 'Offline'];
        if (!validStatuses.includes(newStatus)) {
            return { success: false, error: 'حالة غير صالحة' };
        }

        const result = await db.setDriverStatus(driverId, newStatus, reason);
        invalidateDriversCache();
        return result;
    }

    async setDriverApproval(driverId, isApproved) {
        const result = await db.setDriverApproval(driverId, isApproved);
        invalidateDriversCache();
        if (isApproved && result && result.success) {
            setImmediate(async () => {
                try {
                    const telegramBot = require('../telegram/telegramBot');
                    const redisManager = require('../redis/redisClient');
                    const driver = result.driver || (db.memoryState && db.memoryState.drivers ? db.memoryState.drivers.find(d => d.driverId === driverId) : null);
                    const phone = driver ? (driver.phoneNumber || driver.phone) : null;
                    const chatId = await telegramBot.findDriverTelegramChatId(driverId, phone);
                    if (!chatId) {
                        console.log(`[DriverApproval] Driver ${driverId} has no telegramChatId linked. Skipping telegram notification.`);
                        return;
                    }
                    const lockAcquired = await redisManager.acquireTelegramNotificationLock(`driver-approved:${driverId}`, 86400);
                    if (!lockAcquired) {
                        console.log(`[DriverApproval] Telegram approval notification for driver ${driverId} already sent (dedup lock active).`);
                        return;
                    }
                    const text = 'تمت الموافقة على حسابك ✅ أصبحت جاهزاً للعمل على تطبيق توصيله';
                    await telegramBot.sendMessage(chatId, text);
                    console.log(`[DriverApproval] Sent approval notification to driver ${driverId} (chatId: ${chatId.slice(0, 3)}****)`);
                } catch (tgErr) {
                    console.error(`[DriverApproval] Telegram approval notification error for ${driverId}:`, tgErr.message);
                }
            });
        }
        return result;
    }

    async setDriverWorkMode(driverId, workMode) {
        return await db.setDriverWorkMode(driverId, workMode);
    }

    async toggleDriverBlock(driverId, isBlocked) {
        let driver = db.memoryState.drivers.find(d => d.driverId === driverId);
        if (!driver && db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM drivers WHERE driver_id = $1 LIMIT 1', [driverId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    const row = pgRes.rows[0];
                    driver = {
                        driverId: row.driver_id,
                        fullName: row.full_name,
                        phoneNumber: row.phone_number,
                        email: row.email,
                        plainPassword: row.plain_password,
                        passwordHash: row.password_hash,
                        status: row.status,
                        isVerified: row.is_verified,
                        isBlocked: row.is_blocked
                    };
                    db.memoryState.drivers.unshift(driver);
                }
            } catch (_) {}
        }
        if (!driver) return { success: false, error: 'السائق غير موجود' };

        driver.isBlocked = !!isBlocked;
        if (driver.isBlocked) {
            driver.status = 'Suspended';
        } else if (driver.isVerified) {
            driver.status = 'Approved';
        }

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE drivers SET is_blocked = $1, status = $2, updated_at = NOW() WHERE driver_id = $3
                `, [driver.isBlocked, driver.status, driverId]);
                await db.pool.query(`
                    UPDATE users SET is_blocked = $1, is_active = $2, updated_at = NOW() WHERE id = $3
                `, [driver.isBlocked, !driver.isBlocked, driverId]);
            } catch (e) {
                console.error('[AdminController] toggleDriverBlock PG error:', e);
            }
        }

        db.addAuditLog(isBlocked ? 'DriverBlocked' : 'DriverUnblocked', 'Driver', driverId, { isBlocked });
        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return { success: true, isBlocked: driver.isBlocked, status: driver.status };
    }

    async deleteDriver(driverId) {
        const res = await db.deleteDriver(driverId);
        invalidateDriversCache();
        return res;
    }

    async getPendingVerifications() {
        // Collect drivers that are in 'Pending' status or have pending documents
        const pendingDriversMap = new Map();

        for (const driver of db.memoryState.drivers) {
            if (driver.status === 'Pending' || !driver.isVerified) {
                pendingDriversMap.set(driver.driverId, driver);
            }
        }

        for (const doc of db.memoryState.verifications) {
            if (doc.status === 'Pending') {
                const driver = db.memoryState.drivers.find(d => d.driverId === doc.driverId);
                if (driver) {
                    pendingDriversMap.set(driver.driverId, driver);
                }
            }
        }

        const result = [];
        for (const [driverId, driver] of pendingDriversMap.entries()) {
            const documents = db.memoryState.verifications
                .filter(v => v.driverId === driverId)
                .map(v => ({
                    id: v.documentId,
                    documentId: v.documentId,
                    driverId: v.driverId,
                    documentType: v.documentType || 'DrivingLicense',
                    status: v.status || driver.status || 'Pending',
                    filePath: v.filePath,
                    fileUrl: v.fileUrl || v.filePath,
                    rejectionReason: v.rejectionReason,
                    submittedAt: v.submittedAt
                }));

            const vehicles = [{
                make: driver.vehicleMake || 'تويوتا',
                model: driver.vehicleModel || 'صالون',
                year: driver.vehicleYear || 2023,
                plateNumber: driver.vehiclePlate || 'النجف'
            }];

            const routes = db.memoryState.routes.filter(r => r.driverId === driverId);

            result.push({
                driverId: driver.driverId,
                fullName: driver.fullName,
                phoneNumber: driver.phoneNumber,
                licenseNumber: driver.licenseNumber,
                status: driver.status,
                vehicles,
                documents,
                routes
            });
        }

        return result;
    }

    async verifyDocument(docId, approved, rejectionReason = null) {
        let doc = db.memoryState.verifications.find(v => v.documentId === docId || v.documentId === 'doc-' + docId);
        let driver = null;

        if (doc) {
            driver = db.memoryState.drivers.find(d => d.driverId === doc.driverId);
        } else {
            driver = db.memoryState.drivers.find(d => d.driverId === docId || 'doc-' + d.driverId === docId);
            if (driver) {
                doc = db.memoryState.verifications.find(v => v.driverId === driver.driverId);
            }
        }

        if (!driver && !doc) {
            return { success: false, error: 'المستند أو السائق غير موجود' };
        }

        const newStatus = approved ? 'Approved' : 'Rejected';
        return await db.setDriverStatus(driver ? driver.driverId : doc.driverId, newStatus, rejectionReason);
    }

    // 5. Customers Management (Instant In-Memory Lean Cache)
    async getCustomers(search = '') {
        const now = Date.now();
        if (!_leanCustomersCache || now - _leanCustomersCacheTime > DASHBOARD_CACHE_TTL) {
            _leanCustomersCache = (db.memoryState.customers || []).map(toLeanCustomer);
            _leanCustomersCacheTime = now;
        }

        let customers = _leanCustomersCache;
        if (search) {
            const q = search.toLowerCase();
            customers = customers.filter(c =>
                (c.fullName && c.fullName.toLowerCase().includes(q)) ||
                (c.phoneNumber && c.phoneNumber.includes(q)) ||
                (c.email && c.email.toLowerCase().includes(q))
            );
        }

        return {
            success: true,
            total: customers.length,
            customers: customers
        };
    }

    async createCustomer(data) {
        const { fullName, phoneNumber, password, route, address } = data;
        if (!fullName || !phoneNumber) {
            return { success: false, error: 'الاسم الكامل ورقم الهاتف مطلوبان.' };
        }

        // Iraqi Phone Normalization
        const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
        let norm = String(phoneNumber || '').replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
        if (norm.startsWith('00964')) norm = norm.substring(5);
        else if (norm.startsWith('964')) norm = norm.substring(3);
        if (norm.length === 10 && norm.startsWith('7')) norm = '0' + norm;

        const cleanPhone = (p) => {
            if (!p) return '';
            let s = String(p).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
            if (s.startsWith('00964')) s = s.substring(5);
            else if (s.startsWith('964')) s = s.substring(3);
            if (s.length === 10 && s.startsWith('7')) s = '0' + s;
            return s;
        };

        const existsInDrivers = (db.memoryState.drivers || []).some(d => cleanPhone(d.phoneNumber) === norm || (norm.length >= 6 && cleanPhone(d.phoneNumber).endsWith(norm)));
        const existsInCustomers = (db.memoryState.customers || []).some(c => cleanPhone(c.phoneNumber) === norm || (norm.length >= 6 && cleanPhone(c.phoneNumber).endsWith(norm)));
        if (norm.length >= 6 && (existsInDrivers || existsInCustomers)) {
            return {
                success: false,
                duplicate: true,
                error: 'رقم الهاتف مسجل بالفعل في المنصة، يرجى اختيار رقم آخر.'
            };
        }

        const crypto = require('crypto');
        const rawPassword = (password && String(password).trim()) ? String(password).trim() : crypto.randomUUID();
        const pass = (password && String(password).trim()) ? String(password).trim() : '';
        const passwordHash = crypto.createHash('sha256').update(rawPassword).digest('hex');
        const customerId = 'usr-c-' + Math.random().toString(36).substr(2, 9);
        const now = new Date().toISOString();
        const userRoute = (route || 'النجف الأشرف').trim();
        const userAddress = (address || 'النجف الأشرف').trim();
        const normalizedPhone = norm.startsWith('0') ? norm : ('0' + norm);

        const rawCustTg = (data.telegramChatId || data.telegram_chat_id) ? String(data.telegramChatId || data.telegram_chat_id).trim() : null;

        const newCustomer = {
            customerId,
            fullName: fullName.trim(),
            phoneNumber: normalizedPhone,
            email: `${normalizedPhone}@tawseelaiq.app`,
            route: userRoute,
            address: userAddress,
            area: userAddress,
            plainPassword: pass,
            passwordHash: passwordHash,
            preferredPaymentMethod: 'Cash',
            ratingAverage: 5.0,
            totalBookings: 0,
            isActive: true,
            isBlocked: false,
            registeredAt: now,
            createdByAdmin: true,
            telegramChatId: rawCustTg,
            telegram_chat_id: rawCustTg,
            telegramLinkedAt: rawCustTg ? now : null,
            telegram_linked_at: rawCustTg ? now : null
        };

        db.memoryState.customers.unshift(newCustomer);

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    INSERT INTO users (id, phone_number, email, full_name, role, password_hash, plain_password, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, 'Customer', $5, $6, true, false, $7)
                    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, password_hash = EXCLUDED.password_hash, plain_password = EXCLUDED.plain_password
                `, [customerId, normalizedPhone, newCustomer.email, newCustomer.fullName, passwordHash, pass, now]);

                await db.pool.query(`
                    INSERT INTO customers (customer_id, full_name, phone_number, email, route, address, plain_password, password_hash, preferred_payment_method, rating_average, total_bookings, is_active, is_blocked, created_at, telegram_chat_id, telegram_linked_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Cash', 5.0, 0, true, false, $9, $10, $11)
                    ON CONFLICT (customer_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, route = EXCLUDED.route, address = EXCLUDED.address, plain_password = EXCLUDED.plain_password, password_hash = EXCLUDED.password_hash, telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, customers.telegram_chat_id)
                `, [customerId, newCustomer.fullName, normalizedPhone, newCustomer.email, userRoute, userAddress, pass, passwordHash, now, rawCustTg, rawCustTg ? now : null]);
            } catch (e) {
                console.error('[AdminController] createCustomer PG error:', e);
            }
        }

        db.addAuditLog('CustomerCreatedByAdmin', 'Customer', customerId, {
            fullName: newCustomer.fullName,
            phoneNumber: normalizedPhone,
            route: userRoute,
            address: userAddress
        });
        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return {
            success: true,
            message: 'تم إنشاء وتفعيل حساب الراكب بنجاح',
            customer: newCustomer
        };
    }

    async updateCustomer(customerId, data) {
        let customer = db.memoryState.customers.find(c => c.customerId === customerId);
        if (!customer && db.isPostgresConnected && db.pool) {
            try {
                const pgCust = await db.pool.query('SELECT * FROM customers WHERE customer_id = $1 LIMIT 1', [customerId]);
                if (pgCust.rows && pgCust.rows.length > 0) {
                    const row = pgCust.rows[0];
                    customer = {
                        customerId: row.customer_id,
                        fullName: row.full_name,
                        phoneNumber: row.phone_number,
                        email: row.email,
                        route: row.route,
                        address: row.address,
                        plainPassword: row.plain_password || null,
                        passwordHash: row.password_hash || null,
                        isActive: row.is_active,
                        isBlocked: row.is_blocked
                    };
                    db.memoryState.customers.unshift(customer);
                }
            } catch (_) {}
        }
        if (!customer) return { success: false, error: 'الراكب غير موجود' };

        if (data.fullName !== undefined) customer.fullName = String(data.fullName).trim();
        if (data.phoneNumber !== undefined) customer.phoneNumber = String(data.phoneNumber).trim();
        if (data.governorate !== undefined) customer.governorate = String(data.governorate).trim();
        if (data.permanentLat !== undefined && data.permanentLat !== null && data.permanentLat !== '') customer.permanentLat = parseFloat(data.permanentLat);
        if (data.permanentLon !== undefined && data.permanentLon !== null && data.permanentLon !== '') customer.permanentLon = parseFloat(data.permanentLon);
        if (data.permanentLocationName !== undefined) customer.permanentLocationName = String(data.permanentLocationName).trim();
        if (data.permanentDropoffLat !== undefined && data.permanentDropoffLat !== null && data.permanentDropoffLat !== '') customer.permanentDropoffLat = parseFloat(data.permanentDropoffLat);
        if (data.permanentDropoffLon !== undefined && data.permanentDropoffLon !== null && data.permanentDropoffLon !== '') customer.permanentDropoffLon = parseFloat(data.permanentDropoffLon);
        if (data.permanentDropoffName !== undefined) customer.permanentDropoffName = String(data.permanentDropoffName).trim();
        if (data.route !== undefined) customer.route = String(data.route).trim();
        if (data.address !== undefined) {
            customer.address = String(data.address).trim();
            customer.area = customer.address;
        }
        if (data.password !== undefined && String(data.password).trim() !== '') {
            const crypto = require('crypto');
            const pass = String(data.password).trim();
            customer.plainPassword = pass;
            customer.passwordHash = crypto.createHash('sha256').update(pass).digest('hex');
        }

        if (data.telegramChatId !== undefined || data.telegram_chat_id !== undefined) {
            const rawTg = String(data.telegramChatId !== undefined ? data.telegramChatId : data.telegram_chat_id).trim();
            customer.telegramChatId = rawTg || null;
            customer.telegram_chat_id = customer.telegramChatId;
            if (customer.telegramChatId && !customer.telegramLinkedAt) {
                customer.telegramLinkedAt = new Date().toISOString();
                customer.telegram_linked_at = customer.telegramLinkedAt;
            }
        }

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE customers 
                    SET full_name = $1, phone_number = $2, route = $3, address = $4, plain_password = $5, password_hash = $6,
                        telegram_chat_id = $7,
                        telegram_linked_at = CASE WHEN $7 IS NOT NULL AND telegram_linked_at IS NULL THEN NOW() ELSE telegram_linked_at END
                    WHERE customer_id = $8
                `, [customer.fullName, customer.phoneNumber, customer.route, customer.address, customer.plainPassword, customer.passwordHash, customer.telegramChatId, customerId]);

                await db.pool.query(`
                    UPDATE users 
                    SET full_name = $1, phone_number = $2, password_hash = $3, plain_password = $4
                    WHERE id = $5
                `, [customer.fullName, customer.phoneNumber, customer.passwordHash, customer.plainPassword, customerId]);
            } catch (e) {
                console.error('[AdminController] updateCustomer PG error:', e);
            }
        }

        db.addAuditLog('CustomerUpdated', 'Customer', customerId, {
            fullName: customer.fullName,
            phoneNumber: customer.phoneNumber,
            route: customer.route,
            address: customer.address
        });
        db.saveStateSnapshot();
        if (customer.permanentLat && customer.permanentLon) {
            db.persistCustomerPermanentLocation(customerId, {
                lat: customer.permanentLat, lon: customer.permanentLon, locationName: customer.permanentLocationName,
                dropoffLat: customer.permanentDropoffLat, dropoffLon: customer.permanentDropoffLon, dropoffName: customer.permanentDropoffName
            }).catch(()=>{});
        }

        return { success: true, customer };
    }

    async toggleCustomerBlock(customerId, isBlocked) {
        let customer = db.memoryState.customers.find(c => c.customerId === customerId);
        if (!customer && db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM customers WHERE customer_id = $1 LIMIT 1', [customerId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    const row = pgRes.rows[0];
                    customer = {
                        customerId: row.customer_id,
                        fullName: row.full_name,
                        phoneNumber: row.phone_number,
                        email: row.email,
                        plainPassword: row.plain_password,
                        passwordHash: row.password_hash,
                        isActive: row.is_active,
                        isBlocked: row.is_blocked
                    };
                    db.memoryState.customers.unshift(customer);
                }
            } catch (_) {}
        }
        if (!customer) return { success: false, error: 'الراكب غير موجود' };

        customer.isBlocked = !!isBlocked;
        customer.isActive = !customer.isBlocked;

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE customers SET is_blocked = $1, is_active = $2, updated_at = NOW() WHERE customer_id = $3
                `, [customer.isBlocked, customer.isActive, customerId]);
                await db.pool.query(`
                    UPDATE users SET is_blocked = $1, is_active = $2, updated_at = NOW() WHERE id = $3
                `, [customer.isBlocked, customer.isActive, customerId]);
            } catch (e) {
                console.error('[AdminController] toggleCustomerBlock PG error:', e);
            }
        }

        db.addAuditLog(isBlocked ? 'CustomerBlocked' : 'CustomerUnblocked', 'Customer', customerId, { isBlocked });
        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return { success: true, isBlocked: customer.isBlocked, isActive: customer.isActive };
    }

    async deleteCustomer(customerId) {
        return await db.deleteCustomer(customerId);
    }

    // 6. Routes & Bookings
    async getRoutes() {
        return {
            success: true,
            total: db.memoryState.routes.length,
            routes: db.memoryState.routes
        };
    }

    async getBookings() {
        return {
            success: true,
            total: db.memoryState.bookings.length,
            bookings: db.memoryState.bookings
        };
    }

    async broadcastBookingStatusSync(bookingId, status, extra = {}) {
        if (!bookingId) return;
        try {
            const redisManager = require('../redis/redisClient');
            if (redisManager && redisManager.pub) {
                await redisManager.pub.publish('channel:cluster:sync', JSON.stringify({
                    type: 'booking_status_sync',
                    bookingId: String(bookingId),
                    status: status,
                    customerId: extra.customerId || null,
                    driverId: extra.driverId || null,
                    reason: extra.reason || null,
                    cancellationStatus: extra.cancellationStatus || null,
                    timestamp: Date.now()
                }));
            }
        } catch (err) {
            console.warn('[AdminController] broadcastBookingStatusSync error:', err.message);
        }
    }

    async acceptBooking(bookingId, driverId = null, authUser = null) {
        let pgRow = null;
        if (db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM bookings WHERE id = $1 LIMIT 1', [bookingId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    pgRow = pgRes.rows[0];
                }
            } catch (e) {
                console.error('[AdminController] PG fetch booking error:', e);
            }
        }

        let booking = (db.memoryState.bookings || []).find(b => (b.id === bookingId || b.bookingId === bookingId));
        
        if (pgRow) {
            const mappedFromPg = {
                id: pgRow.id,
                bookingId: pgRow.id,
                routeId: pgRow.route_id,
                driverId: pgRow.driver_id,
                driverName: pgRow.driver_name,
                driverPhone: pgRow.driver_phone,
                customerId: pgRow.customer_id,
                customerName: pgRow.customer_name,
                customerPhone: pgRow.customer_phone,
                pickupLocation: pgRow.pickup_name,
                dropoffLocation: pgRow.dropoff_name,
                seatsBooked: pgRow.seats_booked || 1,
                status: pgRow.status,
                totalFare: pgRow.total_fare,
                createdAt: pgRow.created_at
            };
            if (booking) {
                Object.assign(booking, mappedFromPg);
            } else {
                booking = mappedFromPg;
                db.memoryState.bookings.unshift(booking);
            }
        } else if (booking && db.isPostgresConnected && db.pool && String(booking.status || 'Pending').toLowerCase() === 'pending') {
            try {
                const now = booking.createdAt || new Date().toISOString();
                if (booking.customerId) {
                    await db.pool.query(`
                        INSERT INTO users (id, phone_number, full_name, role, created_at)
                        VALUES ($1, $2, $3, 'Customer', $4)
                        ON CONFLICT (id) DO NOTHING
                    `, [booking.customerId, booking.customerPhone || '', booking.customerName || 'راكب', now]);

                    await db.pool.query(`
                        INSERT INTO customers (customer_id, full_name, phone_number, created_at)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (customer_id) DO NOTHING
                    `, [booking.customerId, booking.customerName || 'راكب', booking.customerPhone || '', now]);
                }
                let validRouteId = null;
                if (booking.routeId) {
                    const rCheck = await db.pool.query('SELECT id FROM routes WHERE id = $1', [booking.routeId]);
                    if (rCheck.rows.length > 0) validRouteId = booking.routeId;
                }
                let validDriverId = null;
                if (booking.driverId) {
                    const dCheck = await db.pool.query('SELECT driver_id FROM drivers WHERE driver_id = $1', [booking.driverId]);
                    if (dCheck.rows.length > 0) validDriverId = booking.driverId;
                }
                await db.pool.query(`
                    INSERT INTO bookings (
                        id, route_id, customer_id, customer_name, driver_id, driver_name,
                        pickup_name, dropoff_name, pickup_lat, pickup_lon, dropoff_lat, dropoff_lon,
                        total_fare, seats_booked, status, customer_phone, cancellation_reason, created_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Pending', $15, '', $16)
                    ON CONFLICT (id) DO NOTHING
                `, [
                    booking.id || bookingId, validRouteId, booking.customerId, booking.customerName || 'راكب',
                    validDriverId, booking.driverName || '', booking.pickupLocation || '',
                    booking.dropoffLocation || '', booking.pickupLat || null, booking.pickupLon || null,
                    booking.dropoffLat || null, booking.dropoffLon || null, parseFloat(booking.totalFare || booking.fare || 0),
                    parseInt(booking.seatsBooked || 1, 10), booking.customerPhone || '', now
                ]);
            } catch (syncErr) {
                console.error('[AdminController] PG sync pending booking error:', syncErr);
            }
        }

        if (!booking) {
            return { success: false, code: 404, error: 'الطلب لم يعد موجوداً' };
        }

        // RLS Authorization Check: Driver must be the assigned captain, or actor is Admin
        if (authUser) {
            if (authUser.role === 'Driver') {
                const callerDriverId = authUser.id || driverId;
                const isDriverOwner = (callerDriverId && (String(callerDriverId) === String(booking.driverId) || String(callerDriverId) === String(booking.driverPhone))) ||
                                      (authUser.phone && booking.driverPhone && String(authUser.phone).replace(/[^0-9]/g, '').endsWith(String(booking.driverPhone).replace(/[^0-9]/g, '').slice(-8)));
                if (!isDriverOwner) {
                    return { success: false, code: 403, error: 'غير مصرح: هذا الحجز مخصص لكابتن آخر (RLS)' };
                }
            } else if (authUser.role === 'Customer') {
                return { success: false, code: 403, error: 'غير مصرح للركاب بقبول الحجوزات (RLS)' };
            }
        }

        // State Machine Check: only Pending can transition to Confirmed (ACCEPTED)
        const curStatus = String(booking.status || 'Pending').toLowerCase();
        if (curStatus !== 'pending') {
            let msg = 'لا يمكن قبول الحجز في حالته الحالية';
            if (curStatus === 'confirmed' || curStatus === 'accepted') msg = 'طلب الحجز تم قبوله مسبقاً';
            else if (curStatus === 'declined' || curStatus === 'rejected') msg = 'طلب الحجز تم رفضه مسبقاً';
            else if (curStatus === 'cancelled') msg = 'طلب الحجز ملغي';
            else if (curStatus === 'expired') msg = 'انتهت صلاحية طلب الحجز';
            return { success: false, code: 409, error: msg, currentStatus: booking.status };
        }

        // Atomic Seat Capacity Check: Enforce driver capacity limit
        const seatsRequested = parseInt(booking.seatsBooked || 1, 10);
        let activeBookedSeats = 0;
        if (db.isPostgresConnected && db.pool) {
            try {
                const capRes = await db.pool.query(`
                    SELECT COALESCE(SUM(seats_booked), 0) AS booked_count
                    FROM bookings
                    WHERE driver_id = $1 AND status IN ('Confirmed', 'Active') AND id != $2
                `, [booking.driverId, booking.id || bookingId]);
                activeBookedSeats = parseInt(capRes.rows[0]?.booked_count || 0, 10);
            } catch (_) {
                const memActive = (db.memoryState.bookings || []).filter(b => 
                    b.driverId === booking.driverId && (b.status === 'Confirmed' || b.status === 'Active') && (b.id !== booking.id && b.bookingId !== booking.id)
                );
                activeBookedSeats = memActive.reduce((sum, b) => sum + parseInt(b.seatsBooked || 1, 10), 0);
            }
        } else {
            const memActive = (db.memoryState.bookings || []).filter(b => 
                b.driverId === booking.driverId && (b.status === 'Confirmed' || b.status === 'Active') && (b.id !== booking.id && b.bookingId !== booking.id)
            );
            activeBookedSeats = memActive.reduce((sum, b) => sum + parseInt(b.seatsBooked || 1, 10), 0);
        }

        const targetRoute = (db.memoryState.routes || []).find(r => (r.id === booking.routeId || r.routeId === booking.routeId));
        const targetDriver = (db.memoryState.drivers || []).find(d => d.driverId === booking.driverId);
        let totalCapacity = targetRoute?.totalSeats || targetDriver?.availableSeats || targetDriver?.available_seats || 4;
        if (db.isPostgresConnected && db.pool) {
            try {
                const rRes = await db.pool.query('SELECT total_seats FROM routes WHERE driver_id = $1 LIMIT 1', [booking.driverId]);
                if (rRes.rows && rRes.rows.length > 0) totalCapacity = parseInt(rRes.rows[0].total_seats || 4, 10);
            } catch (_) {}
        }

        if (activeBookedSeats + seatsRequested > totalCapacity) {
            return {
                success: false,
                code: 409,
                error: `عذراً، المقاعد مكتملة بالكامل لدى الكابتن (${activeBookedSeats}/${totalCapacity} محجوز)، لا يمكن قبول ركاب إضافيين.`
            };
        }

        // Atomic Compare-And-Set in PostgreSQL
        const nowIso = new Date().toISOString();
        if (db.isPostgresConnected && db.pool) {
            try {
                const pgUpd = await db.pool.query(`
                    UPDATE bookings 
                    SET status = 'Confirmed', accepted_at = NOW(), updated_at = NOW()
                    WHERE id = $1 AND status = 'Pending'
                    RETURNING *
                `, [booking.id || bookingId]);
                if (!pgUpd.rows || pgUpd.rows.length === 0) {
                    const checkRow = await db.pool.query('SELECT status FROM bookings WHERE id = $1 LIMIT 1', [booking.id || bookingId]);
                    if (!checkRow.rows || checkRow.rows.length === 0) {
                        return { success: false, code: 404, error: 'الطلب لم يعد موجوداً' };
                    }
                    const freshStatus = String(checkRow.rows[0].status || '').toLowerCase();
                    let msg = 'لا يمكن قبول الحجز في حالته الحالية';
                    if (freshStatus === 'confirmed' || freshStatus === 'accepted') msg = 'طلب الحجز تم قبوله مسبقاً';
                    else if (freshStatus === 'declined' || freshStatus === 'rejected') msg = 'طلب الحجز تم رفضه مسبقاً';
                    else if (freshStatus === 'cancelled') msg = 'طلب الحجز ملغي';
                    else if (freshStatus === 'expired') msg = 'انتهت صلاحية طلب الحجز';
                    return { success: false, code: 409, error: msg, currentStatus: checkRow.rows[0].status };
                }
            } catch (e) {
                console.error('[AdminController] PG accept booking error:', e);
                return { success: false, code: 500, error: 'فشل حفظ قبول الحجز في قاعدة البيانات' };
            }
        }

        booking.status = 'Confirmed';
        booking.acceptedAt = nowIso;

        // Deduct seats from target route
        if (targetRoute && !booking.seatsDeducted) {
            targetRoute.availableSeats = Math.max(0, (targetRoute.availableSeats || 4) - seatsRequested);
            booking.seatsDeducted = true;
        }

        // Link customer to driver so customer is confirmed passenger
        const cust = (db.memoryState.customers || []).find(c => c.customerId === booking.customerId || c.phoneNumber === booking.customerPhone);
        if (cust) {
            cust.assignedDriverId = booking.driverId;
            cust.driverId = booking.driverId;
            cust.bookingConfirmed = true;
        }

        // Real-time SSE Broadcasts
        const redisManager = require('../redis/redisClient');
        if (redisManager) {
            if (typeof redisManager.publishPassengerEvent === 'function') {
                await redisManager.publishPassengerEvent(booking.customerId, {
                    type: 'booking_updated',
                    event: 'booking_updated',
                    canonicalStatus: 'ACCEPTED',
                    status: 'Confirmed',
                    bookingId: booking.id || bookingId,
                    driverId: booking.driverId,
                    driverName: booking.driverName,
                    driverPhone: booking.driverPhone,
                    message: 'وافق الكابتن على طلب حجزك في الخط! تم تأكيد مقعدك بنجاح ✅'
                });
            }
            if (typeof redisManager.publishRideEvent === 'function') {
                redisManager.publishRideEvent(`cust:${booking.customerId}`, {
                    type: 'booking_accepted',
                    canonicalStatus: 'ACCEPTED',
                    bookingId: booking.id || bookingId
                });
            }
            if (typeof redisManager.publishDriverEvent === 'function') {
                redisManager.publishDriverEvent(booking.driverId, {
                    type: 'booking_accepted',
                    canonicalStatus: 'ACCEPTED',
                    bookingId: booking.id || bookingId,
                    customerId: booking.customerId
                });
            }
            await this.broadcastBookingStatusSync(booking.id || bookingId, 'Confirmed', {
                customerId: booking.customerId,
                driverId: booking.driverId
            });
        }

        db.addAuditLog('BookingAccepted', 'Driver', booking.driverId || 'Admin', {
            bookingId: booking.id || bookingId,
            customerName: booking.customerName,
            customerId: booking.customerId,
            driverId: booking.driverId,
            status: 'Confirmed'
        });

        // Notify Passenger via Telegram with SET NX distributed lock and update captain message
        try {
            const telegramBot = require('../telegram/telegramBot');
            if (typeof telegramBot.updateCaptainBookingMessage === 'function') {
                telegramBot.updateCaptainBookingMessage(booking.id || bookingId, 'Confirmed', booking).catch(() => {});
            }
            if (typeof telegramBot.notifyBookingAcceptedToRider === 'function') {
                telegramBot.notifyBookingAcceptedToRider(booking).catch(err => {
                    console.warn('[AdminController] notifyBookingAcceptedToRider error:', err.message);
                });
            }
        } catch (tgErr) {
            console.warn('[AdminController] Telegram notify error:', tgErr.message);
        }

        db.saveStateSnapshot();
        return { success: true, message: 'تمت موافقة السائق على الحجز وأصبح الزبون ضمن الركاب بنجاح! ✅', booking };
    }

    async declineBooking(bookingId, reason = null, driverId = null, authUser = null) {
        let pgRow = null;
        if (db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM bookings WHERE id = $1 LIMIT 1', [bookingId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    pgRow = pgRes.rows[0];
                }
            } catch (e) {
                console.error('[AdminController] PG fetch booking error:', e);
            }
        }

        let booking = (db.memoryState.bookings || []).find(b => (b.id === bookingId || b.bookingId === bookingId));

        if (pgRow) {
            const mappedFromPg = {
                id: pgRow.id,
                bookingId: pgRow.id,
                routeId: pgRow.route_id,
                driverId: pgRow.driver_id,
                driverName: pgRow.driver_name,
                driverPhone: pgRow.driver_phone,
                customerId: pgRow.customer_id,
                customerName: pgRow.customer_name,
                customerPhone: pgRow.customer_phone,
                pickupLocation: pgRow.pickup_name,
                dropoffLocation: pgRow.dropoff_name,
                seatsBooked: pgRow.seats_booked || 1,
                status: pgRow.status,
                totalFare: pgRow.total_fare,
                createdAt: pgRow.created_at
            };
            if (booking) {
                Object.assign(booking, mappedFromPg);
            } else {
                booking = mappedFromPg;
                db.memoryState.bookings.unshift(booking);
            }
        } else if (booking && db.isPostgresConnected && db.pool && String(booking.status || 'Pending').toLowerCase() === 'pending') {
            try {
                const now = booking.createdAt || new Date().toISOString();
                if (booking.customerId) {
                    await db.pool.query(`
                        INSERT INTO users (id, phone_number, full_name, role, created_at)
                        VALUES ($1, $2, $3, 'Customer', $4)
                        ON CONFLICT (id) DO NOTHING
                    `, [booking.customerId, booking.customerPhone || '', booking.customerName || 'راكب', now]);

                    await db.pool.query(`
                        INSERT INTO customers (customer_id, full_name, phone_number, created_at)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (customer_id) DO NOTHING
                    `, [booking.customerId, booking.customerName || 'راكب', booking.customerPhone || '', now]);
                }
                let validRouteId = null;
                if (booking.routeId) {
                    const rCheck = await db.pool.query('SELECT id FROM routes WHERE id = $1', [booking.routeId]);
                    if (rCheck.rows.length > 0) validRouteId = booking.routeId;
                }
                let validDriverId = null;
                if (booking.driverId) {
                    const dCheck = await db.pool.query('SELECT driver_id FROM drivers WHERE driver_id = $1', [booking.driverId]);
                    if (dCheck.rows.length > 0) validDriverId = booking.driverId;
                }
                await db.pool.query(`
                    INSERT INTO bookings (
                        id, route_id, customer_id, customer_name, driver_id, driver_name,
                        pickup_name, dropoff_name, pickup_lat, pickup_lon, dropoff_lat, dropoff_lon,
                        total_fare, seats_booked, status, customer_phone, cancellation_reason, created_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Pending', $15, '', $16)
                    ON CONFLICT (id) DO NOTHING
                `, [
                    booking.id || bookingId, validRouteId, booking.customerId, booking.customerName || 'راكب',
                    validDriverId, booking.driverName || '', booking.pickupLocation || '',
                    booking.dropoffLocation || '', booking.pickupLat || null, booking.pickupLon || null,
                    booking.dropoffLat || null, booking.dropoffLon || null, parseFloat(booking.totalFare || booking.fare || 0),
                    parseInt(booking.seatsBooked || 1, 10), booking.customerPhone || '', now
                ]);
            } catch (syncErr) {
                console.error('[AdminController] PG sync pending booking error:', syncErr);
            }
        }

        if (!booking) {
            return { success: false, code: 404, error: 'الطلب لم يعد موجوداً' };
        }

        // RLS Authorization Check: Driver must be the assigned captain, or actor is Admin
        if (authUser) {
            if (authUser.role === 'Driver') {
                const callerDriverId = authUser.id || driverId;
                const isDriverOwner = (callerDriverId && (String(callerDriverId) === String(booking.driverId) || String(callerDriverId) === String(booking.driverPhone))) ||
                                      (authUser.phone && booking.driverPhone && String(authUser.phone).replace(/[^0-9]/g, '').endsWith(String(booking.driverPhone).replace(/[^0-9]/g, '').slice(-8)));
                if (!isDriverOwner) {
                    return { success: false, code: 403, error: 'غير مصرح: هذا الحجز مخصص لكابتن آخر (RLS)' };
                }
            } else if (authUser.role === 'Customer') {
                return { success: false, code: 403, error: 'غير مصرح للركاب برفض الحجوزات من طرف الكابتن (RLS)' };
            }
        }

        // State Machine Check: only Pending can transition to Declined (REJECTED)
        const curStatus = String(booking.status || 'Pending').toLowerCase();
        if (curStatus !== 'pending') {
            let msg = 'لا يمكن رفض الحجز في حالته الحالية';
            if (curStatus === 'confirmed' || curStatus === 'accepted') msg = 'طلب الحجز تم قبوله مسبقاً، يرجى استخدام مسار إلغاء الاشتراك';
            else if (curStatus === 'declined' || curStatus === 'rejected') msg = 'طلب الحجز تم رفضه مسبقاً';
            else if (curStatus === 'cancelled') msg = 'طلب الحجز ملغي';
            else if (curStatus === 'expired') msg = 'انتهت صلاحية طلب الحجز';
            return { success: false, code: 409, error: msg, currentStatus: booking.status };
        }

        // Validate and sanitize rejection reason
        const systemSettingsService = require('../systemSettings/systemSettingsService');
        let sanitizedReason = typeof reason === 'string' ? reason.trim().slice(0, 100) : '';
        if (!sanitizedReason) {
            sanitizedReason = 'المقاعد مكتملة';
        }

        // Atomic Compare-And-Set in PostgreSQL
        const nowIso = new Date().toISOString();
        if (db.isPostgresConnected && db.pool) {
            try {
                const pgUpd = await db.pool.query(`
                    UPDATE bookings 
                    SET status = 'Declined', declined_at = NOW(), rejection_reason = $2, updated_at = NOW()
                    WHERE id = $1 AND status = 'Pending'
                    RETURNING *
                `, [booking.id || bookingId, sanitizedReason]);
                if (!pgUpd.rows || pgUpd.rows.length === 0) {
                    const checkRow = await db.pool.query('SELECT status FROM bookings WHERE id = $1 LIMIT 1', [booking.id || bookingId]);
                    if (!checkRow.rows || checkRow.rows.length === 0) {
                        return { success: false, code: 404, error: 'الطلب لم يعد موجوداً' };
                    }
                    const freshStatus = String(checkRow.rows[0].status || '').toLowerCase();
                    let msg = 'لا يمكن رفض الحجز في حالته الحالية';
                    if (freshStatus === 'confirmed' || freshStatus === 'accepted') msg = 'طلب الحجز تم قبوله مسبقاً، يرجى استخدام مسار إلغاء الاشتراك';
                    else if (freshStatus === 'declined' || freshStatus === 'rejected') msg = 'طلب الحجز تم رفضه مسبقاً';
                    else if (freshStatus === 'cancelled') msg = 'طلب الحجز ملغي';
                    else if (freshStatus === 'expired') msg = 'انتهت صلاحية طلب الحجز';
                    return { success: false, code: 409, error: msg, currentStatus: checkRow.rows[0].status };
                }
            } catch (e) {
                console.error('[AdminController] PG decline booking error:', e);
                return { success: false, code: 500, error: 'فشل حفظ رفض الحجز في قاعدة البيانات' };
            }
        }

        booking.status = 'Declined';
        booking.declinedAt = nowIso;
        booking.declineReason = sanitizedReason;
        booking.rejectionReason = sanitizedReason;

        if (booking.seatsDeducted) {
            const targetRoute = (db.memoryState.routes || []).find(r => (r.id === booking.routeId || r.routeId === booking.routeId));
            if (targetRoute) {
                targetRoute.availableSeats = (targetRoute.availableSeats || 0) + (booking.seatsBooked || 1);
            }
            booking.seatsDeducted = false;
        }

        const cust = (db.memoryState.customers || []).find(c => c.customerId === booking.customerId || c.phoneNumber === booking.customerPhone);
        if (cust && cust.assignedDriverId === booking.driverId) {
            cust.assignedDriverId = null;
            cust.bookingConfirmed = false;
        }

        // Real-time SSE Broadcasts
        const redisManager = require('../redis/redisClient');
        if (redisManager) {
            if (typeof redisManager.publishPassengerEvent === 'function') {
                await redisManager.publishPassengerEvent(booking.customerId, {
                    type: 'booking_updated',
                    event: 'booking_updated',
                    canonicalStatus: 'REJECTED',
                    status: 'Declined',
                    bookingId: booking.id || bookingId,
                    driverId: booking.driverId,
                    reason: sanitizedReason,
                    message: `اعتذر الكابتن عن قبول الطلب: ${sanitizedReason}`
                });
            }
            if (typeof redisManager.publishDriverEvent === 'function') {
                redisManager.publishDriverEvent(booking.driverId, {
                    type: 'booking_declined',
                    canonicalStatus: 'REJECTED',
                    bookingId: booking.id || bookingId
                });
            }
            await this.broadcastBookingStatusSync(booking.id || bookingId, 'Declined', {
                customerId: booking.customerId,
                driverId: booking.driverId,
                reason: sanitizedReason
            });
        }

        db.addAuditLog('BookingDeclined', 'Driver', booking.driverId || 'Admin', {
            bookingId: booking.id || bookingId,
            customerName: booking.customerName,
            customerId: booking.customerId,
            driverId: booking.driverId,
            reason: sanitizedReason,
            status: 'Declined'
        });

        // Notify Passenger via Telegram with SET NX distributed lock and update captain message
        try {
            const telegramBot = require('../telegram/telegramBot');
            if (typeof telegramBot.updateCaptainBookingMessage === 'function') {
                telegramBot.updateCaptainBookingMessage(booking.id || bookingId, 'Declined', booking).catch(() => {});
            }
            if (typeof telegramBot.notifyBookingDeclinedToRider === 'function') {
                telegramBot.notifyBookingDeclinedToRider(booking, sanitizedReason).catch(err => {
                    console.warn('[AdminController] notifyBookingDeclinedToRider error:', err.message);
                });
            }
        } catch (tgErr) {
            console.warn('[AdminController] Telegram notify decline error:', tgErr.message);
        }

        db.saveStateSnapshot();
        return { success: true, message: 'تم رفض طلب الحجز.', booking };
    }

    async updateBookingStatus(bookingId, status, reason = null) {
        const sLower = String(status || '').toLowerCase();
        if (sLower === 'confirmed' || sLower === 'accepted') {
            return await this.acceptBooking(bookingId);
        } else if (['declined', 'rejected', 'cancelled', 'canceled'].includes(sLower)) {
            return await this.declineBooking(bookingId, reason);
        }

        let booking = (db.memoryState.bookings || []).find(b => (b.id === bookingId || b.bookingId === bookingId));
        if (!booking) return { success: false, error: 'الحجز غير موجود' };

        booking.status = status;
        if (reason) booking.reason = reason;

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE bookings SET status = $1 WHERE id = $2
                `, [status, booking.id || bookingId]);
            } catch (e) {}
        }

        await this.broadcastBookingStatusSync(booking.id || bookingId, status, {
            customerId: booking.customerId,
            driverId: booking.driverId,
            reason: reason
        });

        db.saveStateSnapshot();
        return { success: true, booking };
    }

    // 7. Complaints & Reports
    async getComplaints(params = {}) {
        return await complaintService.getComplaints(params);
    }

    async resolveComplaint(complaintId, updates = {}, actor = 'المشرف العام (Admin)', ip = '127.0.0.1') {
        return await complaintService.resolveComplaint(complaintId, updates, actor, ip);
    }

    async updateComplaint(complaintId, status, resolutionNotes = null, ip = '127.0.0.1') {
        return await complaintService.resolveComplaint(complaintId, { status, adminNotes: resolutionNotes }, 'المشرف العام (Admin)', ip);
    }

    // 8. Settings
    async getSettings() {
        return {
            success: true,
            settings: db.memoryState.settings
        };
    }

    async updateSetting(key, valueJson, ip = '127.0.0.1') {
        if (key === 'PricingParameters' || key === 'pricing_settings') {
            try {
                const parsedVal = typeof valueJson === 'string' ? JSON.parse(valueJson) : valueJson;
                return await pricingService.savePricingSettings(parsedVal, 'المشرف العام (Admin)', ip);
            } catch (err) {}
        }

        let setting = db.memoryState.settings.find(s => s.key === key);
        if (setting) {
            setting.valueJson = typeof valueJson === 'string' ? valueJson : JSON.stringify(valueJson);
        } else {
            setting = {
                key,
                valueJson: typeof valueJson === 'string' ? valueJson : JSON.stringify(valueJson),
                description: 'إعداد مخصص'
            };
            db.memoryState.settings.push(setting);
        }

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    INSERT INTO system_settings (key, value_json, description)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
                `, [setting.key, setting.valueJson, setting.description]);
            } catch (e) {}
        }

        db.saveStateSnapshot();

        // Automated Audit Logging for settings & pricing changes
        try {
            const isPricing = key === 'PricingParameters' || key.toLowerCase().includes('price') || key.toLowerCase().includes('fare');
            await auditService.logAuditEvent({
                action: isPricing ? 'PricingParametersUpdated' : 'SystemSettingUpdated',
                entityType: 'SystemSetting',
                entityId: key,
                actor: 'المشرف العام (Admin)',
                details: { key, updatedSetting: setting.valueJson },
                ip
            });
        } catch (_) {}

        return { success: true, setting };
    }

    // Dynamic Surge Pricing Engine (Instant Taxi Rides Only)
    getPricingSettings() {
        return {
            success: true,
            settings: pricingService.getPricingSettings()
        };
    }

    async updatePricingSettings(newSettings, ip = '127.0.0.1') {
        return await pricingService.savePricingSettings(newSettings, 'المشرف العام (Admin)', ip);
    }

    // 9. Audit Logs
    async getAuditLogs(params = {}) {
        return await auditService.getAuditLogs(params);
    }

    async logAuditEvent(data) {
        return await auditService.logAuditEvent(data);
    }

    // 10. Backup & Restore
    async getDatabaseStats() {
        return await backupService.getDatabaseStats();
    }

    async exportBackup() {
        return await backupService.exportBackup();
    }

    async restoreBackup(payload) {
        return await backupService.restoreBackup(payload);
    }

    // 11. Admin Create Captain (Driver) with Full Info, Route and Instant Credentials
    async createDriver(data) {
        const {
            fullName,
            phoneNumber,
            email,
            password,
            licenseNumber,
            vehicleMake,
            vehicleModel,
            vehicleYear,
            vehiclePlate,
            vehicleColor,
            vehicleType,
            serviceType,
            availableSeats,
            route
        } = data;

        if (!fullName || !phoneNumber) {
            return { success: false, error: 'الاسم ورقم الهاتف مطلوبان.' };
        }

        const cleanPhone = String(phoneNumber).trim().replace(/[\s\-]/g, '');
        const cleanEmail = email && email.trim() ? email.trim().toLowerCase() : `captain_${cleanPhone}@taxiwisam.com`;

        // Check duplicate in memory across BOTH drivers and customers
        const arabicDigits = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
        let normPhone = String(phoneNumber || '').replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
        if (normPhone.startsWith('00964')) normPhone = normPhone.substring(5);
        else if (normPhone.startsWith('964')) normPhone = normPhone.substring(3);
        if (normPhone.length === 10 && normPhone.startsWith('7')) normPhone = '0' + normPhone;

        const cleanPhoneFunc = (p) => {
            if (!p) return '';
            let s = String(p).replace(/[٠-٩]/g, d => arabicDigits.indexOf(d)).replace(/[^0-9]/g, '');
            if (s.startsWith('00964')) s = s.substring(5);
            else if (s.startsWith('964')) s = s.substring(3);
            if (s.length === 10 && s.startsWith('7')) s = '0' + s;
            return s;
        };

        const existingDriver = (db.memoryState.drivers || []).find(d => cleanPhoneFunc(d.phoneNumber) === normPhone || (normPhone.length >= 6 && cleanPhoneFunc(d.phoneNumber).endsWith(normPhone)));
        const existingCust = (db.memoryState.customers || []).find(c => cleanPhoneFunc(c.phoneNumber) === normPhone || (normPhone.length >= 6 && cleanPhoneFunc(c.phoneNumber).endsWith(normPhone)));

        if (existingDriver) {
            return { success: false, duplicate: true, error: `الرقم مسجل بالفعل لدى سائق آخر: ${existingDriver.fullName}. يرجى إدخال رقم هاتف آخر.` };
        }

        // أولوية صفة السائق المطلقة (Driver Precedence): إذا كان الرقم مسجلاً كراكب يتم تحويله وحذف سجل الراكب فورياً
        if (existingCust) {
            db.memoryState.customers = (db.memoryState.customers || []).filter(c => {
                const cn = cleanPhoneFunc(c.phoneNumber || c.phone);
                return !(cn === normPhone || (normPhone.length >= 6 && (cn.endsWith(normPhone) || normPhone.endsWith(cn))));
            });
            if (db.isPostgresConnected && db.pool) {
                db.pool.query('DELETE FROM customers WHERE phone_number LIKE $1 OR phone_number LIKE $2', [`%${normPhone}`, `%0${normPhone}`]).catch(() => {});
                db.pool.query("DELETE FROM users WHERE (phone_number LIKE $1 OR phone_number LIKE $2) AND role = 'Customer'", [`%${normPhone}`, `%0${normPhone}`]).catch(() => {});
            }
        }

        const crypto = require('crypto');
        const rawPassword = (password && String(password).trim()) ? String(password).trim() : crypto.randomUUID();
        const passwordHash = crypto.createHash('sha256').update(rawPassword).digest('hex');
        const driverId = 'drv-' + Math.random().toString(36).substr(2, 9);
        const now = new Date().toISOString();
        const license = licenseNumber || ('IRQ-NJF-' + Math.floor(1000 + Math.random() * 9000));
        const vMake = vehicleMake || 'تويوتا';
        const vModel = vehicleModel || vehicleMake || 'كورولا';
        const vYear = parseInt(vehicleYear, 10) || 2022;
        const vPlate = vehiclePlate || 'النجف - ألماني';

        const startLat = (route && route.startLat) ? parseFloat(route.startLat) : 31.9961;
        const startLon = (route && route.startLon) ? parseFloat(route.startLon) : 44.3168;

        const sType = String(serviceType || '').toLowerCase().trim();
        let normalizedServiceType = 'PermanentLine';
        let defaultWorkMode = 'خط دائمي';
        let defaultWorkStatus = 'permanent';
        if (sType === 'short' || sType === 'shorttrip' || sType === 'taxi') {
            normalizedServiceType = 'ShortTrip';
            defaultWorkMode = 'مشوار قصير';
            defaultWorkStatus = 'taxi';
        } else if (sType === 'both') {
            normalizedServiceType = 'Both';
            defaultWorkMode = 'خط دائمي';
            defaultWorkStatus = 'permanent';
        } else {
            normalizedServiceType = 'PermanentLine';
            defaultWorkMode = 'خط دائمي';
            defaultWorkStatus = 'permanent';
        }

        let vType = 'eco';
        const rawVT = String(vehicleType || data.vehicleType || '').toLowerCase();
        if (rawVT === 'super' || rawVT === 'سوبر') vType = 'super';
        else if (rawVT === 'plus' || rawVT === 'vip' || rawVT === 'بلس' || rawVT === 'بلَس') vType = 'plus';
        else vType = 'eco';

        const passStr = (password && String(password).trim()) ? String(password).trim() : '';
        const newDriver = {
            driverId,
            fullName,
            email: cleanEmail,
            phoneNumber: cleanPhone,
            plainPassword: passStr,
            passwordHash,
            licenseNumber: license,
            vehicleMake: vMake,
            vehicleModel: vModel,
            vehicleYear: vYear,
            vehiclePlate: vPlate,
            vehicleColor: vehicleColor || 'أبيض',
            vehicleType: vType,
            vehicle_type: vType,
            serviceType: normalizedServiceType,
            work_mode: defaultWorkMode,
            workStatus: defaultWorkStatus,
            availableSeats: parseInt(availableSeats || (route && route.availableSeats) || 4, 10),
            totalSeats: parseInt(availableSeats || (route && route.availableSeats) || 4, 10),
            status: 'Approved',
            tripStatus: 'Online',
            isOnline: true,
            isVerified: true,
            isApproved: true,
            is_approved: true,
            isBlocked: false,
            ratingAverage: 5.0,
            totalTrips: 0,
            latitude: startLat,
            longitude: startLon,
            currentLat: startLat,
            currentLon: startLon,
            permanentLat: startLat,
            permanentLon: startLon,
            permanentLocationName: (route && route.startName) || 'نقطة الانطلاق (النجف)',
            permanentDropoffLat: (route && route.endLat) ? parseFloat(route.endLat) : 32.0321,
            permanentDropoffLon: (route && route.endLon) ? parseFloat(route.endLon) : 44.3725,
            permanentDropoffName: (route && route.endName) || 'جامعة الكوفة',
            route: (typeof route === 'string' && route.trim()) ? route.trim() : ((route && (route.startName || route.endName)) ? `${route.startName || 'نقطة الانطلاق'} ➔ ${route.endName || 'جامعة الكوفة'}` : 'النجف ➔ جامعة الكوفة'),
            telegramChatId: (data.telegramChatId || data.telegram_chat_id) ? String(data.telegramChatId || data.telegram_chat_id).trim() : null,
            telegram_chat_id: (data.telegramChatId || data.telegram_chat_id) ? String(data.telegramChatId || data.telegram_chat_id).trim() : null,
            telegramLinkedAt: (data.telegramChatId || data.telegram_chat_id) ? now : null,
            telegram_linked_at: (data.telegramChatId || data.telegram_chat_id) ? now : null,
            createdAt: now,
            registeredAt: now,
            vehicles: [{
                make: vMake,
                model: vModel,
                year: vYear,
                plateNumber: vPlate,
                color: vehicleColor || 'أبيض'
            }]
        };

        db.memoryState.drivers.unshift(newDriver);

        // Add Route if specified
        let createdRoute = null;
        if (route && (route.startName || route.startLat || route.endName)) {
            const endLat = parseFloat(route.endLat || 32.0321);
            const endLon = parseFloat(route.endLon || 44.3725);
            const fare = parseFloat(route.fare || 3000);
            const seats = parseInt(route.availableSeats || availableSeats || 4, 10);
            const startName = route.startName || 'نقطة الانطلاق (النجف)';
            const endName = route.endName || 'جامعة الكوفة';
            const depTime = route.departureTime || '07:30 ص';

            const routeId = 'rt-' + Math.random().toString(36).substr(2, 9);
            createdRoute = {
                id: routeId,
                routeId: routeId,
                driverId,
                driverName: fullName,
                driverPhone: cleanPhone,
                driverRating: 5.0,
                vehicleInfo: `${vMake} ${vPlate}`,
                startName,
                endName,
                startLat,
                startLon,
                endLat,
                endLon,
                fare,
                pricePerSeat: fare,
                availableSeats: seats,
                totalSeats: seats,
                departureTime: depTime,
                status: 'Active',
                createdAt: now
            };

            db.memoryState.routes.unshift(createdRoute);
            newDriver.routes = [createdRoute];
            newDriver.permanentLat = startLat;
            newDriver.permanentLon = startLon;
            newDriver.permanentLocationName = startName;
            newDriver.permanentDropoffLat = endLat;
            newDriver.permanentDropoffLon = endLon;
            newDriver.permanentDropoffName = endName;
            newDriver.route = `${startName} ➔ ${endName}`;
            newDriver.work_mode = defaultWorkMode;
            newDriver.workStatus = defaultWorkStatus;
            newDriver.serviceType = normalizedServiceType;

            db.memoryState.permanentRoutes = db.memoryState.permanentRoutes || [];
            db.memoryState.permanentRoutes.unshift({
                id: 'route-' + driverId,
                driverId,
                driverName: fullName,
                driverPhone: cleanPhone,
                vehicleInfo: `${vMake} ${vPlate}`,
                vehicleType: newDriver.vehicleType || 'eco',
                startName,
                endName,
                startLat,
                startLon,
                endLat,
                endLon,
                fare,
                days: ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء'],
                departureTime: depTime,
                status: 'Active',
                isDriverRoute: true,
                createdAt: now
            });
        }

        // Save into PostgreSQL
        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    INSERT INTO users (id, phone_number, email, full_name, role, password_hash, plain_password, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, 'Driver', $5, $6, true, false, $7)
                    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, password_hash = EXCLUDED.password_hash, plain_password = EXCLUDED.plain_password
                `, [driverId, cleanPhone, cleanEmail, fullName, passwordHash, passStr, now]);

                const rawTg = newDriver.telegramChatId;
                await db.pool.query(`
                    INSERT INTO drivers (driver_id, full_name, phone_number, email, password_hash, plain_password, license_number, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, status, is_verified, is_blocked, latitude, longitude, created_at, telegram_chat_id, telegram_linked_at, vehicle_type, is_approved)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Approved', true, false, $12, $13, $14, $15, $16, $17, true)
                    ON CONFLICT (driver_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, password_hash = EXCLUDED.password_hash, plain_password = EXCLUDED.plain_password, telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, drivers.telegram_chat_id), vehicle_type = EXCLUDED.vehicle_type, is_approved = true
                `, [driverId, fullName, cleanPhone, cleanEmail, passwordHash, passStr, license, vMake, vModel, vYear, vPlate, startLat, startLon, now, rawTg, rawTg ? now : null, vType]);

                if (createdRoute) {
                    await db.pool.query(`
                        INSERT INTO routes (id, driver_id, driver_name, driver_phone, start_name, end_name, start_lat, start_lon, end_lat, end_lon, fare, available_seats, total_seats, departure_time, status, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Active', $15)
                        ON CONFLICT (id) DO NOTHING
                    `, [createdRoute.id, driverId, fullName, cleanPhone, createdRoute.startName, createdRoute.endName, createdRoute.startLat, createdRoute.startLon, createdRoute.endLat, createdRoute.endLon, createdRoute.fare, createdRoute.availableSeats, createdRoute.totalSeats, createdRoute.departureTime, now]);
                }
            } catch (err) {
                console.error('[AdminController] PG createDriver error:', err);
            }
        }

        db.addAuditLog('AdminCreatedDriver', 'Admin', 'usr-admin', {
            driverId,
            fullName,
            phoneNumber: cleanPhone,
            hasRoute: !!createdRoute
        });

        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return {
            success: true,
            driver: newDriver,
            route: createdRoute,
            credentials: {
                username: cleanPhone,
                phoneNumber: cleanPhone,
                email: cleanEmail,
                password: passStr,
                fullName: fullName
            }
        };
    }

    // 12. Driver & Passenger Cancellation Requests
    async createCancellationRequest(data) {
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        const requestId = 'can-' + Math.random().toString(36).substr(2, 9);
        const bookingId = data.bookingId || data.id;

        const booking = (db.memoryState.bookings || []).find(b => (b.id === bookingId || b.bookingId === bookingId));
        if (booking) {
            booking.cancellationPending = true;
            booking.cancellationReason = data.reason || 'طلب إلغاء من الكابتن';
        }

        const newRequest = {
            id: requestId,
            requestId: requestId,
            bookingId: bookingId,
            driverId: data.driverId || booking?.driverId || '',
            driverName: data.driverName || booking?.driverName || 'الكابتن',
            driverPhone: data.driverPhone || booking?.driverPhone || '',
            customerId: data.customerId || booking?.customerId || '',
            customerName: data.customerName || booking?.customerName || 'الراكب',
            customerPhone: data.customerPhone || booking?.customerPhone || '',
            routeId: data.routeId || booking?.routeId || '',
            route: booking?.pickupLocation ? `${booking.pickupLocation} ➔ ${booking.dropoffLocation}` : (data.route || 'مسار الخط'),
            reason: data.reason || 'طلب إلغاء من الكابتن',
            seats: booking?.seatsBooked || 1,
            status: 'Pending',
            createdAt: new Date().toISOString()
        };

        db.memoryState.cancellationRequests.unshift(newRequest);
        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return {
            success: true,
            message: 'تم تسجيل طلب الإلغاء بنجاح وبانتظار موافقة الإدارة',
            request: newRequest
        };
    }

    async getCancellationRequests() {
        if (db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query(`
                    SELECT 
                        id,
                        booking_id,
                        customer_id,
                        COALESCE(passenger_name, customer_name, 'الراكب') AS passenger_name,
                        COALESCE(passenger_phone, customer_phone, '') AS passenger_phone,
                        COALESCE(passenger_name, customer_name, 'الراكب') AS customer_name,
                        COALESCE(passenger_phone, customer_phone, '') AS customer_phone,
                        driver_id,
                        driver_name,
                        driver_phone,
                        route_id,
                        COALESCE(route_name, 'مسار الخط') AS route_name,
                        COALESCE(reason_category, passenger_reason, 'ظروف خاصة') AS reason_category,
                        COALESCE(reason_category, passenger_reason, 'ظروف خاصة') AS passenger_reason,
                        COALESCE(user_message, passenger_details, '') AS user_message,
                        COALESCE(user_message, passenger_details, '') AS passenger_details,
                        driver_decision,
                        driver_approval_reason,
                        status,
                        created_at,
                        resolved_at
                    FROM cancellation_requests 
                    ORDER BY created_at DESC
                `);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    db.memoryState.cancellationRequests = pgRes.rows.map(r => ({
                        id: r.id,
                        requestId: r.id,
                        bookingId: r.booking_id,
                        customerId: r.customer_id,
                        passengerName: r.passenger_name,
                        customerName: r.customer_name,
                        passengerPhone: r.passenger_phone,
                        customerPhone: r.customer_phone,
                        driverId: r.driver_id,
                        driverName: r.driver_name,
                        driverPhone: r.driver_phone,
                        routeId: r.route_id,
                        routeName: r.route_name,
                        route: r.route_name,
                        reasonCategory: r.reason_category,
                        passengerReason: r.passenger_reason,
                        reason: r.reason_category,
                        userMessage: r.user_message,
                        passengerDetails: r.passenger_details,
                        driverDecision: r.driver_decision || 'pending',
                        driverApprovalReason: r.driver_approval_reason,
                        status: r.status || 'Pending',
                        createdAt: r.created_at,
                        resolvedAt: r.resolved_at
                    }));
                }
            } catch (pgErr) {
                console.error('[AdminController] PG getCancellationRequests error:', pgErr.message);
            }
        }

        // If PG returns rows, memory is updated. If both PG and memory are empty, return empty array.
        return {
            success: true,
            total: (db.memoryState.cancellationRequests || []).length,
            requests: db.memoryState.cancellationRequests || []
        };
    }

    async approveCancellation(requestId, data = {}) {
        if (!requestId) return { success: false, error: 'معرف طلب الإلغاء مطلوب' };
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        let req = db.memoryState.cancellationRequests.find(r => r.id === requestId || r.requestId === requestId);

        if (!req && db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM cancellation_requests WHERE id = $1 LIMIT 1', [requestId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    const r = pgRes.rows[0];
                    req = {
                        id: r.id,
                        requestId: r.id,
                        bookingId: r.booking_id,
                        customerName: r.customer_name || r.passenger_name,
                        passengerName: r.passenger_name || r.customer_name,
                        customerPhone: r.customer_phone || r.passenger_phone,
                        passengerPhone: r.passenger_phone || r.customer_phone,
                        driverId: r.driver_id,
                        driverName: r.driver_name,
                        routeId: r.route_id,
                        routeName: r.route_name,
                        route: r.route_name,
                        reasonCategory: r.reason_category || r.passenger_reason,
                        status: r.status,
                        createdAt: r.created_at
                    };
                    db.memoryState.cancellationRequests.unshift(req);
                }
            } catch (err) {
                console.error('[AdminController] find cancel req in PG error:', err.message);
            }
        }

        if (!req) return { success: false, error: 'طلب الإلغاء غير موجود' };

        req.status = 'Approved';
        req.driverDecision = 'approved';
        req.resolvedAt = new Date().toISOString();
        req.approvedAt = new Date().toISOString();

        // 1. Unlink & cancel booking
        const booking = (db.memoryState.bookings || []).find(b => b.id === req.bookingId || b.bookingId === req.bookingId);
        if (booking) {
            booking.status = 'Cancelled';
            booking.cancellationPending = false;
            booking.cancellation_requested = false;
            booking.cancellation_status = 'approved';
            booking.cancelledAt = new Date().toISOString();
        }

        // 2. Free seat(s) on target route
        const targetRoute = (db.memoryState.routes || []).find(r => (r.id === booking?.routeId || r.routeId === booking?.routeId || r.id === req.routeId));
        if (targetRoute) {
            const totalCap = targetRoute.totalSeats || 4;
            const freedSeats = parseInt(booking?.seatsBooked || req.seats || 1, 10);
            targetRoute.availableSeats = Math.min(totalCap, (targetRoute.availableSeats || 0) + freedSeats);
        }

        // 3. Unlink customer from driver
        const cust = (db.memoryState.customers || []).find(c => c.customerId === req.customerId || c.phoneNumber === req.customerPhone || (booking && (c.customerId === booking.customerId || c.phoneNumber === booking.customerPhone)));
        if (cust) {
            cust.assignedDriverId = null;
            cust.driverId = null;
            cust.bookingConfirmed = false;
        }

        // 4. Update in PostgreSQL
        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE cancellation_requests 
                    SET status = 'Approved', driver_decision = 'approved', resolved_at = NOW() 
                    WHERE id = $1 OR booking_id = $2
                `, [requestId, req.bookingId]);

                if (req.bookingId) {
                    await db.pool.query(`
                        UPDATE bookings 
                        SET status = 'Cancelled', cancellation_requested = false, cancellation_status = 'approved', updated_at = NOW() 
                        WHERE id = $1
                    `, [req.bookingId]);
                }

                if (targetRoute) {
                    await db.pool.query(`UPDATE routes SET available_seats = LEAST(total_seats, available_seats + 1) WHERE id = $1`, [targetRoute.id]);
                }
            } catch (pgErr) {
                console.error('[AdminController] PG approve cancel error:', pgErr.message);
            }
        }

        // 5. Log to Audit
        try {
            await this.logAuditEvent({
                action: 'PassengerCancellationApproved',
                entityType: 'CancellationRequest',
                entityId: String(requestId),
                actor: 'المشرف العام (Admin)',
                details: {
                    requestId,
                    bookingId: req.bookingId,
                    passengerName: req.passengerName || req.customerName,
                    passengerPhone: req.passengerPhone || req.customerPhone,
                    routeName: req.routeName || req.route,
                    reasonCategory: req.reasonCategory || req.passengerReason,
                    action: 'اعتماد الإلغاء وتحرير المقعد'
                }
            });
        } catch (_) {}

        db.addAuditLog('PassengerCancellationApproved', 'Admin', 'usr-admin', {
            requestId,
            bookingId: req.bookingId,
            passengerName: req.passengerName || req.customerName
        });

        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return {
            success: true,
            message: 'تم اعتماد إلغاء اشتراك الراكب وتحرير المقعد في المسار بنجاح ✅',
            request: req
        };
    }

    async rejectCancellation(requestId, data = {}) {
        if (!requestId) return { success: false, error: 'معرف طلب الإلغاء مطلوب' };
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        let req = db.memoryState.cancellationRequests.find(r => r.id === requestId || r.requestId === requestId);

        if (!req && db.isPostgresConnected && db.pool) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM cancellation_requests WHERE id = $1 LIMIT 1', [requestId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    const r = pgRes.rows[0];
                    req = {
                        id: r.id,
                        requestId: r.id,
                        bookingId: r.booking_id,
                        customerName: r.customer_name || r.passenger_name,
                        passengerName: r.passenger_name || r.customer_name,
                        customerPhone: r.customer_phone || r.passenger_phone,
                        passengerPhone: r.passenger_phone || r.customer_phone,
                        driverId: r.driver_id,
                        driverName: r.driver_name,
                        routeId: r.route_id,
                        routeName: r.route_name,
                        route: r.route_name,
                        reasonCategory: r.reason_category || r.passenger_reason,
                        status: r.status,
                        createdAt: r.created_at
                    };
                    db.memoryState.cancellationRequests.unshift(req);
                }
            } catch (err) {
                console.error('[AdminController] find cancel req in PG error:', err.message);
            }
        }

        if (!req) return { success: false, error: 'طلب الإلغاء غير موجود' };

        const reasonNote = data.reason || data.rejectReason || 'رفض من الإدارة';
        req.status = 'Rejected';
        req.driverDecision = 'rejected';
        req.driverApprovalReason = reasonNote;
        req.resolvedAt = new Date().toISOString();
        req.rejectedAt = new Date().toISOString();

        const booking = (db.memoryState.bookings || []).find(b => b.id === req.bookingId || b.bookingId === req.bookingId);
        if (booking) {
            booking.cancellationPending = false;
            booking.cancellation_requested = false;
            booking.cancellation_status = 'rejected';
            booking.driverApprovalReason = reasonNote;
        }

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE cancellation_requests 
                    SET status = 'Rejected', driver_decision = 'rejected', driver_approval_reason = $1, resolved_at = NOW() 
                    WHERE id = $2 OR booking_id = $3
                `, [reasonNote, requestId, req.bookingId]);

                if (req.bookingId) {
                    await db.pool.query(`
                        UPDATE bookings 
                        SET cancellation_requested = false, cancellation_status = 'rejected', driver_approval_reason = $1, updated_at = NOW() 
                        WHERE id = $2
                    `, [reasonNote, req.bookingId]);
                }
            } catch (pgErr) {
                console.error('[AdminController] PG reject cancel error:', pgErr.message);
            }
        }

        try {
            await this.logAuditEvent({
                action: 'PassengerCancellationRejected',
                entityType: 'CancellationRequest',
                entityId: String(requestId),
                actor: 'المشرف العام (Admin)',
                details: {
                    requestId,
                    bookingId: req.bookingId,
                    passengerName: req.passengerName || req.customerName,
                    reason: reasonNote,
                    action: 'رفض طلب الإلغاء واستمرار الاشتراك'
                }
            });
        } catch (_) {}

        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return {
            success: true,
            message: 'تم رفض طلب الإلغاء واستمرار اشتراك الراكب ✕',
            request: req
        };
    }

    // 13. Route Cancellation Cycle: Customer Request Cancellation
    async requestRouteCancellation(data, authUser = null) {
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        const bookingId = data.bookingId;
        const candidateCustomerId = String(data.customerId || data.userId || '');
        const candidatePhone = String(data.customerPhone || data.phone || '').replace(/[^0-9]/g, '');
        const targetDriverId = String(data.driverId || '');

        // 1. Memory lookup
        let booking = (db.memoryState.bookings || []).find(b => {
            if (bookingId) {
                return (b.id === bookingId || b.bookingId === bookingId);
            }
            const bCustId = String(b.customerId || b.passengerId || '');
            const bPhone = String(b.customerPhone || b.phone || '').replace(/[^0-9]/g, '');
            const isCust = (candidateCustomerId && (bCustId === candidateCustomerId || bCustId.endsWith(candidateCustomerId))) || 
                           (candidatePhone.length >= 7 && bPhone.length >= 7 && bPhone.endsWith(candidatePhone.slice(-8)));
            const isDrv = !targetDriverId || (b.driverId === targetDriverId || b.driverPhone === targetDriverId);
            const st = String(b.status || '').toLowerCase();
            const isActive = st === 'confirmed' || st === 'pending' || st === 'active';
            return isCust && isDrv && isActive;
        });

        // 2. PostgreSQL safe query (supports text bookingId and customer fallback via users JOIN)
        if (!booking && db.isPostgresConnected && db.pool) {
            try {
                let pgRes = null;
                if (bookingId) {
                    pgRes = await db.pool.query('SELECT * FROM bookings WHERE id = $1 LIMIT 1', [bookingId]);
                }
                if ((!pgRes || !pgRes.rows || pgRes.rows.length === 0) && (candidateCustomerId || candidatePhone)) {
                    pgRes = await db.pool.query(`
                        SELECT b.*, u.phone_number as customer_phone
                        FROM bookings b
                        LEFT JOIN users u ON b.customer_id = u.id
                        WHERE (
                          ($1 <> '' AND b.customer_id::text = $1)
                          OR ($2 <> '' AND u.phone_number IS NOT NULL AND RIGHT(REGEXP_REPLACE(u.phone_number, '[^0-9]', '', 'g'), 8) = RIGHT($2, 8))
                        )
                        AND ($3 = '' OR b.driver_id = $3)
                        ORDER BY b.created_at DESC LIMIT 1
                    `, [candidateCustomerId || '', candidatePhone || '', targetDriverId || '']);
                }
                if (pgRes && pgRes.rows && pgRes.rows.length > 0) {
                    const r = pgRes.rows[0];
                    booking = {
                        id: r.id,
                        bookingId: r.id,
                        routeId: r.route_id,
                        driverId: r.driver_id,
                        driverName: r.driver_name,
                        customerId: r.customer_id,
                        customerName: r.customer_name,
                        customerPhone: r.customer_phone || candidatePhone,
                        pickupLocation: r.pickup_name,
                        dropoffLocation: r.dropoff_name,
                        seatsBooked: r.seats_booked || 1,
                        status: r.status,
                        createdAt: r.created_at
                    };
                    db.memoryState.bookings.unshift(booking);
                }
            } catch (pgErr) {
                console.error('[AdminController] PG find booking error:', pgErr.message);
            }
        }

        // 3. Fallback: if booking still not found by ID or customer, check if active customer exists with assignedDriverId
        if (!booking && (candidateCustomerId || candidatePhone)) {
            const cust = (db.memoryState.customers || []).find(c => 
                (candidateCustomerId && (c.customerId === candidateCustomerId || c.id === candidateCustomerId)) ||
                (candidatePhone.length >= 7 && c.phoneNumber && c.phoneNumber.replace(/[^0-9]/g, '').endsWith(candidatePhone.slice(-8)))
            );
            if (cust && (cust.assignedDriverId || targetDriverId)) {
                // Synthesize booking entry to allow clean cancellation
                booking = {
                    id: bookingId || `bk-sub-${cust.customerId || Date.now()}`,
                    bookingId: bookingId || `bk-sub-${cust.customerId || Date.now()}`,
                    customerId: cust.customerId || candidateCustomerId,
                    customerName: cust.fullName || 'الراكب',
                    customerPhone: cust.phoneNumber || candidatePhone,
                    driverId: cust.assignedDriverId || targetDriverId,
                    routeId: cust.route || '',
                    seatsBooked: 1,
                    status: 'Confirmed'
                };
                db.memoryState.bookings.unshift(booking);
            }
        }

        if (!booking) {
            return { success: false, error: 'لم يتم العثور على حجز نشط لهذا الراكب', code: 404 };
        }

        // 4. RLS Ownership Check (403)
        if (authUser && authUser.role !== 'Admin' && authUser.role !== 'admin') {
            const requesterId = String(authUser.id || authUser.userId || '');
            const requesterPhone = String(authUser.phone || authUser.phoneNumber || '').replace(/[^0-9]/g, '');
            const bCustId = String(booking.customerId || booking.passengerId || '');
            const bPhone = String(booking.customerPhone || '').replace(/[^0-9]/g, '');
            const idMatch = requesterId && (bCustId === requesterId || bCustId.endsWith(requesterId));
            const phoneMatch = requesterPhone.length >= 7 && bPhone.length >= 7 && (bPhone.endsWith(requesterPhone.slice(-8)) || requesterPhone.endsWith(bPhone.slice(-8)));
            if (!idMatch && !phoneMatch && (requesterId || requesterPhone)) {
                return { success: false, error: 'غير مصرح لك بإلغاء حجز لا يخصك (403)', code: 403 };
            }
        }

        // 5. Clean handling of already finished / cancelled states
        const currentStatus = String(booking.status || '').toLowerCase();
        if (currentStatus === 'cancelled' || currentStatus === 'declined' || currentStatus === 'rejected') {
            return {
                success: true,
                message: 'الحجز ملغى مسبقاً',
                alreadyCancelled: true,
                bookingId: booking.id || booking.bookingId
            };
        }

        const reason = data.reason || 'ظروف شخصية';
        const details = data.details || '';

        // 6. Immediately cancel the booking
        booking.status = 'Cancelled';
        booking.cancellationPending = false;
        booking.cancellationRequested = false;
        booking.cancellation_requested = false;
        booking.cancellationStatus = 'cancelled';
        booking.cancellation_status = 'cancelled';
        booking.cancellationReason = reason;
        booking.cancellation_reason = reason;
        booking.cancellationDetails = details;
        booking.cancellation_details = details;
        booking.cancellationRequestedAt = new Date().toISOString();
        booking.cancelledAt = new Date().toISOString();

        // 7. Free seat in route immediately
        const targetRoute = (db.memoryState.routes || []).find(r =>
            r.id === booking.routeId || r.routeId === booking.routeId
        );
        if (targetRoute) {
            const totalCap = targetRoute.totalSeats || 4;
            const freedSeats = parseInt(booking.seatsBooked || 1, 10);
            targetRoute.availableSeats = Math.min(totalCap, (targetRoute.availableSeats || 0) + freedSeats);
        }

        // 8. Unlink customer from driver
        const cust = (db.memoryState.customers || []).find(c =>
            c.customerId === booking.customerId ||
            (candidatePhone && c.phoneNumber && c.phoneNumber.replace(/[^0-9]/g, '').endsWith(candidatePhone.slice(-8)))
        );
        if (cust) {
            cust.assignedDriverId = null;
            cust.driverId = null;
            cust.bookingConfirmed = false;
        }

        // 9. Persist to PostgreSQL if connected
        if (db.isPostgresConnected && db.pool) {
            try {
                if (booking && booking.id) {
                    await db.pool.query(
                        `UPDATE bookings SET status = 'Cancelled', cancellation_requested = false, cancellation_status = 'cancelled', cancellation_reason = $1, updated_at = NOW() WHERE id = $2`,
                        [reason, booking.id]
                    );
                }
                if (targetRoute && targetRoute.id) {
                    await db.pool.query(`UPDATE routes SET available_seats = $1 WHERE id = $2`, [targetRoute.availableSeats, targetRoute.id]).catch(() => {});
                }
            } catch (pgErr) {
                console.error('[AdminController] PG requestRouteCancellation error:', pgErr.message);
            }
        }

        // Broadcast cluster sync to all PM2 instances
        const targetDrvId = booking.driverId || targetDriverId;
        await this.broadcastBookingStatusSync(booking ? booking.id : bookingId, 'Cancelled', {
            customerId: booking ? booking.customerId : candidateCustomerId,
            driverId: targetDrvId,
            reason: reason,
            cancellationStatus: 'cancelled'
        });

        // 10. Notify Driver via SSE stream immediately
        if (targetDrvId) {
            try {
                const redisManager = require('../redis/redisClient');
                redisManager.publishDriverEvent(targetDrvId, {
                    type: 'subscriber_cancelled',
                    bookingId: booking.id || booking.bookingId,
                    routeId: booking.routeId || '',
                    customerName: booking.customerName || 'أحد الركاب',
                    reason: reason,
                    freedSeats: booking.seatsBooked || 1,
                    timestamp: Date.now()
                });
            } catch (sseErr) {
                console.warn('[AdminController] Driver SSE notify error:', sseErr.message);
            }

            // 11. Notify Driver via Telegram with SET NX distributed lock
            try {
                const redisManager = require('../redis/redisClient');
                const telegramBot = require('../telegram/telegramBot');
                const lockKey = `lock:tg:sub_cancel:${booking.id || booking.bookingId}:${booking.driverId}`;
                const lockAcquired = await redisManager.acquireTelegramNotificationLock(lockKey, 3600);
                if (lockAcquired) {
                    const chatId = await telegramBot.findDriverTelegramChatId(targetDrvId, booking.driverPhone);
                    if (chatId) {
                        const maskedPhone = booking.customerPhone ? `${booking.customerPhone.slice(0, 4)}****${booking.customerPhone.slice(-3)}` : '****';
                        const tgMsg = `⚠️ *تنبيه: إلغاء حجز / اشتراك راكب في الخط الدائم*\n\nالراكب: ${booking.customerName || 'راكب'}\nالهاتف: ${maskedPhone}\nالسبب: ${reason}\n\n✅ تم تحرير المقعد في المسار بنجاح ليصبح متاحاً للركاب الآخرين.`;
                        await telegramBot.sendMessage(chatId, tgMsg, { parse_mode: 'Markdown' });
                    }
                }
            } catch (tgErr) {
                console.warn('[AdminController] Driver Telegram notify error:', tgErr.message);
            }
        }

        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return {
            success: true,
            message: 'تم إلغاء حجزك / اشتراكك في الخط الدائمي بنجاح وتحرير المقعد',
            bookingId: booking.id || booking.bookingId
        };
    }

    // 14. Route Cancellation Cycle: Driver Respond (Approve / Reject)
    async respondRouteCancellation(data) {
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        const bookingId = data.bookingId;
        const action = data.action; // 'approve' | 'reject'
        const driverApprovalReason = data.driverApprovalReason || (action === 'approve' ? 'تم التراضي مع الراكب' : 'رفض الكابتن');

        let booking = (db.memoryState.bookings || []).find(b => b.id === bookingId || b.bookingId === bookingId);
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(bookingId));
        if (!booking && db.isPostgresConnected && db.pool && isUuid) {
            try {
                const pgRes = await db.pool.query('SELECT * FROM bookings WHERE id = $1 LIMIT 1', [bookingId]);
                if (pgRes.rows && pgRes.rows.length > 0) {
                    const r = pgRes.rows[0];
                    booking = {
                        id: r.id,
                        bookingId: r.id,
                        routeId: r.route_id,
                        driverId: r.driver_id,
                        driverName: r.driver_name,
                        customerId: r.customer_id,
                        customerName: r.customer_name,
                        customerPhone: r.customer_phone,
                        pickupLocation: r.pickup_name,
                        dropoffLocation: r.dropoff_name,
                        seatsBooked: r.seats_booked || 1,
                        status: r.status,
                        createdAt: r.created_at
                    };
                    db.memoryState.bookings.unshift(booking);
                }
            } catch (pgErr) {
                console.error('[AdminController] PG find booking error in respond:', pgErr.message);
            }
        }

        if (booking && (booking.status === 'Cancelled' || String(booking.status).toLowerCase() === 'cancelled')) {
            return { success: true, message: 'الحجز ملغى مسبقاً', action: 'already_cancelled' };
        }

        if (!booking) {
            return { success: true, message: 'الحجز غير نشط أو تم إنهاؤه مسبقاً', action: 'already_handled' };
        }

        let cancelReq = db.memoryState.cancellationRequests.find(r => r.bookingId === (booking.id || bookingId));

        if (action === 'approve') {
            booking.status = 'Cancelled';
            booking.cancellationPending = false;
            booking.cancellation_requested = false;
            booking.cancellation_status = 'approved';
            booking.cancellationApproved = true;
            booking.driverApprovalReason = driverApprovalReason;
            booking.driver_approval_reason = driverApprovalReason;
            booking.cancelledAt = new Date().toISOString();

            // Free seat in route
            const targetRoute = (db.memoryState.routes || []).find(r => (r.id === booking.routeId || r.routeId === booking.routeId));
            if (targetRoute) {
                const totalCap = targetRoute.totalSeats || 4;
                const freedSeats = parseInt(booking.seatsBooked || 1, 10);
                targetRoute.availableSeats = Math.min(totalCap, (targetRoute.availableSeats || 0) + freedSeats);
            }

            // Unlink customer from driver
            const cust = (db.memoryState.customers || []).find(c => c.customerId === booking.customerId || c.phoneNumber === booking.customerPhone);
            if (cust) {
                cust.assignedDriverId = null;
                cust.driverId = null;
                cust.bookingConfirmed = false;
            }

            if (cancelReq) {
                cancelReq.status = 'Approved';
                cancelReq.driverDecision = 'approved';
                cancelReq.driverApprovalReason = driverApprovalReason;
                cancelReq.resolvedAt = new Date().toISOString();
            }

            if (db.isPostgresConnected && db.pool) {
                try {
                    await db.pool.query(`
                        UPDATE bookings 
                        SET status = 'Cancelled', 
                            cancellation_requested = false,
                            cancellation_status = 'approved',
                            cancellation_reason = COALESCE(cancellation_reason, '') || ' | موافقة السائق: ' || $1,
                            driver_approval_reason = $1,
                            updated_at = NOW() 
                        WHERE id = $2
                    `, [driverApprovalReason, booking.id || bookingId]);

                    if (targetRoute) {
                        await db.pool.query(`UPDATE routes SET available_seats = $1 WHERE id = $2`, [targetRoute.availableSeats, targetRoute.id]);
                    }

                    await db.pool.query(`
                        UPDATE cancellation_requests 
                        SET status = 'Approved', driver_decision = 'approved', driver_approval_reason = $1, resolved_at = NOW() 
                        WHERE booking_id = $2
                    `, [driverApprovalReason, booking.id || bookingId]);
                } catch (pgErr) {
                    console.error('[AdminController] PG approve cancel error:', pgErr.message);
                }
            }

            db.saveStateSnapshot();
            return {
                success: true,
                message: 'تمت الموافقة على إلغاء الاشتراك وإنهاء الحجز بنجاح',
                action: 'approved'
            };
        } else {
            booking.status = 'Confirmed';
            booking.cancellationPending = false;
            booking.cancellation_requested = false;
            booking.cancellation_status = 'rejected';
            booking.cancellationRejected = true;
            booking.cancellationRejectedAt = new Date().toISOString();

            if (cancelReq) {
                cancelReq.status = 'Rejected';
                cancelReq.driverDecision = 'rejected';
                cancelReq.driverApprovalReason = driverApprovalReason;
                cancelReq.resolvedAt = new Date().toISOString();
            }

            if (db.isPostgresConnected && db.pool) {
                try {
                    await db.pool.query(`
                        UPDATE bookings 
                        SET status = 'Confirmed', 
                            cancellation_requested = false,
                            cancellation_status = 'rejected',
                            updated_at = NOW() 
                        WHERE id = $1
                    `, [booking.id || bookingId]);

                    await db.pool.query(`
                        UPDATE cancellation_requests 
                        SET status = 'Rejected', driver_decision = 'rejected', driver_approval_reason = $1, resolved_at = NOW() 
                        WHERE booking_id = $2
                    `, [driverApprovalReason, booking.id || bookingId]);
                } catch (pgErr) {
                    console.error('[AdminController] PG reject cancel error:', pgErr.message);
                }
            }

            db.saveStateSnapshot();
            return {
                success: true,
                message: 'تم رفض طلب الإلغاء والإبقاء على الاشتراك',
                action: 'rejected'
            };
        }
    }

    // 15. Driver Force-Cancel a Subscriber (Driver removes subscriber from permanent route)
    async driverCancelSubscriber(data, authUser = null) {
        db.memoryState.bookings = db.memoryState.bookings || [];
        db.memoryState.customers = db.memoryState.customers || [];
        const rawBookingId = String(data.bookingId || '').trim();
        const candidateCustomerId = String(data.customerId || data.userId || '').trim();
        const candidatePhone = String(data.customerPhone || data.phone || '').replace(/[^0-9]/g, '');
        const targetDriverId = String(data.driverId || '').trim();
        const reason = data.reason || 'إلغاء من الكابتن';

        // Extract customer ID if passed as 'bk-assign-cust_...'
        let cleanCustId = candidateCustomerId;
        if (!cleanCustId && rawBookingId.startsWith('bk-assign-')) {
            cleanCustId = rawBookingId.replace('bk-assign-', '');
        }

        // 1. RLS Authorization Check: Driver can only remove passengers from their own route
        if (authUser && authUser.role === 'Driver') {
            const actualAuthDriverId = String(authUser.id || authUser.driverId || authUser.userId || '');
            const actualAuthPhone = String(authUser.phone || authUser.phoneNumber || '').replace(/[^0-9]/g, '');
            const targetId = targetDriverId || actualAuthDriverId;
            const idMatch = actualAuthDriverId && (targetId === actualAuthDriverId || targetId.includes(actualAuthDriverId));
            const phoneMatch = actualAuthPhone.length >= 7 && targetId.includes(actualAuthPhone.slice(-8));
            if (!idMatch && !phoneMatch && targetId !== 'drv-sample') {
                return { success: false, error: 'غير مصرح لك بإلغاء ركاب خط كابتن آخر (403)', code: 403 };
            }
        }

        // 2. Find booking in memory
        let booking = db.memoryState.bookings.find(b => {
            if (rawBookingId && !rawBookingId.startsWith('bk-assign-')) {
                return (b.id === rawBookingId || b.bookingId === rawBookingId);
            }
            const bCustId = String(b.customerId || b.passengerId || '');
            const bPhone = String(b.customerPhone || b.phone || '').replace(/[^0-9]/g, '');
            const custMatch = (cleanCustId && (bCustId === cleanCustId || bCustId.endsWith(cleanCustId))) ||
                              (candidatePhone.length >= 7 && bPhone.length >= 7 && bPhone.endsWith(candidatePhone.slice(-8)));
            const drvMatch = !targetDriverId || (b.driverId === targetDriverId || b.driverPhone === targetDriverId);
            const st = String(b.status || '').toLowerCase();
            const isActive = st === 'confirmed' || st === 'pending' || st === 'active';
            return custMatch && drvMatch && isActive;
        });

        // 3. PostgreSQL query if not in memory
        if (!booking && db.isPostgresConnected && db.pool) {
            try {
                let pgRes = null;
                if (rawBookingId && !rawBookingId.startsWith('bk-assign-')) {
                    pgRes = await db.pool.query('SELECT * FROM bookings WHERE id = $1 LIMIT 1', [rawBookingId]);
                }
                if ((!pgRes || !pgRes.rows || pgRes.rows.length === 0) && (cleanCustId || candidatePhone)) {
                    pgRes = await db.pool.query(`
                        SELECT b.*, u.phone_number as customer_phone
                        FROM bookings b
                        LEFT JOIN users u ON b.customer_id = u.id
                        WHERE (
                          ($1 <> '' AND b.customer_id::text = $1)
                          OR ($2 <> '' AND u.phone_number IS NOT NULL AND RIGHT(REGEXP_REPLACE(u.phone_number, '[^0-9]', '', 'g'), 8) = RIGHT($2, 8))
                        )
                        AND ($3 = '' OR b.driver_id = $3)
                        ORDER BY b.created_at DESC LIMIT 1
                    `, [cleanCustId || '', candidatePhone || '', targetDriverId || '']);
                }
                if (pgRes && pgRes.rows && pgRes.rows.length > 0) {
                    const r = pgRes.rows[0];
                    booking = {
                        id: r.id,
                        bookingId: r.id,
                        routeId: r.route_id,
                        driverId: r.driver_id,
                        driverName: r.driver_name,
                        customerId: r.customer_id,
                        customerName: r.customer_name,
                        customerPhone: r.customer_phone || candidatePhone,
                        pickupLocation: r.pickup_name,
                        dropoffLocation: r.dropoff_name,
                        seatsBooked: r.seats_booked || 1,
                        status: r.status,
                        createdAt: r.created_at
                    };
                    db.memoryState.bookings.unshift(booking);
                }
            } catch (pgErr) {
                console.error('[AdminController] PG find booking error in driverCancelSubscriber:', pgErr.message);
            }
        }

        // 4. Find customer in memory
        const cust = db.memoryState.customers.find(c => {
            const cId = String(c.customerId || c.id || '');
            const cPhone = String(c.phoneNumber || c.phone || '').replace(/[^0-9]/g, '');
            return (cleanCustId && (cId === cleanCustId || cId.endsWith(cleanCustId))) ||
                   (rawBookingId && (cId === rawBookingId || cId.endsWith(rawBookingId))) ||
                   (candidatePhone.length >= 7 && cPhone.length >= 7 && cPhone.endsWith(candidatePhone.slice(-8)));
        });

        if (!booking && !cust) {
            return { success: false, error: 'المشترك غير موجود في قائمة الركاب', code: 404 };
        }

        // 5. Update booking status & free seats in route
        let freedSeatsCount = 1;
        if (booking) {
            freedSeatsCount = parseInt(booking.seatsBooked || 1, 10);
            booking.status = 'Cancelled';
            booking.cancellationPending = false;
            booking.cancellation_requested = false;
            booking.cancellation_status = 'driver_cancelled';
            booking.cancellationApproved = true;
            booking.cancellationReason = reason;
            booking.cancelledAt = new Date().toISOString();

            const targetRoute = (db.memoryState.routes || []).find(r =>
                r.id === booking.routeId || r.routeId === booking.routeId
            );
            if (targetRoute) {
                const totalCap = targetRoute.totalSeats || 4;
                targetRoute.availableSeats = Math.min(totalCap, (targetRoute.availableSeats || 0) + freedSeatsCount);
            }
        }

        // 6. Complete Unlinking: unassign customer from driver so assignedCustomers never re-adds them!
        const targetCust = cust || (booking ? db.memoryState.customers.find(c => 
            c.customerId === booking.customerId || 
            (booking.customerPhone && c.phoneNumber && c.phoneNumber.replace(/[^0-9]/g, '').endsWith(String(booking.customerPhone).slice(-8)))
        ) : null);

        if (targetCust) {
            targetCust.assignedDriverId = null;
            targetCust.driverId = null;
            targetCust.bookingConfirmed = false;
        }

        // Also sweep any duplicates in memory
        for (const c of db.memoryState.customers) {
            const matchId = cleanCustId && (c.customerId === cleanCustId || c.id === cleanCustId);
            const matchPhone = candidatePhone.length >= 7 && c.phoneNumber && c.phoneNumber.replace(/[^0-9]/g, '').endsWith(candidatePhone.slice(-8));
            const matchBookingCust = booking && (c.customerId === booking.customerId);
            if (matchId || matchPhone || matchBookingCust) {
                c.assignedDriverId = null;
                c.driverId = null;
                c.bookingConfirmed = false;
            }
        }

        // 7. Persist to PostgreSQL if connected
        if (db.isPostgresConnected && db.pool) {
            try {
                const bId = (booking && booking.id) || (rawBookingId && !rawBookingId.startsWith('bk-assign-') ? rawBookingId : null);
                if (bId) {
                    await db.pool.query(
                        `UPDATE bookings SET status = 'Cancelled', cancellation_requested = false, cancellation_status = 'driver_cancelled', cancellation_reason = $1, updated_at = NOW() WHERE id = $2`,
                        [reason, bId]
                    );
                }
                const resolvedCustId = (targetCust && targetCust.customerId) || cleanCustId || (booking && booking.customerId);
                if (resolvedCustId) {
                    await db.pool.query(
                        `UPDATE bookings SET status = 'Cancelled', cancellation_requested = false, cancellation_status = 'driver_cancelled', cancellation_reason = $1, updated_at = NOW() WHERE customer_id = $2 AND (driver_id = $3 OR $3 = '') AND status IN ('Pending', 'Confirmed', 'Active', 'cancellation_pending')`,
                        [reason, resolvedCustId, targetDriverId || '']
                    ).catch(() => {});
                }
                const targetRoute = (db.memoryState.routes || []).find(r => booking && (r.id === booking.routeId || r.routeId === booking.routeId));
                if (targetRoute && targetRoute.id) {
                    await db.pool.query(`UPDATE routes SET available_seats = $1 WHERE id = $2`, [targetRoute.availableSeats, targetRoute.id]).catch(() => {});
                }
            } catch (pgErr) {
                console.error('[AdminController] PG driverCancelSubscriber error:', pgErr.message);
            }
        }

        // Broadcast cluster sync to all PM2 instances
        const resolvedCustomerId = (booking && booking.customerId) || (targetCust && targetCust.customerId) || cleanCustId;
        await this.broadcastBookingStatusSync((booking && booking.id) || rawBookingId, 'Cancelled', {
            customerId: resolvedCustomerId,
            driverId: targetDriverId,
            reason: reason,
            cancellationStatus: 'driver_cancelled'
        });

        // 8. Notify Passenger via SSE & Telegram (with SET NX distributed lock)
        const resolvedCustomerPhone = (booking && (booking.customerPhone || booking.phone)) || (targetCust && targetCust.phoneNumber) || candidatePhone;
        const customerName = (booking && booking.customerName) || (targetCust && (targetCust.fullName || targetCust.name)) || 'الراكب';

        // 8a. SSE broadcast to passenger
        if (resolvedCustomerId || resolvedCustomerPhone) {
            try {
                const redisManager = require('../redis/redisClient');
                const cancelEvent = {
                    type: 'subscription_cancelled_by_driver',
                    event: 'subscription_cancelled_by_driver',
                    status: 'Cancelled',
                    cancelledBy: 'driver',
                    driverId: targetDriverId,
                    bookingId: (booking && (booking.id || booking.bookingId)) || rawBookingId,
                    reason: reason,
                    timestamp: Date.now()
                };
                if (resolvedCustomerId) {
                    redisManager.publishRideEvent(`cust:${resolvedCustomerId}`, cancelEvent);
                    if (typeof redisManager.publishCustomerEvent === 'function') {
                        redisManager.publishCustomerEvent(resolvedCustomerId, cancelEvent);
                    }
                }
            } catch (sseErr) {
                console.warn('[AdminController] Customer SSE notify error:', sseErr.message);
            }

            // 8b. Telegram to passenger (once with SET NX distributed lock)
            try {
                const redisManager = require('../redis/redisClient');
                const telegramBot = require('../telegram/telegramBot');
                const lockKey = `lock:tg:drv_cancel_sub:${resolvedCustomerId || resolvedCustomerPhone}:${targetDriverId}`;
                const lockAcquired = await redisManager.acquireTelegramNotificationLock(lockKey, 3600);
                if (lockAcquired && typeof telegramBot.findCustomerTelegramChatId === 'function') {
                    const custChatId = await telegramBot.findCustomerTelegramChatId({ customerId: resolvedCustomerId, phone: resolvedCustomerPhone });
                    if (custChatId && typeof telegramBot.sendMessage === 'function') {
                        const tgMsg = `⚠️ *تنبيه من إدارة خط التوصيل*\n\nعزيزي الراكب (${customerName})، تم إلغاء اشتراكك في الخط الدائمي من قبل الكابتن.\nالسبب: ${reason}\n\nيمكنك اختيار كابتن وخط بديل في أي وقت عبر التطبيق.`;
                        await telegramBot.sendMessage(custChatId, tgMsg, { parse_mode: 'Markdown' });
                    }
                }
            } catch (tgErr) {
                console.warn('[AdminController] Customer Telegram notify error:', tgErr.message);
            }
        }

        db.saveStateSnapshot();
        invalidateDriversCache();
        invalidateCustomersCache();

        return {
            success: true,
            message: 'تم إلغاء اشتراك الراكب وتحرير مقعده بنجاح ✅',
            bookingId: (booking && (booking.id || booking.bookingId)) || rawBookingId
        };
    }
}

module.exports = new AdminController();
