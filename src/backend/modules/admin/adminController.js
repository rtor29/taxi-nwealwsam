const db = require('../../db');
const backupService = require('../backup/backupService');

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
                password: d.plainPassword || (d.passwordHash ? '••••••••' : '123456')
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
                        isBlocked: row.is_blocked
                    };
                    db.memoryState.drivers.unshift(driver);
                }
            } catch (_) {}
        }
        if (!driver) return { success: false, error: 'السائق غير موجود' };

        if (data.fullName !== undefined) driver.fullName = String(data.fullName).trim();
        if (data.phoneNumber !== undefined) driver.phoneNumber = String(data.phoneNumber).trim();
        if (data.governorate !== undefined) driver.governorate = String(data.governorate).trim();
        if (data.permanentLat !== undefined && data.permanentLat !== null && data.permanentLat !== '') driver.permanentLat = parseFloat(data.permanentLat);
        if (data.permanentLon !== undefined && data.permanentLon !== null && data.permanentLon !== '') driver.permanentLon = parseFloat(data.permanentLon);
        if (data.permanentLocationName !== undefined) driver.permanentLocationName = String(data.permanentLocationName).trim();
        if (data.permanentDropoffLat !== undefined && data.permanentDropoffLat !== null && data.permanentDropoffLat !== '') driver.permanentDropoffLat = parseFloat(data.permanentDropoffLat);
        if (data.permanentDropoffLon !== undefined && data.permanentDropoffLon !== null && data.permanentDropoffLon !== '') driver.permanentDropoffLon = parseFloat(data.permanentDropoffLon);
        if (data.permanentDropoffName !== undefined) driver.permanentDropoffName = String(data.permanentDropoffName).trim();
        if (data.route !== undefined) {
            driver.route = String(data.route).trim();
            let r = db.memoryState.routes.find(rt => rt.driverId === driverId);
            if (r) {
                r.name = driver.route;
                r.startName = driver.route.split('-')[0]?.trim() || driver.route;
                r.endName = driver.route.split('-')[1]?.trim() || driver.route;
            } else {
                db.memoryState.routes.push({
                    id: 'route-' + driverId,
                    routeId: 'route-' + driverId,
                    driverId: driverId,
                    driverName: driver.fullName,
                    driverPhone: driver.phoneNumber,
                    name: driver.route,
                    startName: driver.route.split('-')[0]?.trim() || driver.route,
                    endName: driver.route.split('-')[1]?.trim() || driver.route,
                    status: 'Active',
                    createdAt: new Date().toISOString()
                });
            }
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
                    SET full_name = $1, phone_number = $2, password_hash = COALESCE($3, password_hash), plain_password = COALESCE($4, plain_password), updated_at = NOW()
                    WHERE driver_id = $5
                `, [driver.fullName, driver.phoneNumber, driver.passwordHash || null, driver.plainPassword || null, driverId]);

                await db.pool.query(`
                    UPDATE users 
                    SET full_name = $1, phone_number = $2, password_hash = COALESCE($3, password_hash), plain_password = COALESCE($4, plain_password), updated_at = NOW()
                    WHERE id = $5
                `, [driver.fullName, driver.phoneNumber, driver.passwordHash || null, driver.plainPassword || null, driverId]);
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
        if (driver.permanentLat && driver.permanentLon) {
            db.persistDriverPermanentLocation(driverId, {
                lat: driver.permanentLat, lon: driver.permanentLon, locationName: driver.permanentLocationName,
                dropoffLat: driver.permanentDropoffLat, dropoffLon: driver.permanentDropoffLon, dropoffName: driver.permanentDropoffName
            }).catch(()=>{});
        }

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

    // 7. Complaints
    async getComplaints() {
        return {
            success: true,
            total: db.memoryState.complaints.length,
            complaints: db.memoryState.complaints
        };
    }

    async updateComplaint(complaintId, status, resolutionNotes = null) {
        const complaint = db.memoryState.complaints.find(c => c.id === complaintId);
        if (!complaint) return { success: false, error: 'الشكوى غير موجودة' };

        complaint.status = status;
        if (resolutionNotes) complaint.resolutionNotes = resolutionNotes;

        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE complaints SET status = $1, resolution_notes = $2, updated_at = NOW() WHERE id = $3
                `, [status, resolutionNotes, complaintId]);
            } catch (e) {}
        }

        db.saveStateSnapshot();
        return { success: true, complaint };
    }

    // 8. Settings
    async getSettings() {
        return {
            success: true,
            settings: db.memoryState.settings
        };
    }

    async updateSetting(key, valueJson) {
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
        return { success: true, setting };
    }

    // 9. Audit Logs
    async getAuditLogs() {
        return {
            success: true,
            total: db.memoryState.auditLogs.length,
            logs: db.memoryState.auditLogs
        };
    }

    // 10. Backup & Restore
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
            serviceType: serviceType || 'both',
            status: 'Approved',
            isVerified: true,
            isBlocked: false,
            ratingAverage: 5.0,
            totalTrips: 0,
            latitude: startLat,
            longitude: startLon,
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
        return {
            success: true,
            total: (db.memoryState.cancellationRequests || []).length,
            requests: db.memoryState.cancellationRequests || []
        };
    }

    async approveCancellation(requestId) {
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        const req = db.memoryState.cancellationRequests.find(r => r.id === requestId || r.requestId === requestId);
        if (!req) return { success: false, error: 'طلب الإلغاء غير موجود' };

        req.status = 'Approved';
        req.approvedAt = new Date().toISOString();

        // 1. Unlink & cancel booking
        const booking = (db.memoryState.bookings || []).find(b => b.id === req.bookingId || b.bookingId === req.bookingId);
        if (booking) {
            booking.status = 'Cancelled';
            booking.cancellationPending = false;
            booking.cancelledAt = new Date().toISOString();

            // 2. Free seat(s) on target route
            const targetRoute = (db.memoryState.routes || []).find(r => (r.id === booking.routeId || r.routeId === booking.routeId));
            if (targetRoute) {
                const totalCap = targetRoute.totalSeats || 4;
                const freedSeats = parseInt(booking.seatsBooked || req.seats || 1, 10);
                targetRoute.availableSeats = Math.min(totalCap, (targetRoute.availableSeats || 0) + freedSeats);
            }

            // 3. Unlink passenger from driver
            const cust = (db.memoryState.customers || []).find(c => c.customerId === booking.customerId || c.phoneNumber === booking.customerPhone);
            if (cust) {
                cust.assignedDriverId = null;
                cust.driverId = null;
                cust.bookingConfirmed = false;
            }

            // 4. Update in PostgreSQL if connected
            if (db.isPostgresConnected && db.pool) {
                try {
                    await db.pool.query(`UPDATE bookings SET status = 'Cancelled' WHERE id = $1`, [booking.id || req.bookingId]);
                    if (targetRoute) {
                        await db.pool.query(`UPDATE routes SET available_seats = $1 WHERE id = $2`, [targetRoute.availableSeats, targetRoute.id]);
                    }
                } catch (pgErr) {
                    console.error('[AdminController] PG cancel error:', pgErr);
                }
            }
        }

        db.addAuditLog('PassengerCancellationApproved', 'Admin', 'usr-admin', {
            requestId,
            bookingId: req.bookingId,
            driverName: req.driverName,
            customerName: req.customerName
        });

        db.saveStateSnapshot();

        return {
            success: true,
            message: 'تمت الموافقة على إلغاء الراكب وفك ارتباطه وإعادة إتاحة المقعد فوراً ✅',
            request: req
        };
    }

    async rejectCancellation(requestId) {
        db.memoryState.cancellationRequests = db.memoryState.cancellationRequests || [];
        const req = db.memoryState.cancellationRequests.find(r => r.id === requestId || r.requestId === requestId);
        if (!req) return { success: false, error: 'طلب الإلغاء غير موجود' };

        req.status = 'Rejected';
        req.rejectedAt = new Date().toISOString();

        const booking = (db.memoryState.bookings || []).find(b => b.id === req.bookingId || b.bookingId === req.bookingId);
        if (booking) {
            booking.cancellationPending = false;
        }

        db.saveStateSnapshot();

        return {
            success: true,
            message: 'تم رفض طلب الإلغاء واستمرار اشتراك الراكب',
            request: req
        };
    }
}

module.exports = new AdminController();
