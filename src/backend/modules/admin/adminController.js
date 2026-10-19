const db = require('../../db');
const backupService = require('../backup/backupService');
const auditService = require('../audit/auditService');
const pricingService = require('../pricing/pricingService');
const complaintService = require('../complaint/complaintService');

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

    // 3. Drivers Management
    async getDrivers(search = '') {
        let drivers = [...db.memoryState.drivers];
        if (search) {
            const q = search.toLowerCase();
            drivers = drivers.filter(d => 
                (d.fullName && d.fullName.toLowerCase().includes(q)) ||
                (d.phoneNumber && d.phoneNumber.includes(q)) ||
                (d.licenseNumber && d.licenseNumber.toLowerCase().includes(q))
            );
        }

        const enrichedDrivers = drivers.map(d => {
            const routeObj = db.memoryState.routes.find(r => r.driverId === d.driverId);
            const routeName = (routeObj ? (routeObj.name || `${routeObj.startName} - ${routeObj.endName}`) : null) || d.route || 'غير محدد';
            return {
                ...d,
                route: routeName,
                password: d.plainPassword || (d.passwordHash ? '••••••••' : '123456'),
                points: parseInt(d.points || d.rewardScore || 0, 10),
                telegramChatId: d.telegramChatId || d.telegram_chat_id || ''
            };
        });

        return {
            success: true,
            total: enrichedDrivers.length,
            drivers: enrichedDrivers
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
                        telegramChatId: row.telegram_chat_id ? String(row.telegram_chat_id) : null
                    };
                    db.memoryState.drivers.unshift(driver);
                }
            } catch (_) {}
        }
        if (!driver) return { success: false, error: 'السائق غير موجود' };

        if (data.fullName !== undefined) driver.fullName = String(data.fullName).trim();
        if (data.phoneNumber !== undefined) driver.phoneNumber = String(data.phoneNumber).trim();
        if (data.governorate !== undefined) driver.governorate = String(data.governorate).trim();
        if (data.vehicleType !== undefined) driver.vehicleType = String(data.vehicleType).toLowerCase() === 'vip' ? 'vip' : 'eco';
        if (data.telegramChatId !== undefined || data.telegram_chat_id !== undefined) {
            const rawTg = String(data.telegramChatId !== undefined ? data.telegramChatId : data.telegram_chat_id).trim();
            driver.telegramChatId = rawTg || null;
            if (db.isPostgresConnected && db.pool) {
                try {
                    await db.pool.query('UPDATE drivers SET telegram_chat_id = $1 WHERE driver_id = $2', [driver.telegramChatId, driverId]);
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

        const effectiveRouteName = data.route ? String(data.route).trim() : (driver.route || 'مسار دائمي');
        driver.route = effectiveRouteName;

        const sName = effectiveRouteName.split(/[-➔→]/)[0]?.trim() || 'نقطة الانطلاق';
        const eName = effectiveRouteName.split(/[-➔→]/)[1]?.trim() || 'نقطة الوصول';
        const sLat = parseFloat(driver.currentLat || driver.latitude || 31.9961);
        const sLon = parseFloat(driver.currentLon || driver.longitude || 44.3168);
        const eLat = parseFloat(driver.activeRoute?.toLat || 32.0321);
        const eLon = parseFloat(driver.activeRoute?.toLon || 44.3725);
        const vInfo = `${driver.vehicleMake || 'تويوتا'} ${driver.vehicleModel || 'كورولا'} (${driver.vehiclePlate || 'النجف'})`;

        // Update or insert in memoryState.routes
        let r = db.memoryState.routes.find(rt => rt.driverId === driverId);
        if (r) {
            r.name = driver.route;
            r.startName = sName;
            r.endName = eName;
            r.startLat = sLat;
            r.startLon = sLon;
            r.endLat = eLat;
            r.endLon = eLon;
            r.driverName = driver.fullName;
            r.driverPhone = driver.phoneNumber;
            r.vehicleInfo = vInfo;
            r.status = 'Active';
        } else {
            db.memoryState.routes.push({
                id: 'route-' + driverId,
                routeId: 'route-' + driverId,
                driverId: driverId,
                driverName: driver.fullName,
                driverPhone: driver.phoneNumber,
                vehicleInfo: vInfo,
                name: driver.route,
                startName: sName,
                endName: eName,
                startLat: sLat,
                startLon: sLon,
                endLat: eLat,
                endLon: eLon,
                fare: 3000,
                availableSeats: 4,
                totalSeats: 4,
                departureTime: '07:30 ص',
                status: 'Active',
                createdAt: new Date().toISOString()
            });
        }

        // Establish driver in permanent routes list
        db.memoryState.permanentRoutes = db.memoryState.permanentRoutes || [];
        let prIdx = db.memoryState.permanentRoutes.findIndex(item => item.driverId === driverId || item.id === 'route-' + driverId);
        const permRouteObj = {
            id: 'route-' + driverId,
            driverId: driverId,
            driverName: driver.fullName,
            driverPhone: driver.phoneNumber,
            vehicleInfo: vInfo,
            vehicleType: driver.vehicleType || 'eco',
            startName: sName,
            endName: eName,
            startLat: sLat,
            startLon: sLon,
            endLat: eLat,
            endLon: eLon,
            fare: 3000,
            days: ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء'],
            departureTime: '07:30 ص',
            status: 'Active',
            isDriverRoute: true,
            createdAt: new Date().toISOString()
        };
        if (prIdx >= 0) {
            db.memoryState.permanentRoutes[prIdx] = { ...db.memoryState.permanentRoutes[prIdx], ...permRouteObj };
        } else {
            db.memoryState.permanentRoutes.unshift(permRouteObj);
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
                        latitude = COALESCE($5, latitude), longitude = COALESCE($6, longitude), updated_at = NOW()
                    WHERE driver_id = $7
                `, [driver.fullName, driver.phoneNumber, driver.passwordHash || null, driver.plainPassword || null, driver.permanentLat || null, driver.permanentLon || null, driverId]);

                await db.pool.query(`
                    UPDATE users 
                    SET full_name = $1, phone_number = $2, password_hash = COALESCE($3, password_hash), plain_password = COALESCE($4, plain_password), updated_at = NOW()
                    WHERE id = $5
                `, [driver.fullName, driver.phoneNumber, driver.passwordHash || null, driver.plainPassword || null, driverId]);

                await db.pool.query(`
                    INSERT INTO routes (id, driver_id, driver_name, driver_phone, start_name, end_name, start_lat, start_lon, end_lat, end_lon, fare, available_seats, total_seats, departure_time, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 3000, 4, 4, '07:30 ص', 'Active', NOW())
                    ON CONFLICT (id) DO UPDATE SET
                        start_name = EXCLUDED.start_name, end_name = EXCLUDED.end_name,
                        start_lat = EXCLUDED.start_lat, start_lon = EXCLUDED.start_lon,
                        end_lat = EXCLUDED.end_lat, end_lon = EXCLUDED.end_lon
                `, ['route-' + driverId, driverId, driver.fullName, driver.phoneNumber, sName, eName, sLat, sLon, eLat, eLon]);
            } catch (e) {
                console.error('[AdminController] updateDriver PG error:', e);
            }
        }

        db.addAuditLog('DriverUpdated', 'Driver', driverId, {
            fullName: driver.fullName,
            phoneNumber: driver.phoneNumber,
            route: driver.route
        });
        db.saveStateSnapshot();
        return { success: true, driver };
    }

    async getDriverById(driverId) {
        const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
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
        return result;
    }

    async setDriverApproval(driverId, isApproved) {
        return await db.setDriverApproval(driverId, isApproved);
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

        return { success: true, isBlocked: driver.isBlocked, status: driver.status };
    }

    async deleteDriver(driverId) {
        return await db.deleteDriver(driverId);
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

    // 5. Customers Management
    async getCustomers(search = '') {
        let customers = [...db.memoryState.customers];
        if (search) {
            const q = search.toLowerCase();
            customers = customers.filter(c =>
                (c.fullName && c.fullName.toLowerCase().includes(q)) ||
                (c.phoneNumber && c.phoneNumber.includes(q)) ||
                (c.email && c.email.toLowerCase().includes(q))
            );
        }

        const enrichedCustomers = customers.map(c => ({
            ...c,
            route: c.route || c.preferredRoute || c.area || 'النجف الأشرف',
            address: c.address || c.area || 'النجف الأشرف',
            password: c.plainPassword || (c.passwordHash ? '••••••••' : '123456')
        }));

        return {
            success: true,
            total: enrichedCustomers.length,
            customers: enrichedCustomers
        };
    }

    async createCustomer(data) {
        const { fullName, phoneNumber, password, route, address } = data;
        if (!fullName || !phoneNumber || !password) {
            return { success: false, error: 'الاسم الكامل، رقم الهاتف، وكلمة المرور مطلوبة.' };
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
        const pass = String(password).trim();
        const passwordHash = crypto.createHash('sha256').update(pass).digest('hex');
        const customerId = 'usr-c-' + Math.random().toString(36).substr(2, 9);
        const now = new Date().toISOString();
        const userRoute = (route || 'النجف الأشرف').trim();
        const userAddress = (address || 'النجف الأشرف').trim();
        const normalizedPhone = norm.startsWith('0') ? norm : ('0' + norm);

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
            createdByAdmin: true
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
                    INSERT INTO customers (customer_id, full_name, phone_number, email, route, address, plain_password, password_hash, preferred_payment_method, rating_average, total_bookings, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Cash', 5.0, 0, true, false, $9)
                    ON CONFLICT (customer_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, route = EXCLUDED.route, address = EXCLUDED.address, plain_password = EXCLUDED.plain_password, password_hash = EXCLUDED.password_hash
                `, [customerId, newCustomer.fullName, normalizedPhone, newCustomer.email, userRoute, userAddress, pass, passwordHash, now]);
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

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE customers 
                    SET full_name = $1, phone_number = $2, route = $3, address = $4, plain_password = $5, password_hash = $6
                    WHERE customer_id = $7
                `, [customer.fullName, customer.phoneNumber, customer.route, customer.address, customer.plainPassword, customer.passwordHash, customerId]);

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

    async acceptBooking(bookingId, driverId = null) {
        let booking = (db.memoryState.bookings || []).find(b => (b.id === bookingId || b.bookingId === bookingId));
        
        if (!booking && db.isPostgresConnected && db.pool) {
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
                        totalFare: r.total_fare,
                        createdAt: r.created_at
                    };
                    db.memoryState.bookings.unshift(booking);
                }
            } catch (e) {
                console.error('[AdminController] PG fetch booking error:', e);
            }
        }

        if (!booking) {
            return { success: false, error: 'الحجز غير موجود' };
        }

        booking.status = 'Confirmed';
        booking.acceptedAt = new Date().toISOString();

        // Deduct seats from target route
        const targetRoute = (db.memoryState.routes || []).find(r => (r.id === booking.routeId || r.routeId === booking.routeId));
        if (targetRoute && !booking.seatsDeducted) {
            targetRoute.availableSeats = Math.max(0, (targetRoute.availableSeats || 4) - (booking.seatsBooked || 1));
            booking.seatsDeducted = true;
        }

        // Link customer to driver so customer is confirmed passenger
        const cust = (db.memoryState.customers || []).find(c => c.customerId === booking.customerId || c.phoneNumber === booking.customerPhone);
        if (cust) {
            cust.assignedDriverId = booking.driverId;
            cust.driverId = booking.driverId;
            cust.bookingConfirmed = true;
        }

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE bookings 
                    SET status = 'Confirmed' 
                    WHERE id = $1
                `, [booking.id || bookingId]);
            } catch (e) {
                console.error('[AdminController] PG accept booking error:', e);
            }
        }

        db.addAuditLog('BookingAccepted', 'Driver', booking.driverId || 'Admin', {
            bookingId: booking.id || bookingId,
            customerName: booking.customerName,
            status: 'Confirmed'
        });

        db.saveStateSnapshot();
        return { success: true, message: 'تمت موافقة السائق على الحجز وأصبح الزبون ضمن الركاب بنجاح! ✅', booking };
    }

    async declineBooking(bookingId, reason = null) {
        let booking = (db.memoryState.bookings || []).find(b => (b.id === bookingId || b.bookingId === bookingId));

        if (!booking && db.isPostgresConnected && db.pool) {
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
                        seatsBooked: r.seats_booked || 1,
                        status: r.status,
                        createdAt: r.created_at
                    };
                    db.memoryState.bookings.unshift(booking);
                }
            } catch (e) {
                console.error('[AdminController] PG fetch booking error:', e);
            }
        }

        if (!booking) {
            return { success: false, error: 'الحجز غير موجود' };
        }

        booking.status = 'Declined';
        booking.declinedAt = new Date().toISOString();
        if (reason) booking.declineReason = reason;

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

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE bookings 
                    SET status = 'Declined' 
                    WHERE id = $1
                `, [booking.id || bookingId]);
            } catch (e) {
                console.error('[AdminController] PG decline booking error:', e);
            }
        }

        db.addAuditLog('BookingDeclined', 'Driver', booking.driverId || 'Admin', {
            bookingId: booking.id || bookingId,
            customerName: booking.customerName,
            reason
        });

        db.saveStateSnapshot();
        return { success: true, message: 'تم رفض طلب الحجز.', booking };
    }

    async updateBookingStatus(bookingId, status, reason = null) {
        if (status === 'Confirmed' || status === 'Accepted') {
            return await this.acceptBooking(bookingId);
        } else if (status === 'Declined' || status === 'Rejected' || status === 'Cancelled') {
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

        if (!fullName || !phoneNumber || !password) {
            return { success: false, error: 'الاسم ورقم الهاتف وكلمة المرور مطلوبة.' };
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

        if (existingDriver || existingCust) {
            const roleAr = existingDriver ? 'سائق (كابتن)' : 'راكب';
            const name = (existingDriver || existingCust).fullName;
            return { success: false, duplicate: true, error: `الرقم مسجل بالفعل لدى ${roleAr}: ${name}. يرجى إدخال رقم هاتف آخر.` };
        }

        const crypto = require('crypto');
        const passwordHash = crypto.createHash('sha256').update(String(password)).digest('hex');
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

        const passStr = String(password).trim();
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
            serviceType: normalizedServiceType,
            work_mode: defaultWorkMode,
            workStatus: defaultWorkStatus,
            availableSeats: parseInt(availableSeats || (route && route.availableSeats) || 4, 10),
            totalSeats: parseInt(availableSeats || (route && route.availableSeats) || 4, 10),
            status: 'Approved',
            tripStatus: 'Online',
            isOnline: true,
            isVerified: true,
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
            route: (route && (route.startName || route.endName)) ? `${route.startName || 'نقطة الانطلاق'} ➔ ${route.endName || 'جامعة الكوفة'}` : 'النجف ➔ جامعة الكوفة',
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

                await db.pool.query(`
                    INSERT INTO drivers (driver_id, full_name, phone_number, email, password_hash, plain_password, license_number, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, status, is_verified, is_blocked, latitude, longitude, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Approved', true, false, $12, $13, $14)
                    ON CONFLICT (driver_id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, password_hash = EXCLUDED.password_hash, plain_password = EXCLUDED.plain_password
                `, [driverId, fullName, cleanPhone, cleanEmail, passwordHash, passStr, license, vMake, vModel, vYear, vPlate, startLat, startLon, now]);

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

        return {
            success: true,
            driver: newDriver,
            route: createdRoute,
            credentials: {
                username: cleanPhone,
                phoneNumber: cleanPhone,
                email: cleanEmail,
                password: password,
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

        // If both PG and memory are empty, provide realistic sample cancellation requests
        if (!db.memoryState.cancellationRequests || db.memoryState.cancellationRequests.length === 0) {
            const seedRequests = [
                {
                    id: 'cnl-req-101',
                    requestId: 'cnl-req-101',
                    bookingId: 'bk-u8qea4da1',
                    passengerName: 'فاطمة حيدر الحسيني',
                    customerName: 'فاطمة حيدر الحسيني',
                    passengerPhone: '07801234567',
                    customerPhone: '07801234567',
                    driverId: 'drv-veqjap6sb',
                    driverName: 'سائق١',
                    driverPhone: '07706204066',
                    routeId: 'route-kufa-1',
                    routeName: 'جامعة الكوفة ➔ حي الزهراء',
                    route: 'جامعة الكوفة ➔ حي الزهراء',
                    reasonCategory: 'تغيير وقت الدوام',
                    passengerReason: 'تغيير وقت الدوام',
                    reason: 'تغيير وقت الدوام',
                    userMessage: 'تم تعديل جدول المحاضرات الصباحية في الجامعة وأحتاج إلغاء المقعد لهذا الخط.',
                    passengerDetails: 'تم تعديل جدول المحاضرات الصباحية في الجامعة وأحتاج إلغاء المقعد لهذا الخط.',
                    driverDecision: 'pending',
                    driverApprovalReason: null,
                    status: 'Pending',
                    createdAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
                    resolvedAt: null
                },
                {
                    id: 'cnl-req-102',
                    requestId: 'cnl-req-102',
                    bookingId: 'bk-v4krgw3nt',
                    passengerName: 'كرار حسين الخفاجي',
                    customerName: 'كرار حسين الخفاجي',
                    passengerPhone: '07719876543',
                    customerPhone: '07719876543',
                    driverId: 'drv-veqjap6sb',
                    driverName: 'سائق١',
                    driverPhone: '07706204066',
                    routeId: 'route-kufa-1',
                    routeName: 'حي الجامعة ➔ الكوفة',
                    route: 'حي الجامعة ➔ الكوفة',
                    reasonCategory: 'ظروف خاصة',
                    passengerReason: 'ظروف خاصة',
                    reason: 'ظروف خاصة',
                    userMessage: 'انتقال مكان السكن إلى منطقة أخرى قريبة من العمل، شكراً لتعاونكم.',
                    passengerDetails: 'انتقال مكان السكن إلى منطقة أخرى قريبة من العمل، شكراً لتعاونكم.',
                    driverDecision: 'approved',
                    driverApprovalReason: 'تم الاتفاق مع الراكب وتحرير المقعد',
                    status: 'Approved',
                    createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
                    resolvedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString()
                },
                {
                    id: 'cnl-req-103',
                    requestId: 'cnl-req-103',
                    bookingId: 'bk-d57vrhaft',
                    passengerName: 'أحمد علي الفتلاوي',
                    customerName: 'أحمد علي الفتلاوي',
                    passengerPhone: '07503456789',
                    customerPhone: '07503456789',
                    driverId: 'drv-veqjap6sb',
                    driverName: 'سائق١',
                    driverPhone: '07706204066',
                    routeId: 'route-kufa-1',
                    routeName: 'حي السلام ➔ شارع المدينة',
                    route: 'حي السلام ➔ شارع المدينة',
                    reasonCategory: 'عدم الالتزام',
                    passengerReason: 'عدم الالتزام',
                    reason: 'عدم الالتزام',
                    userMessage: 'طلب إلغاء بالخطأ، تم الاتصال بالراكب وتأكيد استمراره بالخط.',
                    passengerDetails: 'طلب إلغاء بالخطأ، تم الاتصال بالراكب وتأكيد استمراره بالخط.',
                    driverDecision: 'rejected',
                    driverApprovalReason: 'تراجع الراكب عن الإلغاء واستمرار الحجز',
                    status: 'Rejected',
                    createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
                    resolvedAt: new Date(Date.now() - 20 * 3600 * 1000).toISOString()
                }
            ];

            db.memoryState.cancellationRequests = seedRequests;

            if (db.isPostgresConnected && db.pool) {
                for (const s of seedRequests) {
                    try {
                        await db.pool.query(`
                            INSERT INTO cancellation_requests (
                                id, booking_id, customer_name, customer_phone, passenger_name, passenger_phone,
                                driver_id, driver_name, driver_phone, route_name, reason_category, user_message,
                                passenger_reason, passenger_details, status, created_at, resolved_at
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                            ON CONFLICT (id) DO NOTHING
                        `, [
                            s.id, s.bookingId, s.customerName, s.customerPhone, s.passengerName, s.passengerPhone,
                            s.driverId, s.driverName, s.driverPhone, s.routeName, s.reasonCategory, s.userMessage,
                            s.passengerReason, s.passengerDetails, s.status, s.createdAt, s.resolvedAt
                        ]);
                    } catch (_) {}
                }
            }
        }

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

        return {
            success: true,
            message: 'تم رفض طلب الإلغاء واستمرار اشتراك الراكب ✕',
            request: req
        };
    }

    // 13. Route Cancellation Cycle: Customer Request Cancellation
    async requestRouteCancellation(data) {
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        const bookingId = data.bookingId;
        const candidateCustomerId = String(data.customerId || data.userId || '');
        const candidatePhone = String(data.customerPhone || data.phone || '').replace(/[^0-9]/g, '');
        const targetDriverId = String(data.driverId || '');

        let booking = (db.memoryState.bookings || []).find(b => {
            if (bookingId && (b.id === bookingId || b.bookingId === bookingId)) return true;
            const bCustId = String(b.customerId || b.passengerId || '');
            const bPhone = String(b.customerPhone || b.phone || '').replace(/[^0-9]/g, '');
            const isCust = (candidateCustomerId && bCustId === candidateCustomerId) || 
                           (candidatePhone.length >= 7 && bPhone.length >= 7 && bPhone.endsWith(candidatePhone.slice(-8)));
            const isDrv = targetDriverId && (b.driverId === targetDriverId || b.driverPhone === targetDriverId);
            return isCust && isDrv && b.status !== 'Cancelled';
        });

        // If not found in memory, query PostgreSQL
        if (!booking && db.isPostgresConnected && db.pool) {
            try {
                let pgRes = null;
                if (bookingId) {
                    pgRes = await db.pool.query('SELECT * FROM bookings WHERE id = $1 AND status != $2 LIMIT 1', [bookingId, 'Cancelled']);
                }
                if ((!pgRes || !pgRes.rows || pgRes.rows.length === 0) && (candidateCustomerId || candidatePhone)) {
                    pgRes = await db.pool.query(`
                        SELECT * FROM bookings 
                        WHERE (customer_id = $1 OR (customer_phone IS NOT NULL AND RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 8) = RIGHT($2, 8)))
                          AND (driver_id = $3 OR driver_id = $4 OR $3 = '' OR $3 IS NULL)
                          AND status != 'Cancelled'
                        ORDER BY created_at DESC LIMIT 1
                    `, [candidateCustomerId || '___', candidatePhone || '___', targetDriverId || '', targetDriverId || '']);
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
                console.error('[AdminController] PG find booking error:', pgErr.message);
            }
        }

        if (!booking) {
            return { success: false, error: 'لم يتم العثور على حجز نشط لهذا الراكب' };
        }

        const reason = data.reason || 'ظروف شخصية';
        const details = data.details || '';

        booking.status = 'cancellation_pending';
        booking.cancellationPending = true;
        booking.cancellationRequested = true;
        booking.cancellation_requested = true;
        booking.cancellationStatus = 'pending';
        booking.cancellation_status = 'pending';
        booking.cancellationReason = reason;
        booking.cancellation_reason = reason;
        booking.cancellationDetails = details;
        booking.cancellation_details = details;
        booking.cancellationRequestedAt = new Date().toISOString();

        const requestId = 'cnl-' + Math.random().toString(36).substr(2, 9);
        const newRequest = {
            id: requestId,
            requestId: requestId,
            bookingId: booking.id || booking.bookingId,
            driverId: booking.driverId || targetDriverId,
            driverName: booking.driverName || 'الكابتن',
            driverPhone: booking.driverPhone || '',
            customerId: booking.customerId || candidateCustomerId,
            customerName: booking.customerName || 'الراكب',
            customerPhone: booking.customerPhone || data.customerPhone || '',
            routeId: booking.routeId || '',
            route: booking.pickupLocation ? `${booking.pickupLocation} ➔ ${booking.dropoffLocation}` : (data.route || 'مسار الخط'),
            passengerReason: reason,
            passengerDetails: details,
            reason: reason,
            driverDecision: 'pending',
            driverApprovalReason: null,
            status: 'Pending',
            createdAt: new Date().toISOString()
        };

        const existIdx = db.memoryState.cancellationRequests.findIndex(r => r.bookingId === newRequest.bookingId && r.status === 'Pending');
        if (existIdx >= 0) {
            db.memoryState.cancellationRequests[existIdx] = newRequest;
        } else {
            db.memoryState.cancellationRequests.unshift(newRequest);
        }

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE bookings 
                    SET status = 'cancellation_pending', 
                        cancellation_requested = true,
                        cancellation_status = 'pending',
                        cancellation_reason = $1,
                        cancellation_details = $2,
                        updated_at = NOW() 
                    WHERE id = $3
                `, [reason, details, booking.id || booking.bookingId]);

                await db.pool.query(`
                    INSERT INTO cancellation_requests (id, booking_id, customer_id, customer_name, customer_phone, driver_id, driver_name, driver_phone, route_id, route_name, passenger_reason, passenger_details, driver_decision, status, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', 'Pending', NOW())
                    ON CONFLICT (id) DO UPDATE SET passenger_reason = EXCLUDED.passenger_reason, passenger_details = EXCLUDED.passenger_details, status = 'Pending'
                `, [requestId, booking.id || booking.bookingId, newRequest.customerId, newRequest.customerName, newRequest.customerPhone, newRequest.driverId, newRequest.driverName, newRequest.driverPhone, newRequest.routeId, newRequest.route, reason, details]);
            } catch (pgErr) {
                console.error('[AdminController] PG requestRouteCancellation error:', pgErr.message);
                try {
                    await db.pool.query(`
                        UPDATE bookings 
                        SET status = 'cancellation_pending', 
                            cancellation_requested = true,
                            cancellation_status = 'pending',
                            cancellation_reason = $1,
                            cancellation_details = $2
                        WHERE id = $3
                    `, [reason, details, booking.id || booking.bookingId]);
                } catch (fallbackErr) {
                    console.error('[AdminController] PG fallback update error:', fallbackErr.message);
                }
            }
        }

        db.saveStateSnapshot();
        return {
            success: true,
            message: 'تم إرسال طلب الإلغاء للسائق للمراجعة',
            request: newRequest
        };
    }

    // 14. Route Cancellation Cycle: Driver Respond (Approve / Reject)
    async respondRouteCancellation(data) {
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        const bookingId = data.bookingId;
        const action = data.action; // 'approve' | 'reject'
        const driverApprovalReason = data.driverApprovalReason || (action === 'approve' ? 'تم التراضي مع الراكب' : 'رفض الكابتن');

        let booking = (db.memoryState.bookings || []).find(b => b.id === bookingId || b.bookingId === bookingId);
        if (!booking && db.isPostgresConnected && db.pool) {
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

        if (!booking) {
            return { success: false, error: 'الحجز غير موجود' };
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
}

module.exports = new AdminController();
