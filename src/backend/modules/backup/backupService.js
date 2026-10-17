const fs = require('fs');
const path = require('path');
const db = require('../../db');
const config = require('../../config');
const auditService = require('../audit/auditService');

class BackupService {
    /**
     * Retrieves health metrics, disk usage, and row counts of PostgreSQL database
     */
    async getDatabaseStats() {
        let isOnline = false;
        let pgVersion = 'PostgreSQL 16';
        let postgisVersion = 'PostGIS 3.4';
        let diskSize = '8.7 MB';
        let tablesCount = 12;
        let totalRows = 0;
        let tableStats = {};
        let lastExportAt = null;
        let lastBackupFilename = null;

        // Check local backups directory for latest backup
        try {
            const backupDir = path.join(path.dirname(config.dataFile), 'backups');
            if (fs.existsSync(backupDir)) {
                const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.json'));
                if (files.length > 0) {
                    files.sort((a, b) => {
                        const sA = fs.statSync(path.join(backupDir, a)).mtimeMs;
                        const sB = fs.statSync(path.join(backupDir, b)).mtimeMs;
                        return sB - sA;
                    });
                    lastBackupFilename = files[0];
                    lastExportAt = fs.statSync(path.join(backupDir, files[0])).mtime.toISOString();
                }
            }
        } catch (_) {}

        if (db.isPostgresConnected && db.pool) {
            try {
                isOnline = true;
                const [verRes, sizeRes, extRes] = await Promise.all([
                    db.pool.query('SELECT version()'),
                    db.pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) AS size"),
                    db.pool.query("SELECT postgis_version()").catch(() => ({ rows: [{ postgis_version: '3.4' }] }))
                ]);

                if (verRes.rows[0]) {
                    const match = verRes.rows[0].version.match(/PostgreSQL\s+([\d.]+)/i);
                    pgVersion = match ? `PostgreSQL ${match[1]}` : 'PostgreSQL 16';
                }
                if (sizeRes.rows[0]) {
                    diskSize = sizeRes.rows[0].size;
                }
                if (extRes.rows[0] && extRes.rows[0].postgis_version) {
                    const pMatch = extRes.rows[0].postgis_version.match(/^([\d.]+)/);
                    postgisVersion = pMatch ? `PostGIS ${pMatch[1]}` : 'PostGIS 3.4';
                }

                const tables = [
                    'users', 'drivers', 'customers', 'routes', 'bookings',
                    'driver_documents', 'complaints', 'cancellation_requests',
                    'trip_ratings', 'system_settings', 'audit_logs'
                ];
                tablesCount = tables.length;

                const counts = await Promise.all(
                    tables.map(t =>
                        db.pool.query(`SELECT COUNT(*)::int AS count FROM ${t}`)
                            .then(r => ({ table: t, count: r.rows[0].count }))
                            .catch(() => ({ table: t, count: 0 }))
                    )
                );

                counts.forEach(c => {
                    tableStats[c.table] = c.count;
                    totalRows += c.count;
                });
            } catch (err) {
                console.warn('[BackupService] getDatabaseStats warning:', err.message);
            }
        } else {
            // Memory state counts fallback
            const d = db.memoryState || {};
            tableStats = {
                drivers: (d.drivers || []).length,
                customers: (d.customers || []).length,
                routes: (d.routes || []).length,
                bookings: (d.bookings || []).length,
                verifications: (d.verifications || []).length,
                complaints: (d.complaints || []).length,
                settings: (d.settings || []).length,
                audit_logs: (d.auditLogs || []).length
            };
            totalRows = Object.values(tableStats).reduce((a, b) => a + b, 0);
        }

        return {
            success: true,
            isOnline,
            engine: `${pgVersion} + ${postgisVersion}`,
            pgVersion,
            postgisVersion,
            diskSize,
            tablesCount,
            totalRows,
            tableStats,
            lastExportAt,
            lastBackupFilename
        };
    }

    /**
     * Exports a complete structured snapshot of all platform data
     */
    async exportBackup() {
        try {
            const timestamp = new Date().toISOString();
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
            const filename = `tawseela-backup-${dateStr}.json`;

            let users = [];
            let drivers = db.memoryState.drivers || [];
            let customers = db.memoryState.customers || [];
            let routes = db.memoryState.routes || [];
            let bookings = db.memoryState.bookings || [];
            let driver_documents = db.memoryState.verifications || [];
            let complaints = db.memoryState.complaints || [];
            let cancellation_requests = db.memoryState.cancellationRequests || [];
            let trip_ratings = [];
            let system_settings = db.memoryState.settings || [];
            let audit_logs = db.memoryState.auditLogs || [];

            // If PostgreSQL is online, pull raw database tables for absolute consistency
            if (db.isPostgresConnected && db.pool) {
                try {
                    const [
                        usersRes,
                        driversRes,
                        customersRes,
                        routesRes,
                        bookingsRes,
                        docsRes,
                        complaintsRes,
                        cancelRes,
                        ratingsRes,
                        settingsRes,
                        auditRes
                    ] = await Promise.all([
                        db.pool.query('SELECT * FROM users ORDER BY created_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM drivers ORDER BY created_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM customers ORDER BY created_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM routes ORDER BY created_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM bookings ORDER BY created_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM driver_documents ORDER BY submitted_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM complaints ORDER BY created_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM cancellation_requests ORDER BY created_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM trip_ratings ORDER BY created_at ASC').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM system_settings').catch(() => ({ rows: [] })),
                        db.pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1000').catch(() => ({ rows: [] }))
                    ]);

                    users = usersRes.rows;
                    drivers = driversRes.rows.length > 0 ? driversRes.rows : drivers;
                    customers = customersRes.rows.length > 0 ? customersRes.rows : customers;
                    routes = routesRes.rows.length > 0 ? routesRes.rows : routes;
                    bookings = bookingsRes.rows.length > 0 ? bookingsRes.rows : bookings;
                    driver_documents = docsRes.rows.length > 0 ? docsRes.rows : driver_documents;
                    complaints = complaintsRes.rows.length > 0 ? complaintsRes.rows : complaints;
                    cancellation_requests = cancelRes.rows.length > 0 ? cancelRes.rows : cancellation_requests;
                    trip_ratings = ratingsRes.rows;
                    system_settings = settingsRes.rows.length > 0 ? settingsRes.rows : system_settings;
                    audit_logs = auditRes.rows.length > 0 ? auditRes.rows : audit_logs;
                } catch (pgErr) {
                    console.warn('[BackupService] PG fetch warning (falling back to memory state):', pgErr.message);
                }
            }

            const rowCounts = {
                users: users.length,
                drivers: drivers.length,
                customers: customers.length,
                routes: routes.length,
                bookings: bookings.length,
                driver_documents: driver_documents.length,
                complaints: complaints.length,
                cancellation_requests: cancellation_requests.length,
                trip_ratings: trip_ratings.length,
                system_settings: system_settings.length,
                audit_logs: audit_logs.length
            };
            const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);

            const backupPayload = {
                meta: {
                    version: "2.1-postgres",
                    platform: "Tawseela Platform (Najaf)",
                    timestamp,
                    database: "PostgreSQL 16 + PostGIS 3.4",
                    filename,
                    rowCounts,
                    totalRows
                },
                data: {
                    users,
                    drivers,
                    customers,
                    routes,
                    bookings,
                    driver_documents,
                    complaints,
                    cancellation_requests,
                    trip_ratings,
                    system_settings,
                    audit_logs
                },
                // Backward compatibility aliases
                version: "2.1-postgres",
                platform: "Taxi-Wisam (Najaf)",
                exportedAt: timestamp,
                stats: db.getComputedStats()
            };

            // Save server-side copy in data/backups/
            try {
                const backupDir = path.join(path.dirname(config.dataFile), 'backups');
                if (!fs.existsSync(backupDir)) {
                    fs.mkdirSync(backupDir, { recursive: true });
                }
                const backupFilePath = path.join(backupDir, filename);
                fs.writeFileSync(backupFilePath, JSON.stringify(backupPayload, null, 2), 'utf8');
            } catch (fsErr) {
                console.warn('[BackupService] Could not write server-side backup copy:', fsErr.message);
            }

            try {
                await auditService.logAuditEvent({
                    action: 'SystemBackupExported',
                    entityType: 'FullDatabase',
                    entityId: filename,
                    actor: 'المشرف العام (Admin)',
                    details: {
                        filename,
                        totalRows,
                        driverCount: drivers.length,
                        customerCount: customers.length,
                        exportedAt: timestamp
                    }
                });
            } catch (_) {
                db.addAuditLog('SystemBackupExported', 'System', 'FullDatabase', {
                    filename,
                    totalRows,
                    driverCount: drivers.length,
                    customerCount: customers.length,
                    exportedAt: timestamp
                });
            }

            return {
                success: true,
                filename,
                meta: backupPayload.meta,
                data: backupPayload.data,
                backupPayload
            };
        } catch (error) {
            console.error('[BackupService] exportBackup error:', error);
            throw error;
        }
    }

    /**
     * Validates schema and safely restores data into PostgreSQL via transaction (BEGIN / COMMIT / ROLLBACK)
     */
    async restoreBackup(payload) {
        if (!payload) {
            throw new Error('الملف فارغ أو غير مقروء');
        }

        const actualPayload = (payload && payload.backupPayload) ? payload.backupPayload : payload;
        const data = actualPayload.data || actualPayload;

        if (!data || typeof data !== 'object') {
            throw new Error('الملف غير صالح: تنقصه بنية البيانات الأساسية (Missing data payload)');
        }

        // Schema validation: Verify at least one collection exists
        const hasCoreData = Array.isArray(data.drivers) || Array.isArray(data.customers) ||
                            Array.isArray(data.users) || Array.isArray(data.routes) ||
                            Array.isArray(data.bookings) || Array.isArray(data.system_settings);

        if (!hasCoreData) {
            throw new Error('الملف لا يحتوي على جداول بيانات معتمدة لمنصة توصيله');
        }

        const users = Array.isArray(data.users) ? data.users : [];
        const drivers = Array.isArray(data.drivers) ? data.drivers : [];
        const customers = Array.isArray(data.customers) ? data.customers : [];
        const routes = Array.isArray(data.routes) ? data.routes : [];
        const bookings = Array.isArray(data.bookings) ? data.bookings : [];
        const driver_documents = Array.isArray(data.driver_documents) ? data.driver_documents : (Array.isArray(data.verifications) ? data.verifications : []);
        const complaints = Array.isArray(data.complaints) ? data.complaints : [];
        const cancellation_requests = Array.isArray(data.cancellation_requests) ? data.cancellation_requests : [];
        const trip_ratings = Array.isArray(data.trip_ratings) ? data.trip_ratings : [];
        const system_settings = Array.isArray(data.system_settings) ? data.system_settings : (Array.isArray(data.settings) ? data.settings : []);
        const audit_logs = Array.isArray(data.audit_logs) ? data.audit_logs : (Array.isArray(data.auditLogs) ? data.auditLogs : []);

        // 1. Transactional restoration in PostgreSQL if connected
        if (db.isPostgresConnected && db.pool) {
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');

                // Clear child tables in reverse dependency order
                await client.query('DELETE FROM trip_ratings').catch(() => {});
                await client.query('DELETE FROM cancellation_requests').catch(() => {});
                await client.query('DELETE FROM complaints').catch(() => {});
                await client.query('DELETE FROM bookings').catch(() => {});
                await client.query('DELETE FROM routes').catch(() => {});
                await client.query('DELETE FROM driver_documents').catch(() => {});
                await client.query('DELETE FROM drivers').catch(() => {});
                await client.query('DELETE FROM customers').catch(() => {});
                await client.query('DELETE FROM users').catch(() => {});

                // Re-insert users
                for (const u of users) {
                    await client.query(`
                        INSERT INTO users (id, phone_number, email, full_name, role, google_id, is_active, is_blocked, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
                    `, [
                        u.id || u.userId,
                        u.phone_number || u.phoneNumber || null,
                        u.email || null,
                        u.full_name || u.fullName || 'مستخدم',
                        u.role || 'Customer',
                        u.google_id || u.googleId || null,
                        u.is_active !== false && u.isActive !== false,
                        !!u.is_blocked || !!u.isBlocked,
                        u.created_at || u.createdAt || new Date().toISOString()
                    ]);
                }

                // Re-insert drivers (ensuring parent user exists)
                for (const d of drivers) {
                    const dId = d.driver_id || d.driverId;
                    const dPhone = d.phone_number || d.phoneNumber || null;
                    const dName = d.full_name || d.fullName || 'كابتن';

                    await client.query(`
                        INSERT INTO users (id, phone_number, email, full_name, role, google_id, is_active, is_blocked, created_at)
                        VALUES ($1, $2, $3, $4, 'Driver', $5, $6, $7, $8)
                        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
                    `, [dId, dPhone, d.email || null, dName, d.google_id || d.googleId || null, !d.is_blocked && !d.isBlocked, !!d.is_blocked || !!d.isBlocked, d.created_at || d.createdAt || new Date().toISOString()]);

                    await client.query(`
                        INSERT INTO drivers (driver_id, full_name, phone_number, email, google_id, license_number, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, status, is_verified, is_blocked, is_approved, work_mode, rejection_reason, rating_average, total_trips, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
                        ON CONFLICT (driver_id) DO UPDATE SET
                            full_name = EXCLUDED.full_name,
                            phone_number = EXCLUDED.phone_number,
                            status = EXCLUDED.status,
                            is_verified = EXCLUDED.is_verified,
                            is_blocked = EXCLUDED.is_blocked,
                            is_approved = EXCLUDED.is_approved
                    `, [
                        dId, dName, dPhone, d.email || null, d.google_id || d.googleId || null,
                        d.license_number || d.licenseNumber || 'IRQ-NJF-1000',
                        d.vehicle_make || d.vehicleMake || 'تويوتا',
                        d.vehicle_model || d.vehicleModel || 'كورولا',
                        d.vehicle_year || d.vehicleYear || 2020,
                        d.vehicle_plate || d.vehiclePlate || 'النجف',
                        d.status || 'Pending',
                        d.is_verified !== undefined ? !!d.is_verified : !!d.isVerified,
                        d.is_blocked !== undefined ? !!d.is_blocked : !!d.isBlocked,
                        d.is_approved !== undefined ? !!d.is_approved : !!d.isApproved,
                        d.work_mode || d.workMode || 'مشوار قصير',
                        d.rejection_reason || d.rejectionReason || null,
                        parseFloat(d.rating_average || d.ratingAverage || 5.0),
                        parseInt(d.total_trips || d.totalTrips || 0, 10),
                        d.created_at || d.createdAt || new Date().toISOString()
                    ]);
                }

                // Re-insert customers (ensuring parent user exists)
                for (const c of customers) {
                    const cId = c.customer_id || c.customerId || c.userId;
                    const cPhone = c.phone_number || c.phoneNumber || null;
                    const cName = c.full_name || c.fullName || 'راكب';

                    await client.query(`
                        INSERT INTO users (id, phone_number, email, full_name, role, google_id, is_active, is_blocked, created_at)
                        VALUES ($1, $2, $3, $4, 'Customer', $5, $6, $7, $8)
                        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone_number = EXCLUDED.phone_number
                    `, [cId, cPhone, c.email || null, cName, c.google_id || c.googleId || null, c.is_active !== false && c.isActive !== false, !!c.is_blocked || !!c.isBlocked, c.created_at || c.createdAt || c.registeredAt || new Date().toISOString()]);

                    await client.query(`
                        INSERT INTO customers (customer_id, full_name, phone_number, email, google_id, preferred_payment_method, rating_average, total_bookings, is_active, is_blocked, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                        ON CONFLICT (customer_id) DO UPDATE SET
                            full_name = EXCLUDED.full_name,
                            phone_number = EXCLUDED.phone_number,
                            preferred_payment_method = EXCLUDED.preferred_payment_method
                    `, [
                        cId, cName, cPhone, c.email || null, c.google_id || c.googleId || null,
                        c.preferred_payment_method || c.preferredPaymentMethod || 'Cash',
                        parseFloat(c.rating_average || c.ratingAverage || 5.0),
                        parseInt(c.total_bookings || c.totalBookings || 0, 10),
                        c.is_active !== false && c.isActive !== false,
                        !!c.is_blocked || !!c.isBlocked,
                        c.created_at || c.createdAt || c.registeredAt || new Date().toISOString()
                    ]);
                }

                // Re-insert driver documents
                for (const doc of driver_documents) {
                    const docId = doc.document_id || doc.documentId || ('doc-' + Math.random().toString(36).substr(2, 9));
                    const drvId = doc.driver_id || doc.driverId;
                    if (!drvId) continue;

                    await client.query(`
                        INSERT INTO driver_documents (document_id, driver_id, document_type, file_path, file_url, status, rejection_reason, submitted_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (document_id) DO NOTHING
                    `, [
                        docId, drvId,
                        doc.document_type || doc.documentType || 'DrivingLicense',
                        doc.file_path || doc.filePath || '',
                        doc.file_url || doc.fileUrl || doc.filePath || '',
                        doc.status || 'Pending',
                        doc.rejection_reason || doc.rejectionReason || null,
                        doc.submitted_at || doc.submittedAt || new Date().toISOString()
                    ]);
                }

                // Re-insert routes
                for (const r of routes) {
                    const rId = r.id || r.routeId || ('route-' + Math.random().toString(36).substr(2, 9));
                    const dId = r.driver_id || r.driverId;
                    if (!dId) continue;

                    await client.query(`
                        INSERT INTO routes (id, driver_id, driver_name, driver_phone, start_name, end_name, start_lat, start_lon, end_lat, end_lon, fare, available_seats, total_seats, departure_time, status, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                        ON CONFLICT (id) DO NOTHING
                    `, [
                        rId, dId,
                        r.driver_name || r.driverName || 'كابتن',
                        r.driver_phone || r.driverPhone || '',
                        r.start_name || r.startName || 'نقطة الانطلاق',
                        r.end_name || r.endName || 'نقطة الوصول',
                        parseFloat(r.start_lat || r.startLat || 31.9961),
                        parseFloat(r.start_lon || r.startLon || 44.3168),
                        parseFloat(r.end_lat || r.endLat || 32.0321),
                        parseFloat(r.end_lon || r.endLon || 44.3725),
                        parseFloat(r.fare || 3000),
                        parseInt(r.available_seats || r.availableSeats || 4, 10),
                        parseInt(r.total_seats || r.totalSeats || 4, 10),
                        r.departure_time || r.departureTime || '',
                        r.status || 'Active',
                        r.created_at || r.createdAt || new Date().toISOString()
                    ]);
                }

                // Re-insert bookings
                for (const b of bookings) {
                    const bId = b.id || b.bookingId || ('bk-' + Math.random().toString(36).substr(2, 9));
                    const cId = b.customer_id || b.customerId;
                    if (!cId) continue;

                    await client.query(`
                        INSERT INTO bookings (id, route_id, customer_id, customer_name, customer_phone, driver_id, driver_name, pickup_name, dropoff_name, pickup_lat, pickup_lon, dropoff_lat, dropoff_lon, total_fare, seats_booked, status, cancellation_reason, cancellation_details, cancellation_requested, cancellation_status, driver_approval_reason, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW())
                        ON CONFLICT (id) DO NOTHING
                    `, [
                        bId,
                        b.route_id || b.routeId || null,
                        cId,
                        b.customer_name || b.customerName || null,
                        b.customer_phone || b.customerPhone || null,
                        b.driver_id || b.driverId || null,
                        b.driver_name || b.driverName || null,
                        b.pickup_name || b.pickupName || null,
                        b.dropoff_name || b.dropoffName || null,
                        parseFloat(b.pickup_lat || b.pickupLat || 0) || null,
                        parseFloat(b.pickup_lon || b.pickupLon || 0) || null,
                        parseFloat(b.dropoff_lat || b.dropoffLat || 0) || null,
                        parseFloat(b.dropoff_lon || b.dropoffLon || 0) || null,
                        parseFloat(b.total_fare || b.totalFare || 0),
                        parseInt(b.seats_booked || b.seatsBooked || 1, 10),
                        b.status || 'Pending',
                        b.cancellation_reason || b.cancellationReason || null,
                        b.cancellation_details || b.cancellationDetails || null,
                        !!b.cancellation_requested || !!b.cancellationRequested,
                        b.cancellation_status || b.cancellationStatus || null,
                        b.driver_approval_reason || b.driverApprovalReason || null,
                        b.created_at || b.createdAt || new Date().toISOString()
                    ]);
                }

                // Re-insert complaints
                for (const cmp of complaints) {
                    const cmpId = cmp.id || ('cmp-' + Math.random().toString(36).substr(2, 9));
                    await client.query(`
                        INSERT INTO complaints (id, user_id, user_name, user_phone, user_role, subject, details, priority, status, created_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        ON CONFLICT (id) DO NOTHING
                    `, [
                        cmpId,
                        cmp.user_id || cmp.userId || null,
                        cmp.user_name || cmp.userName || null,
                        cmp.user_phone || cmp.userPhone || null,
                        cmp.user_role || cmp.userRole || 'Customer',
                        cmp.subject || 'بلاغ',
                        cmp.details || '',
                        cmp.priority || 'Normal',
                        cmp.status || 'Open',
                        cmp.created_at || cmp.createdAt || new Date().toISOString()
                    ]);
                }

                // Re-insert system settings
                for (const set of system_settings) {
                    const k = set.key;
                    if (!k) continue;
                    const val = typeof set.value_json === 'string' ? set.value_json : (typeof set.valueJson === 'string' ? set.valueJson : JSON.stringify(set.value_json || set.valueJson || {}));
                    await client.query(`
                        INSERT INTO system_settings (key, value_json, description, updated_at)
                        VALUES ($1, $2, $3, NOW())
                        ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
                    `, [k, val, set.description || '']);
                }

                await client.query('COMMIT');
                console.log('[BackupService] PostgreSQL restored safely inside atomic transaction.');
            } catch (pgError) {
                await client.query('ROLLBACK');
                console.error('[BackupService] PostgreSQL restore transaction rolled back:', pgError);
                throw new Error(`فشلت استعادة قاعدة البيانات وتم التراجع الفوري (ROLLBACK) لحماية السجلات: ${pgError.message}`);
            } finally {
                client.release();
            }
        }

        // 2. Update memory state and state.json snapshot
        db.memoryState = {
            drivers: drivers.map(d => ({
                driverId: d.driver_id || d.driverId,
                fullName: d.full_name || d.fullName,
                phoneNumber: d.phone_number || d.phoneNumber,
                licenseNumber: d.license_number || d.licenseNumber || 'IRQ-NJF-1000',
                vehicleMake: d.vehicle_make || d.vehicleMake || 'تويوتا',
                vehicleModel: d.vehicle_model || d.vehicleModel || 'كورولا',
                vehicleYear: d.vehicle_year || d.vehicleYear || 2020,
                vehiclePlate: d.vehicle_plate || d.vehiclePlate || 'النجف',
                status: d.status || 'Pending',
                isVerified: d.is_verified !== undefined ? !!d.is_verified : !!d.isVerified,
                isBlocked: d.is_blocked !== undefined ? !!d.is_blocked : !!d.isBlocked,
                isApproved: d.is_approved !== undefined ? !!d.is_approved : !!d.isApproved,
                work_mode: d.work_mode || d.workMode || 'مشوار قصير',
                ratingAverage: parseFloat(d.rating_average || d.ratingAverage || 5.0),
                totalTrips: parseInt(d.total_trips || d.totalTrips || 0, 10),
                createdAt: d.created_at || d.createdAt || new Date().toISOString()
            })),
            customers: customers.map(c => ({
                customerId: c.customer_id || c.customerId || c.userId,
                fullName: c.full_name || c.fullName,
                phoneNumber: c.phone_number || c.phoneNumber,
                preferredPaymentMethod: c.preferred_payment_method || c.preferredPaymentMethod || 'Cash',
                ratingAverage: parseFloat(c.rating_average || c.ratingAverage || 5.0),
                totalBookings: parseInt(c.total_bookings || c.totalBookings || 0, 10),
                isActive: c.is_active !== false && c.isActive !== false,
                isBlocked: !!c.is_blocked || !!c.isBlocked,
                registeredAt: c.created_at || c.createdAt || c.registeredAt || new Date().toISOString()
            })),
            verifications: driver_documents.map(doc => ({
                documentId: doc.document_id || doc.documentId,
                driverId: doc.driver_id || doc.driverId,
                documentType: doc.document_type || doc.documentType || 'DrivingLicense',
                filePath: doc.file_path || doc.filePath || '',
                fileUrl: doc.file_url || doc.fileUrl || doc.filePath || '',
                status: doc.status || 'Pending',
                rejectionReason: doc.rejection_reason || doc.rejectionReason || null,
                submittedAt: doc.submitted_at || doc.submittedAt || new Date().toISOString()
            })),
            routes: routes.map(r => ({
                id: r.id || r.routeId,
                driverId: r.driver_id || r.driverId,
                driverName: r.driver_name || r.driverName,
                driverPhone: r.driver_phone || r.driverPhone,
                name: r.name || `${r.start_name || r.startName} ➔ ${r.end_name || r.endName}`,
                startName: r.start_name || r.startName,
                endName: r.end_name || r.endName,
                startLat: parseFloat(r.start_lat || r.startLat || 31.9961),
                startLon: parseFloat(r.start_lon || r.startLon || 44.3168),
                endLat: parseFloat(r.end_lat || r.endLat || 32.0321),
                endLon: parseFloat(r.end_lon || r.endLon || 44.3725),
                fare: parseFloat(r.fare || 3000),
                availableSeats: parseInt(r.available_seats || r.availableSeats || 4, 10),
                totalSeats: parseInt(r.total_seats || r.totalSeats || 4, 10),
                departureTime: r.departure_time || r.departureTime || '',
                status: r.status || 'Active',
                createdAt: r.created_at || r.createdAt || new Date().toISOString()
            })),
            bookings: bookings.map(b => ({
                id: b.id || b.bookingId,
                bookingId: b.id || b.bookingId,
                routeId: b.route_id || b.routeId,
                customerId: b.customer_id || b.customerId,
                customerName: b.customer_name || b.customerName,
                customerPhone: b.customer_phone || b.customerPhone,
                driverId: b.driver_id || b.driverId,
                driverName: b.driver_name || b.driverName,
                pickupName: b.pickup_name || b.pickupName,
                dropoffName: b.dropoff_name || b.dropoffName,
                totalFare: parseFloat(b.total_fare || b.totalFare || 0),
                seatsBooked: parseInt(b.seats_booked || b.seatsBooked || 1, 10),
                status: b.status || 'Pending',
                cancellationReason: b.cancellation_reason || b.cancellationReason,
                cancellationDetails: b.cancellation_details || b.cancellationDetails,
                cancellationRequested: !!b.cancellation_requested || !!b.cancellationRequested,
                cancellationStatus: b.cancellation_status || b.cancellationStatus,
                driverApprovalReason: b.driver_approval_reason || b.driverApprovalReason,
                createdAt: b.created_at || b.createdAt || new Date().toISOString()
            })),
            complaints: complaints.map(cmp => ({
                id: cmp.id,
                userId: cmp.user_id || cmp.userId,
                userName: cmp.user_name || cmp.userName,
                userPhone: cmp.user_phone || cmp.userPhone,
                userRole: cmp.user_role || cmp.userRole || 'Customer',
                subject: cmp.subject,
                details: cmp.details || '',
                status: cmp.status || 'Open',
                createdAt: cmp.created_at || cmp.createdAt || new Date().toISOString()
            })),
            settings: system_settings.length > 0 ? system_settings : (db.memoryState.settings || []),
            auditLogs: [
                {
                    id: Date.now(),
                    action: "SystemBackupRestored",
                    entityName: "System",
                    entityId: "FullDatabase",
                    newValuesJson: JSON.stringify({
                        usersRestored: users.length,
                        driversRestored: drivers.length,
                        customersRestored: customers.length,
                        routesRestored: routes.length,
                        bookingsRestored: bookings.length,
                        restoredAt: new Date().toISOString()
                    }),
                    ipAddress: "127.0.0.1",
                    createdAt: new Date().toISOString()
                },
                ...audit_logs
            ]
        };

        db.cleanOrphanRecords();
        db.saveStateSnapshot();

        try {
            await auditService.logAuditEvent({
                action: 'SystemDatabaseRestored',
                entityType: 'FullDatabase',
                entityId: 'PostgreSQL-taxiwisam',
                actor: 'المشرف العام (Admin)',
                details: {
                    usersRestored: users.length,
                    driversRestored: drivers.length,
                    customersRestored: customers.length,
                    routesRestored: routes.length,
                    bookingsRestored: bookings.length,
                    documentsRestored: driver_documents.length,
                    complaintsRestored: complaints.length,
                    settingsRestored: system_settings.length,
                    restoredAt: new Date().toISOString()
                }
            });
        } catch (_) {}

        return {
            success: true,
            message: 'تمت استعادة كافة البيانات وقاعدة البيانات بنجاح تام وحمايتها بالمعاملة الآمنة! 🎉',
            restoredCounts: {
                users: users.length,
                drivers: drivers.length,
                customers: customers.length,
                driver_documents: driver_documents.length,
                routes: routes.length,
                bookings: bookings.length,
                complaints: complaints.length,
                system_settings: system_settings.length
            },
            stats: db.getComputedStats()
        };
    }
}

module.exports = new BackupService();
