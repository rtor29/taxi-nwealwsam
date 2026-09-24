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
        if (!driver) return { success: false, error: 'السائق غير موجود' };

        if (data.fullName !== undefined) driver.fullName = String(data.fullName).trim();
        if (data.phoneNumber !== undefined) driver.phoneNumber = String(data.phoneNumber).trim();
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
                    SET full_name = $1, phone_number = $2
                    WHERE driver_id = $3
                `, [driver.fullName, driver.phoneNumber, driverId]);

                await db.pool.query(`
                    UPDATE users 
                    SET full_name = $1, phone_number = $2
                    WHERE id = $3
                `, [driver.fullName, driver.phoneNumber, driverId]);
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

    async toggleDriverBlock(driverId, isBlocked) {
        const driver = db.memoryState.drivers.find(d => d.driverId === driverId);
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
                    UPDATE users SET is_blocked = $1 WHERE id = $2
                `, [driver.isBlocked, driverId]);
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

    async updateCustomer(customerId, data) {
        let customer = db.memoryState.customers.find(c => c.customerId === customerId);
        if (!customer) return { success: false, error: 'الراكب غير موجود' };

        if (data.fullName !== undefined) customer.fullName = String(data.fullName).trim();
        if (data.phoneNumber !== undefined) customer.phoneNumber = String(data.phoneNumber).trim();
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

        return { success: true, customer };
    }

    async toggleCustomerBlock(customerId, isBlocked) {
        const customer = db.memoryState.customers.find(c => c.customerId === customerId);
        if (!customer) return { success: false, error: 'الراكب غير موجود' };

        customer.isBlocked = !!isBlocked;
        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE customers SET is_blocked = $1 WHERE customer_id = $2
                `, [customer.isBlocked, customerId]);
                await db.pool.query(`
                    UPDATE users SET is_blocked = $1 WHERE id = $2
                `, [customer.isBlocked, customerId]);
            } catch (e) {
                console.error('[AdminController] toggleCustomerBlock PG error:', e);
            }
        }

        db.addAuditLog(isBlocked ? 'CustomerBlocked' : 'CustomerUnblocked', 'Customer', customerId, { isBlocked });
        db.saveStateSnapshot();
        return { success: true, isBlocked: customer.isBlocked };
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

        const newDriver = {
            driverId,
            fullName,
            email: cleanEmail,
            phoneNumber: cleanPhone,
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
                    INSERT INTO users (id, phone_number, email, full_name, role, password_hash, is_active, is_blocked, created_at)
                    VALUES ($1, $2, $3, $4, 'Driver', $5, true, false, $6)
                    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number, password_hash = EXCLUDED.password_hash
                `, [driverId, cleanPhone, cleanEmail, fullName, passwordHash, now]);

                await db.pool.query(`
                    INSERT INTO drivers (driver_id, full_name, phone_number, email, password_hash, license_number, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, status, is_verified, is_blocked, latitude, longitude, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Approved', true, false, $11, $12, $13)
                    ON CONFLICT (driver_id) DO NOTHING
                `, [driverId, fullName, cleanPhone, cleanEmail, passwordHash, license, vMake, vModel, vYear, vPlate, startLat, startLon, now]);

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
}

module.exports = new AdminController();
